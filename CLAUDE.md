# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest
npm run register     # Register Discord slash commands via Discord API
npm run check        # Run Biome formatter + linter with auto-fix
npm run check:ci     # Run Biome check without writing (for CI)
npm run typecheck    # Run TypeScript type checking without emitting files
npm run cf-typegen   # Regenerate Cloudflare binding types (worker-configuration.d.ts)
npm run verify       # Run all non-writing checks, tests, and a deploy dry-run
```

## Architecture

Discord bot on Cloudflare Workers. Uses Google Gemini AI with a Google Sheets knowledge base, Cloudflare KV for caches and conversation history, Analytics Engine for metrics, and a Cloudflare Workflow for answer generation. Cron health check (every 5 min) reports failures as GitHub Issues.

Tests run under `@cloudflare/vitest-pool-workers` against `wrangler.toml`, so they execute in the real Workers runtime.

### Request flow

1. Discord POSTs to `/`; the `verifyDiscordInteraction` middleware verifies the Ed25519 signature.
2. `InteractionType.PING` returns PONG. `APPLICATION_COMMAND` calls `loadConfig` to fail fast at the request boundary, parses the `/ask` command, creates an `ANSWER_QUESTION_WORKFLOW` instance, and immediately returns `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` — Discord requires a response within 3 seconds, so the real work runs in the Workflow.
3. `AnswerQuestionWorkflow` (`src/workflows/answerQuestionWorkflow.ts`) runs asynchronously:
   - `getSheetData` — read the KV sheet cache, falling back to Google Sheets and writing the cache back (best effort).
   - `getHistory` — load conversation history from KV.
   - `streamGeminiAndEditDiscord` — stream the Gemini response while progressively PATCHing the Discord message. Configured with `retries.limit: 0` and a 120 second timeout, because retrying would re-send partial output.
   - `saveHistory` — write the updated history back to KV.
   - On failure: log, record metrics, report to GitHub Issues (called *outside* `step.do` so the Workflow does not retry the report), then send an error message via `sendErrorResponse`.
4. Metrics for each stage are written to Analytics Engine; when the `METRICS` binding is absent, `NoOpMetricsClient` is used.

`AnswerQuestionWorkflow` is re-exported from `src/index.ts` so Cloudflare can discover the Workflow class. Do not remove that re-export.

### Caching

All caches live in the single KV namespace bound as `sushanshan_bot`:

- `sheet_info:v2:<sha256(spreadsheet id + sheet names)>` — sheet data and description, TTL 5 minutes. Keying by source fingerprint means changing `GOOGLE_SPREADSHEET_ID` or the sheet names automatically misses the old cache (`src/repositories/sheetCache.ts`).
- `chat_history:v2:<conversationKey>` — conversation history, where `conversationKey` is `sha256(guildId|"dm":channelId:userId)`. Capped at the last 20 entries and 64 KB, TTL `HISTORY_TTL_SECONDS` (`src/repositories/conversationHistory.ts`).
- `error_reported:<fingerprint>` — marker preventing duplicate GitHub Issues, TTL 1 hour. This is layer 1 of deduplication; layer 2 is a GitHub Issues search (`src/repositories/deduplicationStore.ts`).

Cache and history reads degrade gracefully: KV failures are logged and treated as a miss rather than failing the request.

### External service errors and retries

Unified across all clients (`src/utils/errors.ts`, `src/utils/retry.ts`):

- Wrap external failures in `ExternalServiceError` via `normalizeExternalServiceError` or `externalServiceErrorFromResponse`. It carries `service` (`discord` | `gemini` | `sheets` | `github`), `operation`, `status`, `retryable`, `userMessage` (Japanese, shown to the user), and `retryAfterMs` parsed from the `Retry-After` header.
- `withRetry` retries only retryable `ExternalServiceError`s by default. It uses jittered exponential backoff, honors `retryAfterMs` when present, and accepts injectable `sleep`/`random` so tests do not wait on real timers.
- `isRetryableStatus` treats 408, 429, 5xx, and unknown status as retryable.
- Log failures with `getExternalErrorLogContext`, and derive user-facing text with `getUserMessage`.

## Project Structure

```
src/
  index.ts                    # Hono app, Discord interaction endpoint, cron entrypoint, Workflow re-export
  config.ts                   # Bindings → AppConfig loading, validation, production defaults
  contracts.ts                # Dependency-free shared types, including the Bindings type
  health.ts                   # Cron health check (KV, Gemini, Google service account)
  clients/                    # External service clients: discord, gemini, github, spreadSheet, metrics
  discord/interaction.ts      # Interaction parsing, /ask validation, conversation key derivation
  middleware/                 # verifyDiscordInteraction (Ed25519 signature verification)
  repositories/               # KV access by purpose: sheetCache, conversationHistory, deduplicationStore
  responses/errorResponse.ts  # Discord error message payload
  utils/                      # errors, retry, logger, requestId, compactSheet
  workflows/                  # AnswerQuestionWorkflow and its step output types
scripts/
  commands.js                 # Slash command definitions shared by runtime and registration
  register.js                 # Registers slash commands with the Discord API
```

Tests are colocated as `*.test.ts` next to the file under test.

## Environment Variables

Required in Cloudflare Workers secrets or `.dev.vars` for local development:

- `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` - Discord credentials
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_SERVICE_ACCOUNT` - Google Service Account credentials (JSON string)
- `GITHUB_TOKEN` (optional) - GitHub PAT for auto-reporting errors and health check failures as Issues

Optional runtime configuration (current production values are used when omitted):

- `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL` - Answer and thinking-summary models
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DATA_SHEET_NAME`, `GOOGLE_DESCRIPTION_SHEET_NAME` - Google Sheets source
- `GITHUB_REPOSITORY` - Error-report destination in `owner/repository` format
- `HISTORY_TTL_SECONDS` - Conversation history TTL (60–86400 seconds, default: 300)

## Cloudflare Bindings

Defined in `wrangler.toml` and typed in `Bindings` (`src/contracts.ts`):

- `sushanshan_bot` - KV namespace for the sheet cache, conversation history, and Issue deduplication
- `ANSWER_QUESTION_WORKFLOW` - Workflow binding for `AnswerQuestionWorkflow`
- `METRICS` (optional) - Analytics Engine dataset `yangbingyibot_metrics`
- Cron trigger `*/5 * * * *` drives the health check

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
