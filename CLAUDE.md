# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest
npm run register     # Register Discord slash commands via Discord API
npm run cf-typegen   # Generate Cloudflare Worker types
```

## Architecture

This is a Discord bot deployed on Cloudflare Workers that answers questions using Google Gemini AI with a Google Sheets knowledge base.

**Request Flow:**
1. Discord sends POST request to `/` endpoint
2. Middleware verifies Discord signature (Ed25519)
3. App immediately returns deferred response (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
4. Actual processing happens asynchronously via `executionCtx.waitUntil()`
5. Result posted to Discord via webhook follow-up

**Caching Strategy:**
- Sheet data cached in KV for 5 minutes
- Conversation history stored in KV with 5-minute window for context

## Project Structure

- `src/index.ts` - Hono app entry point, Discord interaction routing
- `src/clients/` - External API wrappers
  - `gemini.ts` - Google Gemini AI client with conversation history
  - `kv.ts` - Cloudflare KV wrapper for caching
  - `spreadSheet.ts` - Google Sheets client
- `src/handlers/answerQuestion.ts` - Orchestrates question answering flow
- `src/middleware/verifyDiscordInteraction.ts` - Discord request signature verification
- `scripts/` - Discord command registration utilities

## Environment Variables

Required in Cloudflare Workers secrets or `.dev.vars` for local development:

- `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` - Discord credentials
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` - Google Service Account for Sheets

KV namespace `sushanshan_bot` must be bound in wrangler.toml.

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
