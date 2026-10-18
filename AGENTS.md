# Repository Guidelines

## Project overview

- This repository contains a Discord bot deployed as a Cloudflare Worker.
- It uses a configurable LLM provider (OpenAI or Gemini) for responses, Google
  Sheets as its knowledge base,
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

## Environment variables

Set these as Cloudflare Workers secrets, or in `.dev.vars` for local
development.

- Required: `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`,
  and `GOOGLE_SERVICE_ACCOUNT` (service-account JSON string), plus the API key
  for each selected LLM provider (`GEMINI_API_KEY` or `OPENAI_API_KEY`).
- Optional: `GITHUB_TOKEN`, a GitHub PAT used to report errors and health check
  failures as Issues.
- Optional runtime configuration, validated in `src/config.ts`:
  `LLM_PROVIDER`, `LLM_MODEL`, `LLM_SUMMARY_ENABLED`, `LLM_SUMMARY_PROVIDER`,
  `LLM_SUMMARY_MODEL`, `LLM_ANSWER_MODE` (`legacy` default or `tools`; see
  `docs/workflow-sheet-tools.md`), `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL`,
  `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DATA_SHEET_NAME`,
  `GOOGLE_DESCRIPTION_SHEET_NAME`, `GITHUB_REPOSITORY` (`owner/repository`),
  and `HISTORY_TTL_SECONDS` (60–86400, default 300). Production values for
  `LLM_*` live in `wrangler.toml`.

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

## Repository skills

- Repository skills live in `.agents/skills/`. Claude Code reads them through
  per-skill symlinks in `.claude/skills/`.
- Use the `yangbingyibot-discord-ask-e2e` skill (`$yangbingyibot-discord-ask-e2e`
  in Codex, `/yangbingyibot-discord-ask-e2e` in Claude Code) for the production
  Discord `/ask` end-to-end check after a deployment that changes runtime files
  (see "Pull requests and release verification") or whenever the user asks to
  verify the deployed Discord interaction flow.
- Follow the skill's authenticated Chrome and `#test` workflow. Do not
  substitute a fabricated Interaction request, plain Discord message, bot-token
  command invocation, or Discord user-token/internal API call.
- A user-approved release workflow or explicit E2E request authorizes one
  skill-compliant `/ask` in the configured `#test` channel without a separate
  submission confirmation. Follow the skill's standing-authorization limits.
- Verify the application response rather than treating command submission alone
  as success. Do not automatically resend a failed or timed-out check.

## Multi-agent delegation

Codex and Claude Code both follow this file (Claude Code loads it through
`CLAUDE.md`), so either one can be the parent session and delegate to the
other.

- Quality comes first, but frontier-model usage is scarce on both
  subscriptions. Keep the parent's own turns for work that needs frontier
  judgment: planning, design decisions, briefs, review of delegated output and
  of the final diff, and user decisions.
- Delegate bounded routine work to a lighter tier by default:
  - Read-only search across many files, reading long logs or CI output, and
    summarizing web or documentation research.
  - Mechanical edits that the brief fully specifies, such as renames,
    repetitive test cases, or review findings that name the exact fix.
  - Running checks, monitoring CI, and runtime verification (see "Verification
    delegation").
- Pick the cheapest delegate that fits: a lighter model inside the same CLI
  first, then the other CLI with the standard invocations below. In Claude
  Code, use the `Explore` agent or a subagent with `model: "haiku"` for search
  and summaries, and `model: "sonnet"` for mechanical edits and review. In
  Codex, use
  `codex exec -m gpt-6-luna -c model_reasoning_effort="medium" "<brief>"`.
- Keep the work in the parent when the brief would cost more than the work
  itself, such as a one-line fix or a file already in context, or when the
  task depends on judgment or context that a brief cannot carry.
- Do not trade quality for usage. If delegated output fails verification, fix
  it in the parent or rerun it once at a heavier tier; do not retry the same
  light tier in a loop.
- Do not add automatic model runs on every turn, such as a hook that reviews
  each response.
- Standard invocations. Research and review use a lighter tier to save usage;
  implementation that needs judgment uses each CLI's default model:
  - Claude Code → Codex:
    `codex exec -s read-only -c model_reasoning_effort="medium" "<brief>"` for
    research or review,
    `codex exec review -c model_reasoning_effort="medium"` for a diff review,
    and `codex exec --worktree "<brief>"` for implementation.
  - Codex → Claude Code:
    `claude -p --permission-mode plan --model sonnet "<brief>"` for research
    or review, and `claude -p -w <name> "<brief>"` for implementation.
- Use the heavier review tier (`model_reasoning_effort="high"` for Codex,
  `--model opus` for Claude Code) only when the user asks for it, or when the
  change affects production configuration (`wrangler.toml`, secrets, or CI and
  deploy workflows) or makes a major design decision.
- When the parent's own subscription usage runs high, treat the other CLI as
  the main worker: delegate implementation, research, and review to it with the
  standard invocations, and keep only planning, briefs, verification of
  delegated output, and user decisions in the parent. Neither CLI shows the
  model its remaining quota, so act only when the user says usage is high or
  the session shows a usage-limit warning; do not guess. If the delegate also
  hits its limit, stop and report to the user instead of retrying or switching
  to a heavier model.
- A brief starts by stating that it is for a delegated session, then gives the
  goal, constraints, relevant files, completion criteria, and output format.
  The delegate starts without the parent's context.
- A delegated session does not commit, push, create or update pull requests,
  merge, deploy, or touch production unless the brief explicitly asks for it.
  It returns its results to the parent and does not delegate further.
- The parent verifies delegated output before using it: check the exit code
  and evidence that the work actually ran, and run `npm run verify` on any
  delegated code change. User approvals stay with the parent session and do
  not transfer to a delegate unless the brief states the approved scope.

## Verification delegation

- When Claude Code is the parent, run the verifier through
  `codex exec -m gpt-6-luna -c model_reasoning_effort="medium" "<brief>"` so
  the model rule below still applies.

- Delegate runtime checks, including production root/log/health checks and
  Discord `/ask` E2E, to a sub-agent using `gpt-6-luna` with reasoning effort
  `medium`. The parent agent owns implementation, release actions, and review
  of the verification evidence.
- Give the verifier the exact revision/environment, applicable skill and local
  configuration paths, expected evidence, and authorization limits. A verifier
  already running as a sub-agent performs the checks itself; do not delegate
  recursively.
- Assign one verifier per check. Share existing submission records and pending
  login state so parallel agents or resumed sessions do not duplicate `/ask`.
- Have the verifier report blockers to the parent instead of independently
  broadening permissions, retrying submissions, or escalating to a larger model.

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
- Skip the post-deployment runtime checks above (root endpoint, Cloudflare
  logs, Discord `/ask`, and scheduled health check) when the merged diff
  touches no runtime files, because the redeployed Worker is identical.
  Runtime files are `src/`, `wrangler.toml`, `package.json`,
  `package-lock.json`, and `.github/workflows/`; changes limited to files such
  as `*.md`, `docs/`, `.agents/`, or `.claude/` qualify. Still monitor the
  `main` CI run and its `deploy` job, and state in the summary that the checks
  were skipped and why.
