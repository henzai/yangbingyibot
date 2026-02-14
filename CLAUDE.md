# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest
npm run register     # Register Discord slash commands via Discord API
npm run cf-typegen   # Generate Cloudflare Worker types
npm run check        # Run Biome formatter + linter with auto-fix
npm run check:ci     # Run Biome check without writing (for CI)
npm run lint         # Run linter only
npm run format       # Run formatter with auto-write
```

## Architecture

This is a Discord bot deployed on Cloudflare Workers that answers questions using Google Gemini AI with a Google Sheets knowledge base.

**Request Flow:**
1. Discord sends POST request to `/` endpoint
2. Middleware verifies Discord signature (Ed25519)
3. App immediately returns deferred response (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
4. Cloudflare Workflow (`AnswerQuestionWorkflow`) executes asynchronously with 4 steps:
   - Step 1: Get sheet data from Google Sheets (with KV cache)
   - Step 2: Get conversation history from KV
   - Step 3: Stream Gemini response + progressively edit Discord message via PATCH (every 1.5s)
   - Step 4: Save conversation history to KV

**Cron Health Check (every 5 minutes):**
- `scheduled` handler runs `runHealthCheck()` to verify KV, Gemini API, and Google Service Account
- Failures are reported as GitHub Issues (with KV + GitHub search deduplication)

**Caching Strategy:**
- Sheet data cached in KV for 5 minutes using native `expirationTtl`
- Conversation history stored in KV with 5-minute TTL for context

## Project Structure

- `src/index.ts` - Hono app entry point, Discord interaction routing, scheduled handler, Workflow re-export
- `src/health.ts` - Cron health check module (KV, Gemini, Google SA checks)
- `src/types.ts` - TypeScript type definitions (Bindings, etc.)
- `src/clients/` - External API wrappers
  - `discord.ts` - Discord Webhook client for PATCH message edits
  - `gemini.ts` - Google Gemini AI client with streaming support
  - `github.ts` - GitHub Issues client for error and health check reporting
  - `kv.ts` - Cloudflare KV wrapper with native TTL
  - `metrics.ts` - Analytics Engine metrics client
  - `spreadSheet.ts` - Google Sheets client
- `src/workflows/` - Cloudflare Workflows
  - `answerQuestionWorkflow.ts` - Main 4-step workflow orchestrating question answering
  - `types.ts` - Workflow-specific type definitions
- `src/middleware/verifyDiscordInteraction.ts` - Discord request signature verification
- `src/responses/` - Response helpers
  - `errorResponse.ts` - Error response formatting
- `src/utils/` - Utility functions (errors, logger, requestId, retry)
- `scripts/` - Discord command registration utilities

## Environment Variables

Required in Cloudflare Workers secrets or `.dev.vars` for local development:

- `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` - Discord credentials
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_SERVICE_ACCOUNT` - Google Service Account credentials (JSON string)
- `GITHUB_TOKEN` (optional) - GitHub PAT for auto-reporting errors and health check failures as Issues

**Bindings in wrangler.toml:**
- KV Namespace: `sushanshan_bot`
- Analytics Engine: `METRICS` (dataset: `yangbingyibot_metrics`)
- Workflow: `ANSWER_QUESTION_WORKFLOW` (class: `AnswerQuestionWorkflow`)
- Cron Trigger: `*/5 * * * *` (health check every 5 minutes)

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` と `npm test` で検証すること
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

### Discord PING/PONG Endpoint (src/index.ts)

**⚠️ DO NOT REMOVE OR MODIFY WITHOUT CAREFUL CONSIDERATION**

The `InteractionType.PING` handler in `src/index.ts` is **MANDATORY** per Discord's specification.

**Why it's critical:**
- Discord sends PING (type=1) requests to verify endpoint availability during initial setup and periodic health checks
- The endpoint must respond with PONG (type=1) for Discord to accept the interactions endpoint URL
- Removing or modifying this handler will cause Discord to reject the endpoint and disable all bot interactions

**Protection measures:**
- Unit tests in `src/index.test.ts` verify PING/PONG functionality
- Detailed comments in the code explain its purpose
- Any changes that break this handler will fail CI/CD tests

**Reference:** [Discord Interactions Documentation](https://discord.com/developers/docs/interactions/receiving-and-responding#receiving-an-interaction)
