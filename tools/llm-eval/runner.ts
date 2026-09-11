import { buildThinkingSummaryPrompt } from "../../src/llm/promptBuilder";
import { StreamCoordinator } from "../../src/llm/streamCoordinator";
import { createThinkingSummarizer } from "../../src/llm/thinkingSummarizer";
import type { ILlmGateway, LlmUsage } from "../../src/llm/types";
import { addLlmUsage, zeroUsage } from "../../src/llm/usage";
import { ExternalServiceError } from "../../src/utils/errors";
import {
	assertFreshPricing,
	calculateCallCost,
	calculateObservedCost,
	estimateRequestUpperBound,
	estimateSuiteUpperBound,
	findPrice,
	pricingConstants,
} from "./pricing";
import { runAutomaticChecks } from "./scoring";
import {
	buildPrompt,
	promptBytes,
	promptHashes,
	sha256,
	suiteHash,
	validatePriceCoverage,
	validateSuite,
} from "./suite";
import type {
	CandidateConfig,
	EvalCallCost,
	EvalProvider,
	EvalRunResult,
	EvalSuite,
	EvaluationArtifact,
	PriceCatalog,
} from "./types";

export type EvalApiKeys = Record<EvalProvider, string>;

export type GatewayFactory = (
	provider: EvalProvider,
	apiKey: string,
) => ILlmGateway;

export type RunnerOptions = {
	suite: EvalSuite;
	prices: PriceCatalog;
	apiKeys: EvalApiKeys;
	gitCommit: string;
	providerSdkVersions: Record<EvalProvider, string>;
	gatewayFactory: GatewayFactory;
	now?: Date;
	onProgress?: (message: string) => void;
};

class BudgetTracker {
	private spentUsd = 0;
	private reservedUsd = 0;

	constructor(private readonly limitUsd: number) {}

	reserve(estimatedCallUsd: number): number {
		if (this.spentUsd + this.reservedUsd + estimatedCallUsd > this.limitUsd) {
			throw new EvaluationStopError("budget_limit");
		}
		this.reservedUsd += estimatedCallUsd;
		return estimatedCallUsd;
	}

	settle(reservationUsd: number, cost: EvalCallCost): void {
		this.reservedUsd -= reservationUsd;
		this.spentUsd += cost.totalEstimatedUsd;
	}
}

class EvaluationStopError extends Error {
	constructor(
		readonly code: "budget_limit" | "summary_input_limit" | "usage_missing",
	) {
		super(code);
	}
}

function safeErrorKind(error: unknown): string {
	if (error instanceof EvaluationStopError) return error.code;
	return error instanceof ExternalServiceError
		? (error.kind ?? "unknown")
		: "unknown";
}

function blindCandidate(seed: string, candidateId: string): string {
	return `candidate-${sha256(`${seed}:${candidateId}`).slice(0, 8)}`;
}

function orderedCandidates(
	candidates: CandidateConfig[],
	seed: string,
	caseId: string,
	repetition: number,
): CandidateConfig[] {
	return [...candidates].sort((left, right) =>
		sha256(`${seed}:${caseId}:${repetition}:${left.id}`).localeCompare(
			sha256(`${seed}:${caseId}:${repetition}:${right.id}`),
		),
	);
}

function combineCosts(costs: EvalCallCost[]): EvalCallCost {
	const observedUsageUsd = costs.reduce(
		(total, cost) => total + cost.observedUsageUsd,
		0,
	);
	const retryReserveUsd = costs.reduce(
		(total, cost) => total + cost.retryReserveUsd,
		0,
	);
	return {
		observedUsageUsd,
		retryReserveUsd,
		totalEstimatedUsd: observedUsageUsd + retryReserveUsd,
		kind: retryReserveUsd === 0 ? "observed" : "observed_plus_retry_estimate",
	};
}

async function probeTargets(
	suite: EvalSuite,
	gateways: Map<EvalProvider, ILlmGateway>,
): Promise<void> {
	const targets = new Map<string, { provider: EvalProvider; model: string }>();
	for (const candidate of suite.candidates) {
		targets.set(`${candidate.provider}:${candidate.model}`, candidate);
		if (candidate.summary) {
			targets.set(
				`${candidate.summary.provider}:${candidate.summary.model}`,
				candidate.summary,
			);
		}
	}
	for (const { provider, model } of targets.values()) {
		const gateway = gateways.get(provider);
		if (!gateway?.probe) {
			throw new Error(`provider ${provider} has no safe model probe`);
		}
		const result = await gateway.probe({ model, timeoutMs: 5_000 });
		if (result.status !== "available") {
			throw new Error(`model probe did not verify ${provider}:${model}`);
		}
	}
}

async function runOne(
	suite: EvalSuite,
	prices: PriceCatalog,
	candidate: CandidateConfig,
	testCase: EvalSuite["cases"][number],
	repetition: number,
	gateways: Map<EvalProvider, ILlmGateway>,
	budget: BudgetTracker,
): Promise<EvalRunResult> {
	const gateway = gateways.get(candidate.provider);
	if (!gateway) throw new Error(`gateway is missing for ${candidate.provider}`);
	const prompt = buildPrompt(suite, testCase);
	const commonPromptBytes = promptBytes(prompt);
	const answerPrice = findPrice(prices, candidate.provider, candidate.model);
	const coordinator = new StreamCoordinator();
	const start = performance.now();
	let firstTextMs: number | null = null;
	let answerAttemptCount = 0;
	let summaryCallCount = 0;
	let summaryRetryCount = 0;
	let summaryDurationMs = 0;
	let summaryUsage: LlmUsage | null = null;
	let previousSummary = "";
	let summarizedThinkingLength = 0;
	const costs: EvalCallCost[] = [];

	const summaryGateway = candidate.summary
		? gateways.get(candidate.summary.provider)
		: undefined;
	const summarizer =
		candidate.summary && summaryGateway
			? createThinkingSummarizer(summaryGateway, candidate.summary.model)
			: null;

	try {
		const answerReservation = budget.reserve(
			estimateRequestUpperBound(
				commonPromptBytes,
				suite.maxOutputTokens,
				answerPrice,
			) * pricingConstants.maxProviderAttempts,
		);
		for await (const event of gateway.generateStream({
			model: candidate.model,
			prompt,
			...(candidate.temperature === null
				? {}
				: { temperature: candidate.temperature }),
			maxOutputTokens: suite.maxOutputTokens,
			includeReasoningSummary: summarizer !== null,
			telemetry: {
				onAttempt: () => answerAttemptCount++,
				onFirstText: () => {
					firstTextMs ??= performance.now() - start;
				},
			},
		})) {
			const decision = coordinator.handle(event, performance.now());
			if (!decision) continue;
			if (
				decision.phase === "thinking" &&
				summarizer &&
				candidate.summary &&
				summaryCallCount < suite.maxSummaryCallsPerAnswer
			) {
				const newThinking = decision.text.slice(summarizedThinkingLength);
				const summaryPrompt = buildThinkingSummaryPrompt(
					previousSummary,
					newThinking,
				);
				const summaryPromptBytes = Buffer.byteLength(
					JSON.stringify(summaryPrompt),
					"utf8",
				);
				if (summaryPromptBytes > pricingConstants.maxSummaryInputBytes) {
					throw new EvaluationStopError("summary_input_limit");
				}
				const summaryPrice = findPrice(
					prices,
					candidate.summary.provider,
					candidate.summary.model,
				);
				const summaryReservation = budget.reserve(
					estimateRequestUpperBound(
						summaryPromptBytes,
						pricingConstants.summaryOutputTokens,
						summaryPrice,
					) * pricingConstants.maxProviderAttempts,
				);
				const summaryStart = performance.now();
				const summaryResult = await summarizer.summarize(
					previousSummary,
					newThinking,
				);
				summaryDurationMs += performance.now() - summaryStart;
				summaryCallCount++;
				summaryRetryCount += summaryResult.retryCount;
				const summaryCallUsage = summaryResult.usage;
				if (
					!summaryCallUsage ||
					calculateObservedCost(summaryCallUsage, summaryPrice) === null
				) {
					throw new EvaluationStopError("usage_missing");
				}
				summaryUsage = addLlmUsage(
					summaryUsage ?? zeroUsage(),
					summaryCallUsage,
				);
				const summaryCost = calculateCallCost(
					summaryCallUsage,
					summaryResult.retryCount + 1,
					summaryPromptBytes,
					pricingConstants.summaryOutputTokens,
					summaryPrice,
				);
				costs.push(summaryCost);
				budget.settle(summaryReservation, summaryCost);
				if (summaryResult.success) {
					previousSummary = summaryResult.text;
					summarizedThinkingLength = decision.textLength;
				}
			}
			coordinator.markDelivered(decision);
		}
		const completedAt = performance.now();
		const result = coordinator.getResult();
		const answerUsage = result.usage;
		if (
			!answerUsage ||
			calculateObservedCost(answerUsage, answerPrice) === null
		) {
			throw new EvaluationStopError("usage_missing");
		}
		const answerCost = calculateCallCost(
			answerUsage,
			Math.max(1, answerAttemptCount),
			commonPromptBytes,
			suite.maxOutputTokens,
			answerPrice,
		);
		costs.unshift(answerCost);
		budget.settle(answerReservation, answerCost);
		const response = result.response.trim();
		const success =
			response.length > 0 &&
			result.finish.reason !== "blocked" &&
			result.finish.reason !== "error";
		return {
			runId: `${testCase.id}-r${repetition}-${blindCandidate(suite.seed, candidate.id)}`,
			candidateId: candidate.id,
			blindedCandidateId: blindCandidate(suite.seed, candidate.id),
			caseId: testCase.id,
			category: testCase.category,
			repetition,
			success,
			...(success ? {} : { errorKind: `finish:${result.finish.reason}` }),
			response,
			finishReason: result.finish.reason,
			answerUsage,
			summaryUsage,
			answerAttemptCount: Math.max(1, answerAttemptCount),
			summaryCallCount,
			summaryRetryCount,
			firstTextMs,
			answerCompletionMs: Math.max(0, completedAt - start - summaryDurationMs),
			totalCompletionMs: completedAt - start,
			cost: combineCosts(costs),
			automaticChecks: runAutomaticChecks(response, testCase),
		};
	} catch (error) {
		const completedAt = performance.now();
		return {
			runId: `${testCase.id}-r${repetition}-${blindCandidate(suite.seed, candidate.id)}`,
			candidateId: candidate.id,
			blindedCandidateId: blindCandidate(suite.seed, candidate.id),
			caseId: testCase.id,
			category: testCase.category,
			repetition,
			success: false,
			errorKind: safeErrorKind(error),
			response: "",
			finishReason: "error",
			answerUsage: null,
			summaryUsage,
			answerAttemptCount,
			summaryCallCount,
			summaryRetryCount,
			firstTextMs,
			answerCompletionMs: Math.max(0, completedAt - start - summaryDurationMs),
			totalCompletionMs: completedAt - start,
			cost: costs.length > 0 ? combineCosts(costs) : null,
			automaticChecks: runAutomaticChecks("", testCase),
		};
	}
}

export async function runEvaluation(
	options: RunnerOptions,
): Promise<EvaluationArtifact> {
	const now = options.now ?? new Date();
	validateSuite(options.suite);
	validatePriceCoverage(options.suite, options.prices);
	assertFreshPricing(options.prices, now);
	const upperBound = estimateSuiteUpperBound(options.suite, options.prices);
	if (upperBound > options.suite.budgetUsd) {
		throw new Error(
			`planned worst-case cost ${upperBound.toFixed(4)} USD exceeds budget`,
		);
	}
	for (const provider of ["gemini", "openai"] as const) {
		if (!options.apiKeys[provider]?.trim()) {
			throw new Error(`missing local API key for ${provider}`);
		}
	}
	const gateways = new Map<EvalProvider, ILlmGateway>();
	for (const provider of ["gemini", "openai"] as const) {
		gateways.set(
			provider,
			options.gatewayFactory(provider, options.apiKeys[provider]),
		);
	}
	await probeTargets(options.suite, gateways);

	const results: EvalRunResult[] = [];
	const budget = new BudgetTracker(options.suite.budgetUsd);
	let abortedReason: string | undefined;
	outer: for (
		let repetition = 1;
		repetition <= options.suite.repetitions;
		repetition++
	) {
		for (const testCase of options.suite.cases) {
			for (const candidate of orderedCandidates(
				options.suite.candidates,
				options.suite.seed,
				testCase.id,
				repetition,
			)) {
				options.onProgress?.(
					`${testCase.id} repetition ${repetition} ${candidate.id}`,
				);
				const result = await runOne(
					options.suite,
					options.prices,
					candidate,
					testCase,
					repetition,
					gateways,
					budget,
				);
				results.push(result);
				if (!result.answerUsage) {
					abortedReason =
						result.errorKind === "budget_limit"
							? "The next request could exceed the approved budget; it and later calls were not started."
							: result.errorKind === "summary_input_limit"
								? "A summary input exceeded the pre-priced limit; later calls were not started."
								: "A request failed or completed without usable usage data; later calls were not started and its cost is unknown.";
					break outer;
				}
			}
		}
	}
	return {
		schemaVersion: 1,
		createdAt: now.toISOString(),
		gitCommit: options.gitCommit,
		suiteVersion: options.suite.version,
		suiteHash: suiteHash(options.suite),
		seed: options.suite.seed,
		promptHashes: promptHashes(options.suite),
		pricingVersion: options.prices.version,
		pricingEffectiveDate: options.prices.effectiveDate,
		candidates: options.suite.candidates,
		providerSdkVersions: options.providerSdkVersions,
		executionOrder: "serial_deterministic_seed",
		cachePolicy: "provider_reported_only_no_evaluation_managed_cache",
		repetitions: options.suite.repetitions,
		maxOutputTokens: options.suite.maxOutputTokens,
		budgetUsd: options.suite.budgetUsd,
		results,
		...(abortedReason ? { abortedReason } : {}),
	};
}
