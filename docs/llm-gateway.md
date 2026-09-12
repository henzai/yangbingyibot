# LLM gateway boundary

This documents stages [#429](https://github.com/henzai/yangbingyibot/issues/429), [#430](https://github.com/henzai/yangbingyibot/issues/430), and [#431](https://github.com/henzai/yangbingyibot/issues/431) of [#428](https://github.com/henzai/yangbingyibot/issues/428). Gemini and OpenAI are registered production adapters. The production deployment still defaults to Gemini; registering OpenAI does not switch it.

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

OpenAI mapping follows the [official Responses API schema](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) (checked 2026-09-08): `input_tokens` → input, `input_tokens_details.cached_tokens` → cached input, `output_tokens_details.reasoning_tokens` → reasoning, and `total_tokens` → total. OpenAI `output_tokens` includes reasoning, so the adapter subtracts a known reasoning count. If either value is absent, common output is `null` rather than a misleading inclusive count.

## Errors and request lifetime

Common errors use `ExternalServiceError` with `service: llm`, a provider identifier, a structured kind, status, retryability, and optional Retry-After. Logging uses `getExternalErrorLogContext`, never the SDK body or cause. A caller's arbitrary cancellation reason is not forwarded to logs or user messages.

The application owns retries: at most two attempts for text generation or stream establishment, with bounded jitter and structured Retry-After support. Gemini SDK retries are explicitly disabled (`httpOptions.retryOptions.attempts: 1`, including the initial request). Consumption is never retried, even if it failed before the first text delta. Authentication/configuration HTTP failures are permanent; cancellation, expired budget, and interrupted consumption are also non-retryable.

The OpenAI SDK is also configured with `maxRetries: 0`; the same application retry and deadline policy applies. HTTP 401/403, 429, and 5xx errors are normalized through the common error path. An in-band Responses stream error or transport failure after stream establishment becomes a non-retryable interruption. A normal `response.failed` terminal event becomes an `error` finish.

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

Only enabled answer/summary providers require their credentials. Unused keys and unused legacy Gemini model settings are ignored. `GEMINI_API_KEY` is optional in the binding type but required whenever Gemini is selected. `OPENAI_API_KEY` is required whenever OpenAI is selected. Google Sheets still requires `GOOGLE_SERVICE_ACCOUNT` regardless of LLM choice.

OpenAI deliberately has no default answer or summary model. Model evaluation and production selection belong to [#433](https://github.com/henzai/yangbingyibot/issues/433), so an OpenAI selection must set `LLM_MODEL` and, when OpenAI is selected for summaries, `LLM_SUMMARY_MODEL`. Model IDs are API identifiers, not Codex display names. Before enabling production, use the authenticated [Models API](https://developers.openai.com/api/reference/ruby/resources/models) to verify that the target account can access the chosen ID. This implementation session had no `OPENAI_API_KEY` in its process environment, so account-specific availability was not tested and no real API request or charge was made.

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

An OpenAI answer with summaries disabled is configured as follows; replace the example with an account-verified API model ID before deployment:

```toml
[vars]
LLM_PROVIDER = "openai"
LLM_MODEL = "account-verified-model-id"
LLM_SUMMARY_ENABLED = "false"
```

Set `OPENAI_API_KEY` as a Worker secret and leave `GEMINI_API_KEY` unset when Gemini is otherwise unused.

`src/llm/providerCatalog.ts` holds SDK-free configuration metadata. `src/llm/factory.ts` constructs only the selected adapter. New providers register in both places; tests inject a fake catalog/factory without enabling another real API. Answer and summary models may differ, and a shared provider reuses its gateway. Configuration is resolved at the start of `run` for generation and metrics; SDK clients and API keys stay outside serialized step results and Workflow payloads.

To add a third provider, keep the boundary explicit:

1. Add its provider/key/default metadata to `providerCatalog.ts` and resolve only
   selected credentials in `config.ts`.
2. Implement `ILlmGateway` in a provider adapter, including common finish and
   nullable-usage semantics, bounded lifetime/retries, safe error normalization,
   and a non-generating exact-model probe when the API supports one.
3. Register lazy construction in `factory.ts`; do not place SDK types in the
   shared contract or Workflow payload.
4. Run the shared Gateway contract tests plus adapter tests for prompt mapping,
   streaming, usage, refusal/block, failure, cancellation, and retry behavior.
5. Extend health/metrics dimensions, configuration documentation, and the fixed
   evaluation candidate/price catalog in a separately reviewed change.

## OpenAI Responses adapter

The adapter uses the official JavaScript SDK `openai@7.10.0` and the Responses API. The installed SDK declares Node.js 22/24 and Cloudflare Workers support; this repository verifies the actual Worker bundle with Node.js 24 and Wrangler dry-run. The 2026-09-08 dry-run produced a 909.87 KiB upload (220.05 KiB gzip), below the Worker bundle limit enforced by Wrangler.

- `instructions` carries the common system instruction. Knowledge is a separate `developer` input followed by the complete KV-derived `user`/`assistant` history and current question.
- Every request sets `store: false`, sends no `conversation` or `previous_response_id`, and treats KV as the only conversation source. OpenAI organization/project retention controls remain an independent operator setting; `store: false` must not be described as Zero Data Retention. The configured policy can be checked with the [data-retention API](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/data_retention/methods/retrieve).
- Every request sets `truncation: disabled`. A context overflow therefore fails explicitly instead of silently dropping knowledge or earlier history.
- Streaming maps `response.output_text.delta`, public `response.reasoning_summary_text.delta`, refusal, completed, incomplete, failed, usage, and in-band errors. Refusal text and provider error bodies are not exposed.
- Reasoning summaries are requested only for recognized reasoning model families. `temperature` is sent only for the conservative non-reasoning allowlist. Unknown future model IDs receive neither optional field until their support is verified; `max_output_tokens` remains part of the general Responses request schema.
- The API client can be replaced at the adapter constructor boundary, and all tests use fixtures rather than API credentials. Shared contract tests run the same text, usage, finish, missing-usage, refusal, and limit semantics against Gemini and OpenAI.

Official API references checked on 2026-09-08 confirm that current models expose API model IDs and Responses support in the [model catalog](https://developers.openai.com/api/docs/models), while account availability must be obtained from `GET /models`. The adapter does not hard-code a model from that public catalog.

## Progress, history, and running Workflows

Workflow, StreamCoordinator, and ThinkingSummarizer consume common contracts. When summaries are disabled or the answer adapter lacks `reasoningSummary`, the bot displays generic progress and makes no summary API calls. Explicitly enabled summary settings are still validated even if that answer adapter lacks summary support. A provider supporting summaries may return no summary for a particular model or request; ordinary answer delivery still works. Summary failure uses a generic fallback and does not fail the answer.

Empty answers retain the existing Japanese finish-state messages. Nonempty `length` results are delivered with an output-limit notice; conversation history contains only the answer text. `blocked`/`error` completions and interrupted streams do not become saved answers. Normal history contains only `user`/`assistant` messages, never progress or summary text.

KV reads accept both legacy `model` and common `assistant` roles. Writes deliberately keep `user`/`model` at `chat_history:v2:<conversationKey>` so an older deployment can read them after rollback. Conversation isolation, TTL, the latest 20 entries, and the 64 KiB UTF-8 limit are unchanged. Old Workflow history checkpoints and completed generation usage are normalized on replay.

The `AnswerQuestionWorkflow` export and persisted step IDs, including `streamGeminiAndEditDiscord`, remain unchanged. That generation/delivery step retains zero retries and its 120-second timeout so an already completed step is not regenerated or redelivered. `streamGeminiWithDiscordEditsStep` remains an alias for the common implementation. The legacy gateway and prompt builder under `src/gemini/` remain compatibility facades; Workflow no longer uses them.

## Monitoring compatibility and next stages

Selected provider/model targets now expose non-generating health probes, and
answer/summary usage is recorded in the versioned common metrics schema. See
[`docs/llm-observability.md`](llm-observability.md) for probe guarantees,
ordered Analytics Engine fields, missing-value rules, fingerprint migration,
and legacy Gemini dual-write guidance.

[#433](https://github.com/henzai/yangbingyibot/issues/433) covers real API
evaluation, account-verified model selection, cost/quality comparison, and the
production switch decision. Metadata health does not replace that explicit
generation test. The production provider and model remain unchanged.
The pre-registered offline runner, privacy rules, scoring gates, and regression
matrix are documented in [`docs/llm-evaluation.md`](llm-evaluation.md).

## Verification

Use Node.js 24 and `npm run verify`. Tests mock provider calls: no real LLM calls or charges. They cover the shared Gemini/OpenAI Gateway contract, OpenAI prompt/stream/error conversion, model-specific optional parameters, legacy/common configuration precedence, selected credentials, OpenAI-without-Gemini routing, same/separate/disabled/unsupported summary configurations, fallback, nullable usage, finish handling, mixed KV roles, and replay of completed generation checkpoints without redelivery. Existing SDK adapter, Discord PING/defer, delivery throttling, and conversation-isolation regressions remain in the suite.
