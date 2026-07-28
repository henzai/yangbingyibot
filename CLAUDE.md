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
npm run verify       # Run all non-writing checks, tests, and a deploy dry-run
npm run test:watch   # Run tests in watch mode
npm run cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.toml
```

## Architecture

Discord bot on Cloudflare Workers. Uses Google Gemini AI with a Google Sheets knowledge base. Cron health check (every 5 min) checks KV / Gemini API / Google service account and reports failures as GitHub Issues.

Request flow:

1. Discord POSTs an interaction to `/`; `verifyDiscordInteraction` middleware verifies the Ed25519 signature.
2. `PING` gets a `PONG`; `/ask` returns `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` immediately (Discord requires a response within 3 s).
3. The actual work runs in the `AnswerQuestionWorkflow` Cloudflare Workflow: sheet data → conversation history → Gemini streaming (Discord message PATCHed progressively) → save history.

KV access goes through the purpose-specific repositories in `src/repositories/`, never through the raw binding:

- Conversation history (`chat_history:v2:<sha256>`) is keyed per guild+channel+user and expires after `HISTORY_TTL_SECONDS` (default 300). Capped at 20 entries / 64 KiB per key.
- Sheet cache (`sheet_info:v2:<sha256>`) is keyed by a hash of the spreadsheet ID and sheet names, with a fixed 5-minute TTL (not affected by `HISTORY_TTL_SECONDS`).
- GitHub Issue deduplication (`error_reported:<fingerprint>`) uses a 1-hour TTL, backed up by a GitHub search as a second layer.

## Project Structure

- `src/index.ts` - Hono app entry point, cron `scheduled` handler, and re-export of `AnswerQuestionWorkflow` so Cloudflare can discover the Workflow class
- `src/workflows/` - `AnswerQuestionWorkflow` (the answer pipeline) and its shared types
- `src/repositories/` - purpose-specific KV access: `conversationHistory`, `sheetCache`, `deduplicationStore`
- `src/clients/` - external service clients: `discord`, `gemini`, `spreadSheet`, `github`, `metrics`
- `src/discord/` - interaction parsing and conversation-key derivation
- `src/middleware/` - Discord request signature verification
- `src/responses/` - Discord error response construction
- `src/utils/` - logger, retry, request ID, error helpers, sheet compaction
- `src/config.ts` - env var loading, validation, and production defaults
- `src/contracts.ts` - `Bindings`, `WorkflowParams`, and other shared types (dependency-free by design)
- `src/health.ts` - health check invoked by the cron trigger
- `scripts/` - `register.js` / `commands.js` for Discord slash command registration

Tests live next to their targets as `*.test.ts` and run on `@cloudflare/vitest-pool-workers`.

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
- `HISTORY_TTL_SECONDS` - Conversation history TTL (60–86400 seconds, default: 300). Applies to conversation history only

Cloudflare bindings declared in `wrangler.toml` (typed in `Bindings` in `src/contracts.ts`):

- `sushanshan_bot` - KV namespace for conversation history, sheet cache, and Issue deduplication
- `ANSWER_QUESTION_WORKFLOW` - Workflow binding for `AnswerQuestionWorkflow`
- `METRICS` - Analytics Engine dataset (`yangbingyibot_metrics`); optional, metrics are skipped when unbound

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
