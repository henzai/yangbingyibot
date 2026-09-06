# LLM gateway boundary

This is the first stage of [#428](https://github.com/henzai/yangbingyibot/issues/428), implementing [#429](https://github.com/henzai/yangbingyibot/issues/429).

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

## Compatibility and next stages

The existing `src/gemini/gateway.ts` and prompt builder are temporary facades over this boundary. They preserve the current Workflow/coordinator event shape, raw finish reasons, and metrics layout. The old usage mapping still converts missing fields to zero **only at that compatibility boundary**, pending the metrics migration. Workflow names, KV format, model defaults, and environment variables are unchanged. Existing empty-answer and Discord formatting tests remain in place.

The intentional behavior changes in this stage are bounded request time, one owner for retries, non-retryable interrupted streams, and excluding summary/thought parts from ordinary answer text. The Workflow already disables retries for its generation/delivery step.

[#430](https://github.com/henzai/yangbingyibot/issues/430) will move configuration, Workflow/coordinator, and history consumers to the common contracts. [#431](https://github.com/henzai/yangbingyibot/issues/431) will add the second adapter. Provider selection and provider-aware monitoring are not enabled by this stage.

## Verification

Use Node.js 24 and `npm run verify`. Adapter tests mock the SDK: there are no real LLM calls or charges. They cover prompt translation, summary absence, nullable/cumulative usage, completion reasons, permanent/transient failures, Retry-After, interrupted streams, cancellation, deadlines, and cleanup. Existing Workflow tests exercise the facade, Discord delivery, PING/defer, history, and formatting regressions.
