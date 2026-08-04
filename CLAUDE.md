# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest
npm run test:watch   # Run Vitest in watch mode
npm run register     # Register Discord slash commands via Discord API
npm run lint         # Run Biome linter only
npm run format       # Run Biome formatter with auto-fix
npm run check        # Run Biome formatter + linter with auto-fix
npm run check:ci     # Run Biome check without writing (for CI)
npm run typecheck    # Run TypeScript type checking without emitting files
npm run cf-typegen   # Regenerate Cloudflare binding types (worker-configuration.d.ts)
npm run verify       # Run all non-writing checks, tests, and a deploy dry-run
```

## Architecture

Discord bot on Cloudflare Workers. Uses Google Gemini AI with a Google Sheets knowledge base, Cloudflare KV for caches and conversation history, and Analytics Engine for metrics.

### Request flow

1. Discord POSTs an interaction to `/`. `verifyDiscordInteraction` middleware checks the Ed25519 signature.
2. `src/index.ts` (Hono) handles the interaction: `PING` → `PONG`; `APPLICATION_COMMAND` → validate config, parse the `/ask` command, start `ANSWER_QUESTION_WORKFLOW`, and immediately return a deferred response (Discord's 3-second limit).
3. `AnswerQuestionWorkflow` (`src/workflows/answerQuestionWorkflow.ts`) runs the answer asynchronously as `step.do()` steps:
   - `getSheetData` - KV cache, falling back to the Google Sheets API
   - `getHistory` - conversation history from KV
   - `streamGeminiAndEditDiscord` - stream the Gemini answer while progressively editing the Discord message (`retries.limit: 0`, `timeout: 120 seconds`)
   - `saveHistory` - persist the updated history to KV
4. `StreamCoordinator` throttles Discord edits (response: 1500 ms / 50 chars, thinking: 1000 ms / 200 chars). During the thinking phase, `ThinkingSummarizer` condenses thoughts into a one-line Japanese summary using the cheaper `GEMINI_SUMMARY_MODEL`; each call passes only the newly streamed thinking text plus the previous summary, so cost stays flat as thoughts grow.
5. On failure, the workflow posts a user-facing error to Discord and files a GitHub Issue (deduplicated by an error fingerprint via KV, then a GitHub Issues search).

Every stage records Analytics Engine metrics (Gemini calls tagged with model, `purpose` of `answer` or `thinking_summary`, and call count; KV cache hits; Sheets API calls; Discord webhook delivery; workflow completion). Metrics degrade to a no-op when the `METRICS` binding is absent.

### Caching strategy (KV namespace `sushanshan_bot`)

- `sheet_info:v2:<sha256 of spreadsheet config>` - sheet data, 5-minute TTL. The key is derived from the spreadsheet ID and sheet names, so config changes invalidate it automatically. Cache writes are best-effort.
- `chat_history:v2:<conversationKey>` - conversation history, `HISTORY_TTL_SECONDS` TTL, capped at 20 entries and 64 KB (oldest entries dropped first).
- `error_reported:<fingerprint>` - GitHub Issue deduplication marker, 1-hour TTL.

### Scheduled health check

Cron (every 5 min, `wrangler.toml` `[triggers]`) runs `src/health.ts`, which probes KV, the Gemini API, and the Google service account, and reports failures as GitHub Issues using the same deduplication.

## Project Structure

```
src/
  index.ts                  # Hono worker entry: Discord interactions, cron, Workflow re-export
  config.ts                 # Bindings → AppConfig, defaults, validation (ConfigError)
  contracts.ts              # Dependency-free shared types (Bindings, WorkflowParams, HistoryEntry)
  health.ts                 # Scheduled health check (KV / Gemini / Google SA)
  clients/                  # External services: discord, github, metrics, spreadSheet
  discord/                  # Interaction parsing, message formatting, chunked delivery
  gemini/                   # gateway, promptBuilder, streamCoordinator, thinkingSummarizer, types
  middleware/               # verifyDiscordInteraction (Ed25519 signature verification)
  repositories/             # KV-backed: sheetCache, conversationHistory, deduplicationStore
  responses/                # errorResponse
  utils/                    # compactSheet, errors, logger, requestId, retry
  workflows/                # answerQuestionWorkflow, types
scripts/                    # register.js, commands.js (Discord slash command registration)
wrangler.toml               # Worker config: KV, Analytics Engine, Workflow, cron triggers
worker-configuration.d.ts   # Generated Cloudflare types (npm run cf-typegen)
```

Tests live next to their sources as `*.test.ts` and run on `@cloudflare/vitest-pool-workers`.

## Environment Variables

Required in Cloudflare Workers secrets or `.dev.vars` for local development:

- `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` - Discord credentials
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_SERVICE_ACCOUNT` - Google Service Account credentials (JSON string)
- `GITHUB_TOKEN` (optional) - GitHub PAT for auto-reporting errors and health check failures as Issues

Optional runtime configuration (defaults in `DEFAULT_RUNTIME_CONFIG` in `src/config.ts` are used when omitted):

- `GEMINI_MODEL` - Answer model (default: `gemini-3.5-flash-lite`)
- `GEMINI_SUMMARY_MODEL` - Thinking-summary model (default: `gemini-2.5-flash-lite`)
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DATA_SHEET_NAME`, `GOOGLE_DESCRIPTION_SHEET_NAME` - Google Sheets source
- `GITHUB_REPOSITORY` - Error-report destination in `owner/repository` format (default: `henzai/yangbingyibot`)
- `HISTORY_TTL_SECONDS` - Conversation history TTL (60–86400 seconds, default: 300)

## Cloudflare Bindings

Declared in `wrangler.toml` and typed in `Bindings` (`src/contracts.ts`):

- `sushanshan_bot` (KV namespace) - sheet cache, conversation history, deduplication markers
- `ANSWER_QUESTION_WORKFLOW` (Workflow, class `AnswerQuestionWorkflow`) - asynchronous answer pipeline
- `METRICS` (Analytics Engine dataset `yangbingyibot_metrics`, optional) - falls back to `NoOpMetricsClient` when unbound

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
