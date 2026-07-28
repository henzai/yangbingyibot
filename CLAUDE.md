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
npm run cf-typegen   # Regenerate Cloudflare binding types (wrangler types)
npm run verify       # Run all non-writing checks, tests, and a deploy dry-run
```

## Architecture

Discord bot on Cloudflare Workers. Uses Google Gemini AI with a Google Sheets knowledge base. Cron health check (every 5 min) reports failures as GitHub Issues.

### Request flow

1. Discord POSTs an interaction to `/`; the `verifyDiscordInteraction` middleware validates the Ed25519 signature.
2. `PING` returns `PONG`. `APPLICATION_COMMAND` validates config (fail fast), parses the `/ask` command, creates an `ANSWER_QUESTION_WORKFLOW` instance, and returns `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` immediately — Discord requires a response within 3 seconds, so all real work happens in the Workflow.
3. `AnswerQuestionWorkflow` runs asynchronously as Workflow steps:
   - `getSheetData` — KV cache first, Google Sheets on miss (cache write is best effort)
   - `getHistory` — conversation history from KV (skipped when the conversation key is missing)
   - `streamGeminiAndEditDiscord` — streams Gemini output while progressively editing the Discord message (`retries.limit: 0`, 120s timeout)
   - `saveHistory` — writes the updated history back to KV (non-fatal on failure)
4. On failure the Workflow sends a Discord error message and reports to GitHub Issues. The report runs **outside** `step.do()` so a Workflow retry cannot duplicate it.
5. The `scheduled` handler runs `runHealthCheck` (KV / Gemini API / Google service account) via `ctx.waitUntil`.

### Gemini layering (`src/gemini/`)

- `gateway.ts` — the only module that talks to `@google/genai`. Owns generation config, retry, error normalization (429/401/403 → user-facing messages), usage extraction, and emits `thinking` / `response` / `usage` stream events.
- `streamCoordinator.ts` — pure state machine that decides *when* to push a preview edit (thinking: 1000ms / 200 chars, response: 1500ms / 50 chars). The first thinking event and the thinking→response transition bypass throttling. Performs no I/O.
- `thinkingSummarizer.ts` — summarizes thinking text with `GEMINI_SUMMARY_MODEL`; falls back to `考え中...` and never throws.
- `promptBuilder.ts` / `types.ts` — prompt assembly and the shared gateway contracts.

### Caching strategy

All caches share the single KV namespace `sushanshan_bot`:

- Sheet cache — key `sheet_info:v2:<sha256(spreadsheet id + sheet names)>`, TTL 5 min. The fingerprint means changing `GOOGLE_SPREADSHEET_ID` / sheet names automatically uses a separate cache entry.
- Conversation history — key `chat_history:v2:<sha256(guildId|"dm":channelId:userId)>`, TTL `HISTORY_TTL_SECONDS`, trimmed to the last 20 entries and 64KB.
- Error/health-check report dedup — key `error_reported:<fingerprint>`, TTL 1 hour, backed by a second layer that searches existing GitHub Issues.

Metrics are written to the optional `METRICS` Analytics Engine dataset; a no-op client is used when the binding is absent.

## Project Structure

```
src/
  index.ts        # Hono entry point, interaction routing, scheduled handler; re-exports AnswerQuestionWorkflow
  config.ts       # Env parsing/validation + production defaults (DEFAULT_RUNTIME_CONFIG)
  contracts.ts    # Bindings and shared payload types (deliberately dependency-free)
  health.ts       # Cron health check (KV / Gemini / Google service account)
  clients/        # External I/O: discord.ts, spreadSheet.ts, github.ts, metrics.ts
  discord/        # interaction.ts (payload parsing + conversation key), delivery.ts (edit/followup, chunking, retry), formatter.ts
  gemini/         # gateway.ts, streamCoordinator.ts, thinkingSummarizer.ts, promptBuilder.ts, types.ts
  middleware/     # verifyDiscordInteraction.ts (Ed25519 signature verification)
  repositories/   # KV access: conversationHistory.ts, sheetCache.ts, deduplicationStore.ts
  responses/      # errorResponse.ts
  utils/          # errors.ts, logger.ts, retry.ts, requestId.ts, compactSheet.ts
  workflows/      # answerQuestionWorkflow.ts (steps + Workflow class), types.ts
scripts/          # register.js (slash command registration), commands.js (shared command definitions)
```

Tests live beside the code they cover as `*.test.ts`, run by Vitest with `@cloudflare/vitest-pool-workers` (`vitest.config.mts`).

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

Cloudflare bindings (declared in `wrangler.toml`, not secrets):

- `sushanshan_bot` - KV namespace used for the sheet cache, conversation history, and report deduplication
- `ANSWER_QUESTION_WORKFLOW` - Workflow binding for the `AnswerQuestionWorkflow` class
- `METRICS` (optional) - Analytics Engine dataset `yangbingyibot_metrics`; falls back to a no-op metrics client when unbound
- `[triggers] crons = ["*/5 * * * *"]` - drives the `scheduled` health check

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
