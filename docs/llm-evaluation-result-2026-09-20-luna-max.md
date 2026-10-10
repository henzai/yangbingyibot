# LLM evaluation result — 2026-09-20 Luna max

This records the real-API comparison for the Luna max follow-up to
[#433](https://github.com/henzai/yangbingyibot/issues/433). It does not change
the production provider or model. The run used the automatic-only scoring mode
introduced for the practical no-human-review workflow.

## Result

The automatic checks show a clear trade-off. Luna max achieved a 100% deferral
ceiling on the six ambiguous/unknown trials, while the Gemini baseline and Luna
medium each achieved 83.3%. Luna max still reached only a 91.7% grounding
ceiling because all three `similar-name-lighting` trials contained a forbidden
term. The Gemini baseline reached 97.2%; Luna medium also reached 91.7%.

Luna max was more expensive and slower than Luna medium, but substantially
cheaper than Gemini. Its total-completion p95 was 6,829 ms versus Gemini's
4,435 ms. These are automatic ceilings and regression signals, not human-
validated factual accuracy or a quality-gate pass.

## Aggregate results

| Candidate | Runs | Required terms | Forbidden terms absent | Grounding ceiling | Deferral ceiling | Japanese/format ceiling | API failure | First text median / p95 | Total median / p95 | Median cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Gemini current | 36 | 97.2% | 100.0% | 97.2% | 83.3% | 100.0% | 0.0% | 2,490 / 3,662 ms | 2,555 / 4,435 ms | $0.001623 |
| OpenAI Luna max | 36 | 100.0% | 91.7% | 91.7% | 100.0% | 100.0% | 0.0% | 2,595 / 5,853 ms | 3,232 / 6,829 ms | $0.000356 |
| OpenAI Luna medium | 36 | 94.4% | 94.4% | 91.7% | 83.3% | 100.0% | 0.0% | 1,010 / 1,692 ms | 1,777 / 2,941 ms | $0.000164 |

The 36-run median cost for Luna max was approximately 78% below Gemini. Luna
medium was approximately 90% below Gemini. Each candidate completed all 36
answer trials without an API failure.

## Cost and reproduction record

- Estimated total: **$0.082201**
  - Gemini current: $0.060113
  - Luna max: $0.015513
  - Luna medium: $0.006575
- Approved worst-case ceiling: $6.7628
- Generation commit: `ac76990e7289ec312a5e4efe4a854716e53aca75`
- Suite: `llm-switch-v2-luna-max`
- Suite hash: `88d0ade51acdbfd341f46081aa827d0a648c269f88a3c2285e2f13eeb4529a50`
- Execution: 12 synthetic cases, three repetitions, serial deterministic interleaving
- Gemini answer/summary: `gemini-3.5-flash-lite` / `gemini-2.5-flash-lite`
- OpenAI answers: `gpt-5.6-luna` with `medium` and `max` reasoning
- SDKs: `@google/genai` 2.23.0; `openai` 7.20.0
- Pricing snapshot: `standard-list-prices-2026-09-20`
- Local run: `.llm-eval/2026-09-20T10-46-09.133Z` (gitignored; raw answers stay local)

Gemini omitted some cached-input usage counters; the evaluator conservatively
included the resulting missing-usage estimate in the Gemini total. No raw
answer, key, or provider error body is committed.

## Interpretation

This automatic-only run does not apply the manually reviewed quality-gate
decision rule and does not recommend a production model. It indicates that max
reasoning helps this fixture's clarification/abstention behavior, but does not
resolve the grounding failure on the similar-name case and adds tail latency.
