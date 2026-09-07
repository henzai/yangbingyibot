# LLM gateway boundary

This documents stages [#429](https://github.com/henzai/yangbingyibot/issues/429) and [#430](https://github.com/henzai/yangbingyibot/issues/430) of [#428](https://github.com/henzai/yangbingyibot/issues/428). Gemini is the only production adapter currently registered.

`src/llm/types.ts` defines the text-only `ILlmGateway`. It has no SDK, Cloudflare binding, Discord, or KV dependencies. `src/llm/promptBuilder.ts` keeps application instructions, knowledge context, and `user`/`assistant` messages separate. The Gemini adapter owns wire conversion, SDK configuration, and provider-specific instruction placement.

## Streaming and completion

- `text` contains a delta, not the accumulated response.
- `reasoning_summary` is optional and contains only a provider-published summary. Consumers must work without it. `capabilities.reasoningSummary` describes adapter support; it does not promise that every model will return a summary.
- `usage` is a cumulative snapshot for one generation. Replace a previous snapshot instead of adding them. The Gemini adapter emits the last available snapshot once.
- `finish` is emitted once on normal exhaustion, after usage. `stop`, `length`, `blocked`, `error`, and `unknown` are provider-independent. Raw finish/block codes remain available for diagnostic and migration purposes.
- Empty text is not an exception at the adapter boundary: callers use the finish reason to decide what to tell the user. Text with `length` is a partial response, not a successful complete answer. Missing finish metadata is `unknown`, even if text exists.
- Transport failure during consumption throws a non-retryable `interrupted` error and emits no successful finish. Callers must not save a partial transport result as a completed answer or automatically replay it.
- `generateText` returns text, usage, and finish using the same contract. Thought-marked SDK parts are excluded from its answer text.

## Usage semantics

All counters may be `null`: missing is different from zero. Input includes cached input. Output **excludes** reasoning; reasoning is a separate counter. The reported total is retained rather than reconstructed from incomplete counters. Consumers must not sum the total with its component counters, or cached input with input.

Gemini mapping follows the [official UsageMetadata definition](https://ai.google.dev/api/generate-content#UsageMetadata) (checked 2026-09-06): `promptTokenCount` → input, `cachedContentTokenCount` → cached input, `candidatesTokenCount` → output, `thoughtsTokenCount` → reasoning, `totalTokenCount` → total. An adapter whose API includes reasoning inside output must subtract a known reasoning count or leave the exclusive output counter unknown. Do not assume identical billing semantics across providers.

## Errors and request lifetime

Common errors use `ExternalServiceError` with `service: llm`, a provider identifier, a structured kind, status, retryability, and optional Retry-After. Logging uses `getExternalErrorLogContext`, never the SDK body or cause. A caller's arbitrary cancellation reason is not forwarded to logs or user messages.

The application owns retries: at most two attempts for text generation or stream establishment, with bounded jitter and structured Retry-After support. Gemini SDK retries are explicitly disabled (`httpOptions.retryOptions.attempts: 1`, including the initial request). Consumption is never retried, even if it failed before the first text delta. Authentication/configuration HTTP failures are permanent; cancellation, expired budget, and interrupted consumption are also non-retryable.

The default total budget is 90 seconds for streams and 15 seconds for text/summary calls. A caller can request a smaller budget; all requests are capped at 90 seconds. Retries, backoff, and the time a stream consumer spends displaying progress share the same stream budget. The adapter aborts the underlying request and bounds pending SDK promises; it cannot interrupt arbitrary work in the consumer, which observes cancellation when it resumes iteration. Returning early closes the request and releases timers/listeners. API-side generation and billing may continue after client cancellation; cancellation is not a refund guarantee.

## Provider configuration

| Setting | Default / precedence |
| --- | --- |
| `LLM_PROVIDER` | `gemini` |
| `LLM_MODEL` | Explicit value → selected provider's legacy model setting → its default |
| `LLM_SUMMARY_ENABLED` | `true`; accepts only `true` or `false` |
| `LLM_SUMMARY_PROVIDER` | Answer provider when enabled |
| `LLM_SUMMARY_MODEL` | Explicit value → selected provider's legacy summary setting → its summary default |
| `GEMINI_MODEL` | Legacy answer override; default `gemini-3.5-flash-lite` |
| `GEMINI_SUMMARY_MODEL` | Legacy summary override; default `gemini-2.5-flash-lite` |

Values are trimmed. An explicitly blank value, unknown provider, missing selected key, or missing model without a provider default fails with a setting name, without printing credentials. Common model settings take precedence over legacy settings. Non-Gemini providers never inherit Gemini model settings.

Only enabled answer/summary providers require their credentials. Unused keys and unused legacy Gemini model settings are ignored. `GEMINI_API_KEY` is optional in the binding type but required whenever Gemini is selected. `OPENAI_API_KEY` is reserved for the next adapter; setting it does not enable OpenAI in this build. Google Sheets still requires `GOOGLE_SERVICE_ACCOUNT` regardless of LLM choice.

An existing deployment needs no configuration changes. To use common Gemini settings:

```toml
[vars]
LLM_PROVIDER = "gemini"
LLM_MODEL = "gemini-3.5-flash-lite"
LLM_SUMMARY_ENABLED = "true"
LLM_SUMMARY_PROVIDER = "gemini"
LLM_SUMMARY_MODEL = "gemini-2.5-flash-lite"
```

Supply API keys through Worker secrets, never `[vars]`. To disable summary generation, set `LLM_SUMMARY_ENABLED = "false"` and **unset** `LLM_SUMMARY_PROVIDER` and `LLM_SUMMARY_MODEL`; supplying either is a contradictory configuration. Existing `GEMINI_SUMMARY_MODEL` can remain and is ignored when disabled.

`src/llm/providerCatalog.ts` holds SDK-free configuration metadata. `src/llm/factory.ts` constructs only the selected adapter. New providers register in both places; tests inject a fake catalog/factory without enabling another real API. Answer and summary models may differ, and a shared provider reuses its gateway. Configuration is resolved at the start of `run` for generation and metrics; SDK clients and API keys stay outside serialized step results and Workflow payloads.

## Progress, history, and running Workflows

Workflow, StreamCoordinator, and ThinkingSummarizer consume common contracts. When summaries are disabled or the answer adapter lacks `reasoningSummary`, the bot displays generic progress and makes no summary API calls. Explicitly enabled summary settings are still validated even if that answer adapter lacks summary support. A provider supporting summaries may return no summary for a particular model or request; ordinary answer delivery still works. Summary failure uses a generic fallback and does not fail the answer.

Empty answers retain the existing Japanese finish-state messages. Nonempty `length` results are delivered with an output-limit notice; conversation history contains only the answer text. `blocked`/`error` completions and interrupted streams do not become saved answers. Normal history contains only `user`/`assistant` messages, never progress or summary text.

KV reads accept both legacy `model` and common `assistant` roles. Writes deliberately keep `user`/`model` at `chat_history:v2:<conversationKey>` so an older deployment can read them after rollback. Conversation isolation, TTL, the latest 20 entries, and the 64 KiB UTF-8 limit are unchanged. Old Workflow history checkpoints and completed generation usage are normalized on replay.

The `AnswerQuestionWorkflow` export and persisted step IDs, including `streamGeminiAndEditDiscord`, remain unchanged. That generation/delivery step retains zero retries and its 120-second timeout so an already completed step is not regenerated or redelivered. `streamGeminiWithDiscordEditsStep` remains an alias for the common implementation. The legacy gateway and prompt builder under `src/gemini/` remain compatibility facades; Workflow no longer uses them.

## Monitoring compatibility and next stages

The common metrics entry point translates Gemini usage to its existing positional `gemini_api_call` schema; missing counters become zero only at this legacy metrics/facade boundary. Separate summary-call usage aggregation otherwise preserves unknown counters as `null`. A non-Gemini event uses `llm_api_call`, appends provider to blobs, and uses `-1` for missing counters. The health check probes each configured provider once; Gemini behavior is unchanged. An unimplemented provider probe reports failure rather than silently claiming health.

Full monitoring migration and other provider health probes remain [#432](https://github.com/henzai/yangbingyibot/issues/432). [#431](https://github.com/henzai/yangbingyibot/issues/431) will register the second production adapter and its model/key configuration. [#433](https://github.com/henzai/yangbingyibot/issues/433) covers evaluations and operating guidance. None of these later stages is implemented by #430, and the production model is unchanged.

## Verification

Use Node.js 24 and `npm run verify`. Tests mock provider calls: no real LLM calls or charges. They cover legacy/common configuration precedence, selected credentials, fake-provider routing, same/separate/disabled/unsupported summary configurations, fallback, nullable usage, finish handling, mixed KV roles, and replay of completed generation checkpoints without redelivery. Existing SDK adapter, Discord PING/defer, delivery throttling, and conversation-isolation regressions remain in the suite.
