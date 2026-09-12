import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
	ILlmGateway,
	LlmRequest,
	LlmStreamEvent,
	LlmUsage,
} from "../../src/llm/types";
import {
	assertFreshPricing,
	calculateCallCost,
	calculateObservedCost,
	estimateSuiteUpperBound,
} from "./pricing";
import { runEvaluation } from "./runner";
import {
	median,
	nearestRankPercentile,
	runAutomaticChecks,
	summarizeEvaluation,
} from "./scoring";
import {
	buildPrompt,
	loadJsonFile,
	promptBytes,
	validatePriceCoverage,
	validateSuite,
} from "./suite";
import type {
	EvalRunResult,
	EvalSuite,
	ManualJudgment,
	PriceCatalog,
	PriceCatalogEntry,
} from "./types";

const fixtureDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

async function fixtures(): Promise<{
	suite: EvalSuite;
	prices: PriceCatalog;
}> {
	return {
		suite: await loadJsonFile<EvalSuite>(
			resolve(fixtureDirectory, "suite-v1.json"),
		),
		prices: await loadJsonFile<PriceCatalog>(
			resolve(fixtureDirectory, "pricing.json"),
		),
	};
}

const completeUsage: LlmUsage = {
	inputTokens: 100,
	cachedInputTokens: 25,
	outputTokens: 20,
	reasoningTokens: 5,
	totalTokens: 125,
};

type FakeOptions = {
	usage?: LlmUsage | null;
	probeStatus?: "available" | "unavailable";
	throwMessage?: string;
	attempts?: number;
};

function fakeGateway(
	provider: "gemini" | "openai",
	options: FakeOptions = {},
): ILlmGateway & { streamCalls: number; probeCalls: string[] } {
	const gateway = {
		provider,
		capabilities: { reasoningSummary: provider === "gemini" },
		streamCalls: 0,
		probeCalls: [] as string[],
		async *generateStream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
			gateway.streamCalls++;
			for (let attempt = 0; attempt < (options.attempts ?? 1); attempt++) {
				request.telemetry?.onAttempt();
			}
			if (options.throwMessage) throw new Error(options.throwMessage);
			if (request.includeReasoningSummary) {
				yield { type: "reasoning_summary", delta: "資料を確認しています。" };
			}
			request.telemetry?.onFirstText?.();
			yield { type: "text", delta: "資料に基づく日本語の回答です。" };
			const usage = options.usage === undefined ? completeUsage : options.usage;
			if (usage) yield { type: "usage", usage };
			yield { type: "finish", finish: { reason: "stop" } };
		},
		async generateText(request: LlmRequest) {
			for (let attempt = 0; attempt < (options.attempts ?? 1); attempt++) {
				request.telemetry?.onAttempt();
			}
			return {
				text: "資料を確認中です。",
				usage: options.usage === undefined ? completeUsage : options.usage,
				finish: { reason: "stop" as const },
			};
		},
		async probe({ model }: { model: string }) {
			gateway.probeCalls.push(model);
			return {
				status: options.probeStatus ?? "available",
				scope: "model_metadata" as const,
				generationSupport: "supported" as const,
			};
		},
	};
	return gateway;
}

async function runWithFakes(options: FakeOptions = {}) {
	const { suite, prices } = await fixtures();
	const gateways = {
		gemini: fakeGateway("gemini", options),
		openai: fakeGateway("openai", options),
	};
	const progress: string[] = [];
	const artifact = await runEvaluation({
		suite,
		prices,
		apiKeys: { gemini: "secret-gemini", openai: "secret-openai" },
		gitCommit: "test-commit",
		providerSdkVersions: { gemini: "test-gemini", openai: "test-openai" },
		gatewayFactory: (provider) => gateways[provider],
		now: new Date("2026-09-12T12:00:00Z"),
		onProgress: (message) => progress.push(message),
	});
	return { artifact, gateways, progress };
}

describe("fixed evaluation fixtures", () => {
	it("contains twelve bounded synthetic cases and all candidate prices", async () => {
		const { suite, prices } = await fixtures();
		expect(() => validateSuite(suite)).not.toThrow();
		expect(() => validatePriceCoverage(suite, prices)).not.toThrow();
		expect(suite.cases).toHaveLength(12);
		expect(
			Math.max(
				...suite.cases.map((testCase) =>
					promptBytes(buildPrompt(suite, testCase)),
				),
			),
		).toBeLessThanOrEqual(16 * 1024);
		expect(estimateSuiteUpperBound(suite, prices)).toBeLessThanOrEqual(5);
	});

	it("rejects a pricing snapshot older than seven days", async () => {
		const { prices } = await fixtures();
		expect(() =>
			assertFreshPricing(prices, new Date("2026-09-20T00:00:01Z")),
		).toThrow(/stale/);
	});
});

describe("cost and statistics", () => {
	const price: PriceCatalogEntry = {
		provider: "openai",
		model: "test",
		inputPerMillionUsd: 2,
		cachedInputPerMillionUsd: 0.2,
		outputPerMillionUsd: 12,
		reasoningPerMillionUsd: 12,
	};

	it("separates cached input, regular input, output, reasoning, and retry reserve", () => {
		const usage: LlmUsage = {
			inputTokens: 100,
			cachedInputTokens: 40,
			outputTokens: 20,
			reasoningTokens: 10,
			totalTokens: 130,
		};
		expect(calculateObservedCost(usage, price)).toBeCloseTo(0.000488);
		expect(calculateCallCost(usage, 2, 100, 50, price)).toEqual({
			observedUsageUsd: 0.000488,
			retryReserveUsd: 0.0008,
			totalEstimatedUsd: 0.001288,
			kind: "observed_plus_retry_estimate",
		});
	});

	it("treats nullable usage as unknown cost", () => {
		expect(calculateObservedCost(null, price)).toBeNull();
		expect(
			calculateObservedCost({ ...completeUsage, reasoningTokens: null }, price),
		).toBeNull();
	});

	it("uses the median and nearest-rank p95 definitions", () => {
		expect(median([1, 9, 2, 10])).toBe(5.5);
		expect(
			nearestRankPercentile(
				Array.from({ length: 20 }, (_, i) => i + 1),
				0.95,
			),
		).toBe(19);
	});
});

describe("automatic and manual scoring", () => {
	it("normalizes Japanese names and checks timeline formatting", async () => {
		const { suite } = await fixtures();
		const testCase = suite.cases.find(({ id }) => id === "japanese-biography");
		if (!testCase) throw new Error("fixture missing");
		const checks = runAutomaticChecks(
			"三枝 永久\n- 2010年: 採集開始\n- 2017年: 風の目録\n- 2022年: 主任就任",
			testCase,
		);
		expect(checks).toMatchObject({
			requiredTermsPresent: true,
			forbiddenTermsAbsent: true,
			japanesePresent: true,
			timelineFormatPresent: true,
		});
	});

	it("refuses to summarize incomplete blinded judgments", () => {
		const result = scoredResult("baseline", "run-1");
		const incomplete: ManualJudgment = {
			runId: "run-1",
			identityCorrect: null,
			unsupportedPersonOrBiography: false,
			supportedFacts: true,
			behaviorCorrect: true,
			formatCorrect: true,
			notes: "",
		};
		expect(() =>
			summarizeEvaluation([result], [incomplete], "baseline"),
		).toThrow(/incomplete/);
	});

	it("uses first-text p95 to break a passing cost tie within ten percent", () => {
		const baseline = scoredResult("baseline", "run-baseline");
		const candidate = scoredResult("candidate", "run-candidate");
		candidate.firstTextMs = 5;
		if (!candidate.cost) throw new Error("test cost missing");
		candidate.cost.observedUsageUsd = 0.00105;
		candidate.cost.totalEstimatedUsd = 0.00105;
		const judgments = [baseline, candidate].map(({ runId }) => ({
			runId,
			identityCorrect: true,
			unsupportedPersonOrBiography: false,
			supportedFacts: true,
			behaviorCorrect: true,
			formatCorrect: true,
			notes: "",
		}));
		const summary = summarizeEvaluation(
			[baseline, candidate],
			judgments,
			"baseline",
		);
		expect(summary.recommendedCandidateId).toBe("candidate");
		expect(
			summary.candidates.every(({ passesQualityGate }) => passesQualityGate),
		).toBe(true);
	});
});

describe("evaluation runner with fake gateways", () => {
	it("runs sequentially with probes, retries, summaries, and no credential output", async () => {
		const { artifact, gateways, progress } = await runWithFakes({
			attempts: 2,
		});
		expect(artifact.results).toHaveLength(108);
		expect(artifact.abortedReason).toBeUndefined();
		expect(gateways.gemini.probeCalls).toEqual([
			"gemini-3.5-flash-lite",
			"gemini-2.5-flash-lite",
		]);
		expect(gateways.openai.probeCalls).toEqual([
			"gpt-5.6-luna",
			"gpt-5.6-terra",
		]);
		expect(
			artifact.results.every(
				({ answerAttemptCount }) => answerAttemptCount === 2,
			),
		).toBe(true);
		expect(
			artifact.results.some(({ summaryCallCount }) => summaryCallCount === 1),
		).toBe(true);
		expect(
			artifact.results.every(({ cost }) => (cost?.retryReserveUsd ?? 0) > 0),
		).toBe(true);
		const visible = JSON.stringify({ artifact, progress });
		expect(visible).not.toContain("secret-gemini");
		expect(visible).not.toContain("secret-openai");
		expect(JSON.stringify(progress)).not.toContain(
			"資料に基づく日本語の回答です。",
		);
	});

	it("stops before later calls when usage is missing", async () => {
		const { artifact, gateways } = await runWithFakes({ usage: null });
		expect(artifact.results).toHaveLength(1);
		expect(artifact.abortedReason).toMatch(/usage data/);
		expect(gateways.gemini.streamCalls + gateways.openai.streamCalls).toBe(1);
	});

	it("stops before the next request can exceed the runtime budget", async () => {
		const expensiveUsage: LlmUsage = {
			inputTokens: 10_000_000,
			cachedInputTokens: 0,
			outputTokens: 10_000_000,
			reasoningTokens: 0,
			totalTokens: 20_000_000,
		};
		const { artifact, gateways } = await runWithFakes({
			usage: expensiveUsage,
		});
		expect(artifact.results).toHaveLength(2);
		expect(artifact.abortedReason).toMatch(/budget/);
		expect(gateways.gemini.streamCalls + gateways.openai.streamCalls).toBe(1);
	});

	it("fails before generation when an exact model probe is unavailable", async () => {
		await expect(runWithFakes({ probeStatus: "unavailable" })).rejects.toThrow(
			/model probe did not verify/,
		);
	});

	it("does not retain provider error text in artifacts", async () => {
		const { artifact } = await runWithFakes({
			throwMessage: "private-response-and-api-key",
		});
		expect(JSON.stringify(artifact)).not.toContain(
			"private-response-and-api-key",
		);
		expect(artifact.results[0].errorKind).toBe("unknown");
	});
});

function scoredResult(candidateId: string, runId: string): EvalRunResult {
	return {
		runId,
		candidateId,
		blindedCandidateId: "candidate-hidden",
		caseId: "case",
		category: "numeric_alias",
		repetition: 1,
		success: true,
		response: "answer",
		finishReason: "stop",
		answerUsage: completeUsage,
		summaryUsage: null,
		answerAttemptCount: 1,
		summaryCallCount: 0,
		summaryRetryCount: 0,
		firstTextMs: 10,
		answerCompletionMs: 20,
		totalCompletionMs: 20,
		cost: {
			observedUsageUsd: 0.001,
			retryReserveUsd: 0,
			totalEstimatedUsd: 0.001,
			kind: "observed",
		},
		automaticChecks: {
			requiredTermsPresent: true,
			forbiddenTermsAbsent: true,
			behaviorSignalPresent: true,
			japanesePresent: true,
			timelineFormatPresent: null,
		},
	};
}
