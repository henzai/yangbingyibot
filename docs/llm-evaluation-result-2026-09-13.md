# LLM evaluation result — 2026-09-13

This records the real-API comparison for
[#433](https://github.com/henzai/yangbingyibot/issues/433). It does not change
the production provider or model.

## Decision

Keep the current Gemini configuration. Neither OpenAI candidate passed the
pre-registered quality gates. In fact, all three candidates failed the hard
requirement for 100% appropriate clarification or abstention: each passed five
of the six ambiguous/unknown trials (83.3%). Because automatic and reviewer
checks are conjunctive, no favorable manual judgment could change that failed
gate. Full manual grading was therefore unnecessary for the selection and was
omitted; no LLM judge was used.

`gpt-5.6-luna` was materially cheaper and faster, but it also missed the
grounding ceiling (91.7% versus the 95% gate). `gpt-5.6-terra` missed the same
gate at 94.4%. A future OpenAI recommendation needs a new evaluation version
after improving unknown-person behavior; the fixed v1 results must not be
silently rescored with changed prompts or criteria.

## Aggregate results

The quality columns below are the maximum rates possible from the automatic
checks, assuming every unperformed reviewer judgment were favorable. A failed
gate in this table is therefore decisive; person mix-up and unsupported-fact
rates remain unverified rather than being reported as zero.

| Candidate | Runs | Grounded ceiling | Deferral ceiling | Japanese/format ceiling | API failure | First text median / p95 | Total median / p95 | Median cost | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Gemini current | 36 | 97.2% | 83.3% | 100% | 0% | 1,564 / 2,668 ms | 1,872 / 2,959 ms | $0.001554 | FAIL: deferral |
| OpenAI Luna | 36 | 91.7% | 83.3% | 100% | 0% | 1,027 / 1,660 ms | 1,731 / 2,627 ms | $0.000166 | FAIL: grounding, deferral |
| OpenAI Terra | 36 | 94.4% | 83.3% | 100% | 0% | 934 / 2,495 ms | 1,706 / 3,946 ms | $0.001294 | FAIL: grounding, deferral |

All candidates completed all 36 answer trials without an API failure or retry.
Both OpenAI candidates stayed within the latency gate of 1.5 times the Gemini
total-completion p95 (4,439 ms). Luna's median answer cost was about 89% below
Gemini and Terra's about 17% below Gemini, but cost and speed are considered
only after the quality gates pass.

## Cost accounting

The successful 108-answer run totaled an estimated $0.120663:

| Candidate | Total estimated cost | Usage qualification |
| --- | ---: | --- |
| Gemini current | $0.059242 | Conservative for all 36 answers |
| OpenAI Luna | $0.006411 | Provider usage observed for all 36 answers |
| OpenAI Terra | $0.055010 | Provider usage observed for all 36 answers |

Gemini omitted `cachedInputTokens` from all 36 answer usage records. It also
omitted cached-input and reasoning counters from the 16 returned summary usage
aggregates (17 summary calls total). The evaluator conservatively priced omitted
cache counters as uncached input and derived omitted generated counters only
when the provider total and equal output/reasoning unit prices made a safe bound
possible. These estimated portions remain separate in the local artifact.

Two earlier safety-check runs stopped as designed before the complete run. They
made two Gemini answer calls and one Gemini summary call in total, then stopped
on the original strict missing-counter rule. Their charge is unknown and is not
included in $0.120663. No raw answer, key, or provider error body is committed.

Prices were checked on 2026-09-13 against the official
[OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[OpenAI Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
[Gemini](https://ai.google.dev/gemini-api/docs/pricing) pages. The run used
standard synchronous token prices and no tools. The conservative offline upper
bound was $4.3323 against the $5.00 stop limit.

## Reproduction record

- Generation code base: `fd73b2c2abc946ed77fed9fbd7b7f2fd4696430e`
- Suite: `llm-switch-v1`
- Suite hash: `492953288e54acdd6a0a47dedaee14304602a7fc7e952c3e2d49fb038d7faf9c`
- Execution: 12 synthetic cases, three repetitions, serial deterministic
  interleaving with the fixed suite seed
- Output limit: 1,024 tokens per answer
- Gemini answer: `gemini-3.5-flash-lite`, temperature 0, provider-default
  reasoning; summary `gemini-2.5-flash-lite`
- OpenAI answers: `gpt-5.6-luna` and `gpt-5.6-terra`, provider-default
  reasoning, temperature omitted, summaries disabled
- SDKs: `@google/genai` 2.22.0; `openai` 7.15.0
- Cache: no evaluation-managed cache; only provider-reported cache observations
- Pricing snapshot: `standard-list-prices-2026-09-13`
- Local run: `.llm-eval/2026-09-13T13-54-46.711Z` (gitignored; raw answers stay
  local)
- Small-sample warning: each per-case p95 contains only three observations and
  must not be treated as a stable tail-latency estimate

Per-prompt hashes are retained in the local `evaluation.json`; the suite hash
above binds the complete synthetic fixture, prompt inputs, candidates, seed,
limits, and criteria.

| Case | Prompt SHA-256 |
| --- | --- |
| `numeric-alias-zero` | `4ae81513aafad6f3c9bdaecd87ee1815c02e8bc3292b332a6a45e8da7d6bc5e2` |
| `alias-star-walker` | `2473a81c96b71674361659a7a88663774b8e14b55444bf2ab72079c51de2b1f7` |
| `similar-name-lighting` | `c6d90374f3cd4b26f5ecf5b36e09da5c50ad9d9ff718ce7359e031a59fd215b9` |
| `similar-name-printmaker` | `6dfa53c07ddcfff9d7eec910fb06f83147a705eff66786783e2f1fcb6ce5585d` |
| `ambiguous-yakumo` | `f4d8ff65636b220c9f18e72b6b9004d5c32da549e0c1ff456db78b5622713b89` |
| `unknown-person` | `e86a1666f8122b6c0f46d6f13f47b7a4e8de3fe67fbb16814f626f3c7f4a9382` |
| `conversation-pronoun` | `60e58c724fa84988916f63c39168328fb8aa89161c72d348c310bbf44c75795e` |
| `conversation-correction` | `06205017d3f98aaabb11452a373a72f80d875b27fdad48101d2633f0de00b9a2` |
| `japanese-biography` | `343138501b303f2f67b561472eb74147f1fa8b12d9ab07f95c28ce6410149c52` |
| `japanese-biography-lacquer` | `5d637f5b0918b41ae3f0ab0aab28c49a60fba9fdb6c6a43bc99a90321c07b8ea` |
| `long-context-final-record` | `6f14896997b165951d7ef92c29cdb5afad2f1b8f28272773856f88228c29614c` |
| `long-context-cross-record` | `cd5d6a7950147382f13f4c91c1c73019a064091508e23097ec2214e4efbc0148` |

## Follow-up

Do not switch production to OpenAI from this result. If the unknown-person
prompt or abstention behavior is improved, create a new suite version and rerun
all candidates. Any later production switch remains a separate configuration
change requiring explicit approval and deployment verification.
