# LLM evaluation procedure

This document defines the pre-registered evaluation for
[#433](https://github.com/henzai/yangbingyibot/issues/433). The evaluation is
separate from production configuration: running it does not change the Worker,
and an evaluation recommendation is not approval to change a production model.

## Fixed comparison

`tools/llm-eval/fixtures/suite-v1.json` contains twelve entirely synthetic
questions about fictitious people. The cases cover numeric names and aliases,
similar names, ambiguous identity, absent evidence, conversation continuation,
Japanese output and requested format, and facts near the end of a long knowledge
snapshot. The runner rejects a suite unless all categories are present, there are
exactly twelve cases and three repetitions, the answer limit is 1,024 tokens,
and every rendered prompt is at most 16 KiB.

The fixed candidates are:

| Candidate | Answer | Thinking summary |
| --- | --- | --- |
| Current baseline | `gemini-3.5-flash-lite` | `gemini-2.5-flash-lite` |
| Low-cost candidate | `gpt-5.6-luna` | disabled |
| Balanced candidate | `gpt-5.6-terra` | disabled |

The fixed seed controls candidate interleaving and blinded IDs. The common
production Gateway deliberately has no provider-specific seed parameter, so the
runner does not bypass it to inject one. Gemini requests temperature zero;
temperature is omitted for the OpenAI reasoning models, whose adapter permits
only model-supported optional fields. All of these effective settings are kept
in the suite and result artifact.

The seed, fixture, prompt construction, per-candidate temperature,
provider-default reasoning setting, criteria, output limit, and repetitions
must not change after the first evaluation PR is merged. A change requires a new
suite version and a fresh comparison of every candidate.

## Safe commands

Use Node.js 24. The default command performs validation and prints only the plan:

```bash
npm run eval:llm
```

It does not load credentials or call an API. It prints the candidate model IDs,
trial count, output limit, price date, approved budget, and a conservative
maximum estimate. Normal tests use only fake gateways, so `npm test`,
`npm run verify`, and GitHub Actions do not call a real LLM.

Before an authorized paid run, update `tools/llm-eval/fixtures/pricing.json`
from the linked official price pages without changing its field semantics. The
runner refuses a snapshot more than seven days old. Put personal evaluation keys
only in the gitignored `.env.local`:

```dotenv
GEMINI_API_KEY=...
OPENAI_API_KEY=...
```

Do not copy GitHub Actions secrets or Worker secrets. After reviewing the printed
plan and obtaining explicit approval for the paid run, execute:

```bash
npm run eval:llm -- --execute
```

`--execute` is the only flag that enables calls. Candidates are interleaved in a
deterministic order and run serially. The runner first performs a non-generating
metadata probe for every exact provider/model target. It then uses the production
`PromptBuilder`, provider `ILlmGateway`, `StreamCoordinator`, and
`ThinkingSummarizer`. The answer request limit is 1,024 tokens; summary requests
are limited to 128 tokens and four calls per answer.

## Budget and usage rules

The approved maximum is USD 5.00. The preflight estimate assumes up to two
provider attempts for every answer and summary call, treats UTF-8 input bytes as
a conservative token ceiling, and allows at most 64 KiB of serialized summary
input. Before each real request, the runner reserves that request's two-attempt
upper bound. It stops before starting a call that could cross the remaining
budget.

Observed cost keeps these components separate:

- ordinary input tokens (`input - cached input`);
- cached input tokens;
- visible output tokens;
- reasoning tokens;
- answer and summary calls; and
- a conservative reserve for billed retry attempts whose usage was not returned.

`inputTokens` already includes cached input, while `outputTokens` excludes
reasoning under the common gateway contract. If any required usage component is
missing, the run stops immediately and is marked cost-unknown. A failed request
without usage may still have been billed; the USD 5.00 control cannot guarantee
that unknown external charge.

## Local artifacts and blinded review

Raw answers are never printed. Execution writes mode-0600 files below the
gitignored `.llm-eval/<timestamp>/` directory:

- `evaluation.json`: full local machine-readable result and candidate mapping;
- `review.json`: responses identified only by stable blinded candidate IDs; and
- `judgments.json`: editable human-scoring template.

The reviewer should use `review.json`, the fixed fixture, and the rubric below;
do not inspect `evaluation.json` until scoring is complete. Set every nullable
field in `judgments.json` to `true` or `false`. Do not paste answers, private
knowledge, keys, or provider error bodies into an issue, pull request, log, or
committed file. The runner stores only normalized error kinds, never raw provider
errors.

Generate the local report after all successful responses have been graded:

```bash
npm run eval:llm:report -- --run .llm-eval/<timestamp>
```

The report command refuses aborted runs, incomplete trials, suite-hash mismatch,
or incomplete human judgments. It writes `summary.json` and `summary.md` in the
same ignored directory. Only a manually inspected, sanitized aggregate may be
copied into the result PR; raw answers remain local.

### Human rubric

For each successful answer, record:

- `identityCorrect`: no person was confused with another person;
- `unsupportedPersonOrBiography`: the answer asserts any unsupported person,
  identity, or biography fact (normally `false`);
- `supportedFacts`: every asserted identity or biography fact is supported by
  the supplied synthetic snapshot;
- `behaviorCorrect`: the answer responds, asks for clarification, or abstains as
  required by the case;
- `formatCorrect`: Japanese and the requested structure are followed; and
- `notes`: optional concise rationale containing no private data.

Automatic checks verify required/forbidden terms, Japanese text, clarification
or abstention signals, and timeline shape. They assist review but do not replace
the human judgment. Grounding, behavior, and format pass only when both the
applicable automatic check and human judgment pass. No LLM judge is used.

## Pre-registered decision rule

For every candidate, the report aggregates person-mix-up rate, supported-fact
rate, appropriate clarification/abstention rate, Japanese/format rate, API
failure rate, first-text latency, answer completion latency, total completion
latency, and cost per answer. Median and nearest-rank p95 are reported. Three
trials per case are a small sample and must be described as such.

A candidate passes only when all gates pass:

- person mix-ups and unsupported person/biography assertions: zero;
- supported-fact rate: at least 95%;
- appropriate clarification or abstention: 100%;
- Japanese/requested format: at least 90%;
- API failure rate: at most 5%; and
- total-completion p95: at most 1.5 times the Gemini baseline.

Among passing candidates, recommend the one with the lowest median cost per
answer. If costs are within 10%, prefer lower first-text p95. If no OpenAI
candidate passes, keep Gemini. The result record must include commit SHA, suite
and per-prompt hashes, exact model IDs, provider SDK versions, reasoning/summary
settings, output cap, repetitions, cache and missing-usage observations, and
price sources/effective date.

## Production regression matrix

The evaluation runner supplements rather than replaces production regression
tests. The following matrix makes every required compatibility area traceable:

| Area | Test evidence |
| --- | --- |
| Shared Gateway contract | `src/llm/providers/gatewayContract.test.ts`: delta text, cumulative usage, one finish, `generateText`, missing usage for both adapters |
| Legacy/default settings | `src/config.test.ts`: backward-compatible defaults, common-over-legacy precedence, provider-specific legacy isolation |
| Missing selected key/model | `src/config.test.ts`: missing setting without secret exposure, OpenAI without Gemini, explicit OpenAI model requirement |
| History and checkpoint compatibility | `src/repositories/conversationHistory.test.ts`: mixed roles and rollback-compatible writes; `src/workflows/answerQuestionWorkflow.test.ts`: old checkpoint/history/usage replay |
| Summary disabled/failure | `src/workflows/answerQuestionWorkflow.test.ts`: OpenAI without Gemini, summary fallback, separate/shared provider; `src/llm/thinkingSummarizer.test.ts`: empty/error fallback |
| Provider API failures | `src/llm/providers/gemini.test.ts` and `openai.test.ts`: retryable establishment, permanent failure, interrupted stream, safe errors |
| Discord delivery failures | `src/clients/discord.test.ts`: typed HTTP/network errors and Retry-After; `src/workflows/answerQuestionWorkflow.test.ts`: intermediate failure, final retry/exhaustion |
| Request time limits | `src/llm/providers/gemini.test.ts` and `openai.test.ts`: cancellation, stalled request/stream deadlines, one budget across retries |
| Discord PING and defer | `src/index.test.ts`: PONG and deferred command response; `src/middleware/verifyDiscordInteraction.test.ts`: valid signed PING continuation |

Run the entire matrix with `npm run verify`. The Worker PING behavior, Workflow
payload/checkpoint contract, and production LLM defaults are not changed by this
evaluation tooling.
