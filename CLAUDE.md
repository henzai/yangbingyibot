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
npm run lint         # Run Biome linter only
npm run format       # Run Biome formatter with auto-fix
npm run cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.toml
```

## Architecture

Discord bot on Cloudflare Workers (Hono). Uses Google Gemini AI with a Google Sheets knowledge base. Cron health check (every 5 min) reports failures as GitHub Issues.

### Request Flow

1. Discord posts an interaction to `POST /`; the `verifyDiscordInteraction` middleware verifies the Ed25519 signature.
2. `InteractionType.PING` is answered with `PONG` immediately. `APPLICATION_COMMAND` calls `loadConfig(c.env)` to fail fast on misconfiguration, validates the payload, creates an `ANSWER_QUESTION_WORKFLOW` instance, and returns `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`.
3. `AnswerQuestionWorkflow` runs the steps `getSheetData` → `getHistory` → `streamGeminiAndEditDiscord` (2 retries, 120s timeout) → `saveHistory`.
4. The streaming step progressively edits the original Discord message. Edits are throttled per phase (thinking: 1000ms / 200 chars, response: 1500ms / 50 chars), and thinking text is summarized with `GEMINI_SUMMARY_MODEL`.
5. On failure the workflow records metrics, reports to GitHub Issues (non-fatal, outside `step.do`), and posts an error message via `sendErrorResponse` (up to 3 attempts, exponential backoff).

The cron trigger (`*/5 * * * *`) invokes `scheduled`, which runs `runHealthCheck`: KV, the Gemini API, and the Google Service Account JSON are checked in parallel, and a GitHub Issue is filed when any check fails.

### Caching

All entries live in the KV namespace bound as `sushanshan_bot` and expire via KV native TTL:

- `sheet_info` - Google Sheets snapshot, fixed 5 minute TTL (`SHEET_CACHE_TTL_SECONDS` in `src/clients/kv.ts`). Cache writes are best effort and never fail the workflow.
- `chat_history` - conversation history, TTL from `HISTORY_TTL_SECONDS` (default 300 seconds).
- `error_reported:<fingerprint>` - 1 hour TTL. First-layer deduplication for error and health-check reports; a GitHub Issues search is the second layer.

## Project Structure

```
src/
  index.ts          # Hono app, Discord interaction handler, scheduled (cron) entrypoint
  config.ts         # loadConfig / DEFAULT_RUNTIME_CONFIG / ConfigError - env validation
  contracts.ts      # Dependency-free shared types (Bindings, WorkflowParams, HistoryEntry, ...)
  health.ts         # Cron health check and GitHub Issue reporting
  clients/
    discord.ts      # Discord webhook client (edit/post the original message)
    gemini.ts       # Gemini client (streaming answers, history)
    github.ts       # GitHub Issue client (error/health reports, dedup fingerprints)
    kv.ts           # KV access (sheet cache, conversation history)
    metrics.ts      # Analytics Engine metrics client and NoOp fallback
    spreadSheet.ts  # Google Sheets fetch via service account
  middleware/
    verifyDiscordInteraction.ts  # Ed25519 signature verification
  responses/
    errorResponse.ts             # Discord error message payload
  utils/            # compactSheet, errors, logger, requestId, retry
  workflows/
    answerQuestionWorkflow.ts    # AnswerQuestionWorkflow and its steps
    types.ts                     # Step output types
scripts/            # register.js (slash command registration), commands.js (definitions)
```

Tests live next to their subject as `*.test.ts`.

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

Defaults for the optional values live in `DEFAULT_RUNTIME_CONFIG` (`src/config.ts`); `loadConfig` validates every value and throws `ConfigError` on invalid input.

## Cloudflare Bindings

Defined in `wrangler.toml` and typed in `Bindings` (`src/contracts.ts`):

- `sushanshan_bot` - KV namespace for the sheet cache, conversation history, and error-report deduplication
- `ANSWER_QUESTION_WORKFLOW` - Workflow binding for the `AnswerQuestionWorkflow` class (`answer-question-workflow`)
- `METRICS` (optional) - Analytics Engine dataset `yangbingyibot_metrics`; falls back to `NoOpMetricsClient` when unbound
- `[triggers] crons = ["*/5 * * * *"]` - health check schedule

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
