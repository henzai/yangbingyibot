# Repository Guidelines

## Project overview

- This repository contains a Discord bot deployed as a Cloudflare Worker.
- It uses Google Gemini for responses, Google Sheets as its knowledge base,
  Cloudflare KV for caches and conversation history, Analytics Engine for
  metrics, and a scheduled health check.
- Use Node.js 24, matching the GitHub Actions configuration.

## Development commands

- `npm run dev`: run the Worker locally.
- `npm test`: run the Vitest suite.
- `npm run check`: apply Biome formatting and lint fixes. This command writes
  files, so use it only when formatting or lint fixes are intended.
- `npm run check:ci`: check formatting and lint without writing.
- `npm run typecheck`: run TypeScript checking without emitting files.
- `npm run cf-typegen`: regenerate Cloudflare binding types.
- `npm run verify`: run all non-writing checks, tests, and a Wrangler deploy
  dry-run. This is the required final local verification command.
- `npm run deploy`: deploy the Worker to Cloudflare production.
- `npm run register`: register Discord slash commands. Run it only when command
  definitions change.

## Change workflow

- For new work, fetch `origin` and start from the latest `origin/main`, unless
  the task explicitly continues an existing branch.
- Prefer a dedicated Git worktree when the primary checkout contains unrelated
  work or when another live task may touch the same files.
- Preserve user changes. Do not include unrelated files, commits, or generated
  changes in the task branch.
- Add or update tests for changed behavior, then run `npm run verify`.
- If `npm run check` changes files, inspect those changes and run
  `npm run verify` again.
- Review the complete branch diff against `origin/main` before publishing it.
- For multi-item work, keep commits scoped to completed logical items.

## Critical behavior

- The `InteractionType.PING` handler in `src/index.ts` is required by Discord.
  Do not remove or change it unless the user explicitly requests a compatible
  replacement. Existing tests protect this behavior.
- Never print or commit `.dev.vars`, API tokens, service-account credentials,
  Discord credentials, cookies, or other secrets.

## Pull requests and release verification

- Create a draft pull request when the task has no existing pull request.
- Monitor the PR checks for `test`, `build`, `typecheck`, and `lint`. Diagnose
  failures, apply scoped fixes, rerun `npm run verify`, and push the fixes.
- After all required checks pass, mark the pull request ready and summarize the
  changes, verification results, and remaining risks.
- Obtain explicit user approval immediately before merging. Do not infer merge
  approval from an earlier implementation request.
- After approval, use squash merge unless the user requests another strategy.
  Monitor the `main` CI run and its Cloudflare `deploy` job to completion.
- After deployment, verify the Worker root endpoint returns HTTP 200, inspect
  Cloudflare logs for new startup or request errors, and, when an authenticated
  test channel is available, run one Discord `/ask` end-to-end check.
- Confirm the next scheduled health check reports no KV, Gemini, or Google
  service-account failure. Ask before any production rollback or other
  destructive recovery action.

