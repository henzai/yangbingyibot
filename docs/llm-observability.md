# LLM health and usage observability

This document defines the monitoring contract introduced by
[#432](https://github.com/henzai/yangbingyibot/issues/432). It covers selected
LLM health probes, Analytics Engine field positions, and migration from the
Gemini-only events. It does not select a production model or change the active
provider.

## Health probes

The scheduled check always keeps the KV read and Google service-account JSON
checks. It additionally resolves the configured answer and enabled summary
targets, groups them by `provider/model`, and probes each unique target once.
Disabled or unselected providers are neither constructed nor contacted. A
shared answer/summary target has both purposes on one result; different models
or providers have separate results.

Both built-in probes are non-generating and use a five-second deadline:

- Gemini calls `models.get` for the exact configured model and requires its
  metadata to advertise `generateContent`. This checks endpoint reachability,
  authentication, model visibility, and advertised generation capability.
- OpenAI calls `GET /models/{model}` for the exact configured model. This checks
  endpoint reachability, authentication, and model visibility. The Models API
  returns basic model and permission information, so Responses API compatibility
  and successful generation remain unverified.

These metadata probes do not prove that a real generation will complete, meet
latency requirements, or produce a useful answer. A successful list operation
is not used as a substitute for checking the configured model. Real generation
belongs to the explicit evaluation procedure in #433 and may incur usage.

Probe outcomes are `healthy`, `unhealthy`, or `unverified`. Authentication
(`401`/`403`), timeout, transport, and capability failures have distinct
`errorKind` values. A provider without a safe non-generating probe is
`unverified`, which makes `allHealthy` false; it is never silently promoted to
healthy. A summary-only target retains purpose `summary`, so its failure is
distinguishable from answer unavailability.

Health incident fingerprints use `health_check:v2` and include status,
provider, model, purpose, and failure kind. LLM targets are reported as separate
incidents, preventing two providers from sharing a fingerprint. Infrastructure
failures may still be grouped. Legacy `health_check:<names>` fingerprints and
their one-hour KV keys are not reused because they cannot distinguish model or
purpose. During cutover, an existing legacy issue can therefore coexist with
one new v2 issue; after that, KV and GitHub-search deduplication use only the v2
identity.

References checked 2026-09-09:

- [Gemini Models API](https://ai.google.dev/api/models)
- [OpenAI Retrieve model API](https://developers.openai.com/api/reference/cli/resources/models/methods/retrieve)

## Analytics Engine schema

Analytics Engine uses ordered `blobN` and `doubleN` columns, so field order is
part of the contract. The request ID is the single sampling index and is safely
truncated to 96 UTF-8 bytes. See the
[Analytics Engine data model](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
and [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/).

### `llm_api_call_v2`

Every answer or summary aggregate writes one v2 data point.

| Position | Meaning |
| --- | --- |
| `index1` | request ID |
| `blob1` | `llm_api_call_v2` |
| `blob2` | full request ID |
| `blob3` | provider |
| `blob4` | model |
| `blob5` | purpose: `answer` or `summary` |
| `double1` | completion duration in milliseconds |
| `double2` | success: `1` or `0` |
| `double3` | logical call count |
| `double4` | provider retry count |
| `double5` | time to first answer text in milliseconds |
| `double6` | input tokens, including cached input |
| `double7` | cached input tokens, already included in input |
| `double8` | output tokens, excluding reasoning |
| `double9` | reasoning tokens |
| `double10` | provider-reported total tokens |

Unavailable numeric observations use `-1`, not `0`. A genuine zero remains
zero. Summary calls have no streaming first-text observation, so `double5` is
`-1`. The answer duration is measured while consuming the stream and therefore
includes consumer backpressure from progressive Discord presentation. Retry
counts come from adapter attempt hooks. Summary metrics aggregate all logical
summary calls and all their retries.

Usage counters follow the common semantics in `docs/llm-gateway.md`. In
particular, do not add cached input to input, reasoning to output, or any
component to provider-reported total. If any call lacks a counter, that counter
in the aggregate is unknown (`-1`) rather than a partial total. Pricing is not
embedded in the Worker. Cost analysis must join measured usage with an external
price table that records its source and effective date.

### Compatibility and query migration

Gemini calls are dual-written during migration:

1. Query `blob1 = 'llm_api_call_v2'` for provider comparisons, latency, retries,
   and cost evaluation.
2. Existing Gemini dashboards may continue querying
   `blob1 = 'gemini_api_call'`; its old blob/double positions are unchanged.
3. Do not union both event types when counting Gemini calls or usage, because
   they describe the same logical activity and would double-count it.
4. Migrate consumers to v2, validate equivalent Gemini totals over the same
   time range, then remove the legacy dual write in a separately reviewed
   change.

Repository search found no production query definitions or consumers beyond
the writer and tests, so any dashboard or external SQL consumer must be audited
operationally before the legacy event is removed. The short-lived pre-v2
`llm_api_call` event is superseded by `llm_api_call_v2`; production remained on
Gemini during that interval, so it has no expected OpenAI production data.

The existing `health_check` event retains `double1 = duration` and
`double2 = success`. Its blobs are now:

| Position | Meaning |
| --- | --- |
| `blob1` | `health_check` |
| `blob2` | check identifier |
| `blob3` | status |
| `blob4` | provider, or empty |
| `blob5` | model, or empty |
| `blob6` | `+`-joined purposes, or empty |
| `blob7` | error kind, or empty |
| `blob8` | probe scope, or empty |
| `blob9` | advertised generation support, or empty |

Queries that only filter `blob1 = 'health_check'` and use the first two doubles
remain compatible. A query matching the old Gemini check name must migrate to
the provider/model/purpose columns.
