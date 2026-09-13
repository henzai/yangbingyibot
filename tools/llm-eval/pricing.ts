import type { LlmUsage } from "../../src/llm/types";
import { buildPrompt, promptBytes } from "./suite";
import type {
	CandidateConfig,
	EvalCallCost,
	EvalSuite,
	PriceCatalog,
	PriceCatalogEntry,
} from "./types";

const MILLION = 1_000_000;
const MAX_PROVIDER_ATTEMPTS = 2;
const MAX_SUMMARY_INPUT_BYTES = 65_536;
const SUMMARY_OUTPUT_TOKENS = 128;

export function assertFreshPricing(
	catalog: PriceCatalog,
	now = new Date(),
): void {
	const effective = new Date(`${catalog.effectiveDate}T00:00:00Z`);
	if (Number.isNaN(effective.getTime())) {
		throw new Error("price catalog effectiveDate is invalid");
	}
	const ageDays = (now.getTime() - effective.getTime()) / 86_400_000;
	// A snapshot dated in the operator's local timezone may be less than one UTC
	// day ahead of the process clock.
	if (ageDays < -1 || ageDays > catalog.maxAgeDays) {
		throw new Error(
			`price catalog is stale: ${catalog.effectiveDate} (maximum ${catalog.maxAgeDays} days)`,
		);
	}
}

export function findPrice(
	catalog: PriceCatalog,
	provider: string,
	model: string,
): PriceCatalogEntry {
	const price = catalog.entries.find(
		(entry) => entry.provider === provider && entry.model === model,
	);
	if (!price) throw new Error(`price catalog is missing ${provider}:${model}`);
	return price;
}

export function calculateObservedCost(
	usage: LlmUsage | null,
	price: PriceCatalogEntry,
): number | null {
	if (
		!usage ||
		usage.inputTokens === null ||
		usage.cachedInputTokens === null ||
		usage.outputTokens === null ||
		usage.reasoningTokens === null
	) {
		return null;
	}
	const cachedInput = Math.min(usage.inputTokens, usage.cachedInputTokens);
	const regularInput = usage.inputTokens - cachedInput;
	return (
		(regularInput * price.inputPerMillionUsd +
			cachedInput * price.cachedInputPerMillionUsd +
			usage.outputTokens * price.outputPerMillionUsd +
			usage.reasoningTokens * price.reasoningPerMillionUsd) /
		MILLION
	);
}

export function calculateUsageCost(
	usage: LlmUsage | null,
	price: PriceCatalogEntry,
): Pick<EvalCallCost, "observedUsageUsd" | "missingUsageEstimateUsd"> | null {
	if (!usage || usage.inputTokens === null || usage.inputTokens < 0)
		return null;
	if (
		usage.cachedInputTokens !== null &&
		(usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens)
	) {
		return null;
	}
	if (usage.outputTokens !== null && usage.outputTokens < 0) return null;
	if (usage.reasoningTokens !== null && usage.reasoningTokens < 0) return null;

	const cachedInput = usage.cachedInputTokens ?? 0;
	const observedInputUsd =
		usage.cachedInputTokens === null
			? 0
			: ((usage.inputTokens - cachedInput) * price.inputPerMillionUsd +
					cachedInput * price.cachedInputPerMillionUsd) /
				MILLION;
	const estimatedInputUsd =
		usage.cachedInputTokens === null
			? (usage.inputTokens * price.inputPerMillionUsd) / MILLION
			: 0;

	const knownOutputTokens = usage.outputTokens ?? 0;
	const knownReasoningTokens = usage.reasoningTokens ?? 0;
	let missingGeneratedTokens = 0;
	if (usage.outputTokens === null || usage.reasoningTokens === null) {
		if (
			usage.totalTokens === null ||
			price.outputPerMillionUsd !== price.reasoningPerMillionUsd
		) {
			return null;
		}
		missingGeneratedTokens =
			usage.totalTokens -
			usage.inputTokens -
			knownOutputTokens -
			knownReasoningTokens;
		if (missingGeneratedTokens < 0) return null;
	}

	return {
		observedUsageUsd:
			observedInputUsd +
			(knownOutputTokens * price.outputPerMillionUsd +
				knownReasoningTokens * price.reasoningPerMillionUsd) /
				MILLION,
		missingUsageEstimateUsd:
			estimatedInputUsd +
			(missingGeneratedTokens * price.outputPerMillionUsd) / MILLION,
	};
}

export function estimateRequestUpperBound(
	inputBytes: number,
	maxOutputTokens: number,
	price: PriceCatalogEntry,
): number {
	return (
		(inputBytes * price.inputPerMillionUsd +
			maxOutputTokens *
				Math.max(price.outputPerMillionUsd, price.reasoningPerMillionUsd)) /
		MILLION
	);
}

export function calculateCallCost(
	usage: LlmUsage,
	attemptCount: number,
	inputBytes: number,
	maxOutputTokens: number,
	price: PriceCatalogEntry,
): EvalCallCost {
	const usageCost = calculateUsageCost(usage, price);
	if (usageCost === null) {
		throw new Error("usage is incomplete; stopping to avoid an unknown cost");
	}
	const retryCount = Math.max(0, attemptCount - 1);
	const retryReserveUsd =
		retryCount * estimateRequestUpperBound(inputBytes, maxOutputTokens, price);
	const hasUsageEstimate = usageCost.missingUsageEstimateUsd > 0;
	const hasRetryEstimate = retryReserveUsd > 0;
	return {
		...usageCost,
		retryReserveUsd,
		totalEstimatedUsd:
			usageCost.observedUsageUsd +
			usageCost.missingUsageEstimateUsd +
			retryReserveUsd,
		kind:
			hasUsageEstimate && hasRetryEstimate
				? "observed_plus_usage_and_retry_estimate"
				: hasUsageEstimate
					? "observed_plus_usage_estimate"
					: hasRetryEstimate
						? "observed_plus_retry_estimate"
						: "observed",
	};
}

function candidateWorstCase(
	suite: EvalSuite,
	candidate: CandidateConfig,
	catalog: PriceCatalog,
): number {
	const answerPrice = findPrice(catalog, candidate.provider, candidate.model);
	const answerCost = suite.cases.reduce(
		(total, testCase) =>
			total +
			estimateRequestUpperBound(
				promptBytes(buildPrompt(suite, testCase)),
				suite.maxOutputTokens,
				answerPrice,
			) *
				MAX_PROVIDER_ATTEMPTS *
				suite.repetitions,
		0,
	);
	if (!candidate.summary) return answerCost;
	const summaryPrice = findPrice(
		catalog,
		candidate.summary.provider,
		candidate.summary.model,
	);
	const summaryCost =
		estimateRequestUpperBound(
			MAX_SUMMARY_INPUT_BYTES,
			SUMMARY_OUTPUT_TOKENS,
			summaryPrice,
		) *
		MAX_PROVIDER_ATTEMPTS *
		suite.maxSummaryCallsPerAnswer *
		suite.cases.length *
		suite.repetitions;
	return answerCost + summaryCost;
}

export function estimateSuiteUpperBound(
	suite: EvalSuite,
	catalog: PriceCatalog,
): number {
	return suite.candidates.reduce(
		(total, candidate) => total + candidateWorstCase(suite, candidate, catalog),
		0,
	);
}

export const pricingConstants = {
	maxProviderAttempts: MAX_PROVIDER_ATTEMPTS,
	maxSummaryInputBytes: MAX_SUMMARY_INPUT_BYTES,
	summaryOutputTokens: SUMMARY_OUTPUT_TOKENS,
} as const;
