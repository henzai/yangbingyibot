import type { LlmMessage, LlmUsage } from "../../src/llm/types";

export type EvalProvider = "gemini" | "openai";

export type CandidateConfig = {
	id: string;
	label: string;
	provider: EvalProvider;
	model: string;
	temperature: 0 | null;
	reasoningSetting: "provider_default";
	summary: {
		provider: EvalProvider;
		model: string;
	} | null;
};

export type EvalExpectation = {
	behavior: "answer" | "clarify" | "abstain";
	requiredTermGroups: string[][];
	forbiddenTerms: string[];
	format: "plain" | "timeline";
};

export type EvalCase = {
	id: string;
	category:
		| "numeric_alias"
		| "similar_name"
		| "ambiguous"
		| "unknown"
		| "conversation"
		| "japanese_format"
		| "long_context";
	question: string;
	history: LlmMessage[];
	expectation: EvalExpectation;
};

export type EvalSuite = {
	version: string;
	promptVersion: string;
	seed: string;
	description: string;
	knowledge: string;
	repetitions: number;
	maxOutputTokens: number;
	maxPromptBytes: number;
	maxSummaryCallsPerAnswer: number;
	budgetUsd: number;
	candidates: CandidateConfig[];
	cases: EvalCase[];
};

export type PriceCatalogEntry = {
	provider: EvalProvider;
	model: string;
	inputPerMillionUsd: number;
	cachedInputPerMillionUsd: number;
	outputPerMillionUsd: number;
	/** Gemini and OpenAI both bill reasoning at the output rate here. */
	reasoningPerMillionUsd: number;
};

export type PriceCatalog = {
	version: string;
	effectiveDate: string;
	currency: "USD";
	maxAgeDays: number;
	sources: string[];
	entries: PriceCatalogEntry[];
};

export type AutomaticChecks = {
	requiredTermsPresent: boolean;
	forbiddenTermsAbsent: boolean;
	behaviorSignalPresent: boolean;
	japanesePresent: boolean;
	timelineFormatPresent: boolean | null;
};

export type EvalCallCost = {
	observedUsageUsd: number;
	retryReserveUsd: number;
	totalEstimatedUsd: number;
	kind: "observed" | "observed_plus_retry_estimate";
};

export type EvalRunResult = {
	runId: string;
	candidateId: string;
	blindedCandidateId: string;
	caseId: string;
	category: EvalCase["category"];
	repetition: number;
	success: boolean;
	errorKind?: string;
	response: string;
	finishReason: string;
	answerUsage: LlmUsage | null;
	summaryUsage: LlmUsage | null;
	answerAttemptCount: number;
	summaryCallCount: number;
	summaryRetryCount: number;
	firstTextMs: number | null;
	answerCompletionMs: number;
	totalCompletionMs: number;
	cost: EvalCallCost | null;
	automaticChecks: AutomaticChecks;
};

export type EvaluationArtifact = {
	schemaVersion: 1;
	createdAt: string;
	gitCommit: string;
	suiteVersion: string;
	suiteHash: string;
	seed: string;
	promptHashes: Record<string, string>;
	pricingVersion: string;
	pricingEffectiveDate: string;
	candidates: CandidateConfig[];
	providerSdkVersions: Record<EvalProvider, string>;
	executionOrder: "serial_deterministic_seed";
	cachePolicy: "provider_reported_only_no_evaluation_managed_cache";
	repetitions: number;
	maxOutputTokens: number;
	budgetUsd: number;
	results: EvalRunResult[];
	abortedReason?: string;
};

export type ManualJudgment = {
	runId: string;
	identityCorrect: boolean | null;
	unsupportedPersonOrBiography: boolean | null;
	supportedFacts: boolean | null;
	behaviorCorrect: boolean | null;
	formatCorrect: boolean | null;
	notes: string;
};

export type ManualJudgmentArtifact = {
	schemaVersion: 1;
	suiteHash: string;
	judgments: ManualJudgment[];
};

export type EvalMetrics = {
	runCount: number;
	personMixupRate: number;
	unsupportedPersonOrBiographyCount: number;
	groundedAnswerRate: number;
	appropriateDeferralRate: number;
	formatPassRate: number;
	failureRate: number;
	medianFirstTextMs: number;
	p95FirstTextMs: number;
	medianAnswerCompletionMs: number;
	p95AnswerCompletionMs: number;
	medianTotalCompletionMs: number;
	p95TotalCompletionMs: number;
	medianCostUsd: number;
};

export type EvalCaseSummary = EvalMetrics & {
	caseId: string;
};

export type CandidateSummary = EvalMetrics & {
	candidateId: string;
	cases: EvalCaseSummary[];
	passesQualityGate: boolean;
	failedGates: string[];
};

export type EvalSummary = {
	candidates: CandidateSummary[];
	recommendedCandidateId: string;
	recommendationReason: string;
};
