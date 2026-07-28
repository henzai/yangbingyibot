# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest
npm run test:watch   # Run tests in watch mode
npm run register     # Register Discord slash commands via Discord API
npm run check        # Run Biome formatter + linter with auto-fix
npm run check:ci     # Run Biome check without writing (for CI)
npm run lint         # Run Biome linter only
npm run format       # Run Biome formatter with auto-fix
npm run typecheck    # Run TypeScript type checking without emitting files
npm run cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.toml
npm run verify       # Run all non-writing checks, tests, and a deploy dry-run
```

## Architecture

Discord bot on Cloudflare Workers. Uses Google Gemini AI with a Google Sheets knowledge base. Cron health check (every 5 min) reports failures as GitHub Issues.

### Request Flow

1. `POST /` — `verifyDiscordInteraction` middleware validates the Ed25519 signature before the body is parsed.
2. `getInteractionType()` (`src/discord/interaction.ts`) reads `type` from the untrusted JSON body.
   - `PING` → `PONG`.
   - `APPLICATION_COMMAND` → `loadConfig(c.env)` fails fast, then `parseDiscordAskCommand()` validates the payload and returns `{ token, question, conversationKey }`.
3. `ANSWER_QUESTION_WORKFLOW.create()` is invoked and the handler immediately returns `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` (Discord requires a response within 3 seconds).
4. `AnswerQuestionWorkflow` (`src/workflows/answerQuestionWorkflow.ts`) runs asynchronously: `getSheetData` → `getHistory` → `streamGeminiAndEditDiscord` (streams Gemini output while throttling Discord PATCH edits) → `saveHistory`. On failure it reports to GitHub Issues and posts an error message via `sendErrorResponse`.
5. `scheduled` (cron, every 5 min) runs `runHealthCheck()` against KV, the Gemini API, and the Google service account.

`parseDiscordAskCommand()` accepts only the `ask` command with a string `question` option of 1–6000 characters, and derives `conversationKey` as the SHA-256 hex digest of `<guild_id|"dm">:<channel_id>:<user_id>`. The user id is read from `member.user.id` in guilds and from `user.id` in DMs.

### Caching Strategy

All caching uses the `sushanshan_bot` KV namespace (`src/clients/kv.ts`):

- `sheet_info` — Google Sheets data, fixed 5-minute TTL (`SHEET_CACHE_TTL_SECONDS`). A miss refetches from Sheets; writing the cache back is best-effort and non-fatal.
- `chat_history` — conversation history, TTL from `HISTORY_TTL_SECONDS` (default 300).
- `error_reported:<fingerprint>` — error-report deduplication, 1-hour TTL, backed by a second GitHub Issues search layer.

Note: `conversationKey` is currently threaded through `WorkflowParams` but not yet used as a KV key — conversation history is still stored under the single global `chat_history` key and is therefore shared across channels and users.

## Project Structure

```
src/
  index.ts             # Hono app, Discord interaction routing, cron `scheduled` handler
  config.ts            # loadConfig() — validates bindings, applies DEFAULT_RUNTIME_CONFIG
  contracts.ts         # Bindings, WorkflowParams, HistoryEntry, ParsedDiscordAskCommand
  health.ts            # Cron health check (KV / Gemini / Google service account)
  discord/
    interaction.ts     # Type-safe parsing of untrusted Discord interaction payloads
  middleware/
    verifyDiscordInteraction.ts  # Ed25519 signature verification
  responses/
    errorResponse.ts   # Discord-facing error payload
  clients/
    discord.ts         # Discord webhook client (edit / post original message)
    gemini.ts          # Gemini streaming client
    spreadSheet.ts     # Google Sheets reader
    kv.ts              # KV cache + conversation history
    github.ts          # GitHub Issues reporting with fingerprint dedup
    metrics.ts         # Analytics Engine client (NoOp when METRICS is unbound)
  utils/               # compactSheet, errors, logger, requestId, retry
  workflows/
    answerQuestionWorkflow.ts  # AnswerQuestionWorkflow entrypoint and steps
    types.ts           # Step output types
scripts/
  commands.js          # Shared slash command definition (`ask`)
  register.js          # Registers commands via the Discord API
```

Tests live next to their sources as `*.test.ts` and run on `@cloudflare/vitest-pool-workers`.

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

Declared in `wrangler.toml` and typed in `Bindings` (`src/contracts.ts`):

- `sushanshan_bot` - KV namespace for the sheet cache, conversation history, and error-report dedup
- `ANSWER_QUESTION_WORKFLOW` - Workflow binding for `AnswerQuestionWorkflow`
- `METRICS` (optional) - Analytics Engine dataset `yangbingyibot_metrics`; falls back to `NoOpMetricsClient` when unbound
- `[triggers] crons = ["*/5 * * * *"]` - drives the health check `scheduled` handler

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。

⚠️ `scripts/commands.js` の `max_length` (6000) と `src/discord/interaction.ts` の `MAX_QUESTION_LENGTH` は同じ値を保つこと。片方だけ変更すると Discord 側で通る入力を Worker 側が拒否する。コマンド定義を変更した場合は `npm run register` の再実行が必要。
