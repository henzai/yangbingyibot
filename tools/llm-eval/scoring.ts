import type {
	AutomaticChecks,
	CandidateSummary,
	EvalCase,
	EvalCaseSummary,
	EvalMetrics,
	EvalRunResult,
	EvalSummary,
	ManualJudgment,
} from "./types";

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("ja").replaceAll(/\s/gu, "");
}

export function runAutomaticChecks(
	response: string,
	testCase: EvalCase,
): AutomaticChecks {
	const text = normalized(response);
	const requiredTermsPresent = testCase.expectation.requiredTermGroups.every(
		(group) => group.some((term) => text.includes(normalized(term))),
	);
	const forbiddenTermsAbsent = testCase.expectation.forbiddenTerms.every(
		(term) => !text.includes(normalized(term)),
	);
	const behaviorSignals = {
		answer: [],
		clarify: ["どちら", "特定", "確認", "詳しく"],
		abstain: [
			"情報がありません",
			"確認できません",
			"記載されていません",
			"わかりません",
			"根拠がありません",
		],
	};
	const signals = behaviorSignals[testCase.expectation.behavior];
	const behaviorSignalPresent =
		signals.length === 0 || signals.some((signal) => text.includes(signal));
	const japanesePresent = /[ぁ-んァ-ヶ一-龠]/u.test(response);
	const timelineFormatPresent =
		testCase.expectation.format === "timeline"
			? /(?:^|\n)\s*[-*・]\s*.*(?:19|20)\d{2}/u.test(response)
			: null;
	return {
		requiredTermsPresent,
		forbiddenTermsAbsent,
		behaviorSignalPresent,
		japanesePresent,
		timelineFormatPresent,
	};
}

export function nearestRankPercentile(
	values: number[],
	percentile: number,
): number {
	if (values.length === 0) return 0;
	if (percentile <= 0 || percentile > 1) {
		throw new Error("percentile must be greater than 0 and at most 1");
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function rate(values: boolean[]): number {
	if (values.length === 0) return 1;
	return values.filter(Boolean).length / values.length;
}

type CompletedManualJudgment = Omit<
	ManualJudgment,
	| "identityCorrect"
	| "unsupportedPersonOrBiography"
	| "supportedFacts"
	| "behaviorCorrect"
	| "formatCorrect"
> & {
	identityCorrect: boolean;
	unsupportedPersonOrBiography: boolean;
	supportedFacts: boolean;
	behaviorCorrect: boolean;
	formatCorrect: boolean;
};

function requireJudgment(
	judgments: Map<string, ManualJudgment>,
	result: EvalRunResult,
): CompletedManualJudgment {
	const judgment = judgments.get(result.runId);
	if (
		!judgment ||
		judgment.identityCorrect === null ||
		judgment.unsupportedPersonOrBiography === null ||
		judgment.supportedFacts === null ||
		judgment.behaviorCorrect === null ||
		judgment.formatCorrect === null
	) {
		throw new Error(`manual judgment is incomplete for ${result.runId}`);
	}
	return {
		...judgment,
		identityCorrect: judgment.identityCorrect,
		unsupportedPersonOrBiography: judgment.unsupportedPersonOrBiography,
		supportedFacts: judgment.supportedFacts,
		behaviorCorrect: judgment.behaviorCorrect,
		formatCorrect: judgment.formatCorrect,
	};
}

function summarizeMetrics(
	results: EvalRunResult[],
	judgments: Map<string, ManualJudgment>,
): EvalMetrics {
	const successful = results.filter(({ success }) => success);
	const graded = successful.map((result) => ({
		result,
		judgment: requireJudgment(judgments, result),
	}));
	const deferrals = graded.filter(
		({ result }) =>
			result.category === "ambiguous" || result.category === "unknown",
	);
	const personMixupRate = rate(
		graded.map(({ judgment }) => !judgment.identityCorrect),
	);
	const unsupportedPersonOrBiographyCount = graded.filter(
		({ judgment }) => judgment.unsupportedPersonOrBiography,
	).length;
	const groundedAnswerRate = rate(
		graded.map(
			({ judgment, result }) =>
				judgment.supportedFacts &&
				result.automaticChecks.requiredTermsPresent &&
				result.automaticChecks.forbiddenTermsAbsent,
		),
	);
	const appropriateDeferralRate = rate(
		deferrals.map(
			({ judgment, result }) =>
				judgment.behaviorCorrect &&
				result.automaticChecks.behaviorSignalPresent,
		),
	);
	const formatPassRate = rate(
		graded.map(
			({ judgment, result }) =>
				judgment.formatCorrect &&
				result.automaticChecks.japanesePresent &&
				result.automaticChecks.timelineFormatPresent !== false,
		),
	);
	const failureRate = 1 - successful.length / results.length;
	const firstText = successful.flatMap(({ firstTextMs }) =>
		firstTextMs === null ? [] : [firstTextMs],
	);
	return {
		runCount: results.length,
		personMixupRate,
		unsupportedPersonOrBiographyCount,
		groundedAnswerRate,
		appropriateDeferralRate,
		formatPassRate,
		failureRate,
		medianFirstTextMs: median(firstText),
		p95FirstTextMs: nearestRankPercentile(firstText, 0.95),
		medianAnswerCompletionMs: median(
			successful.map(({ answerCompletionMs }) => answerCompletionMs),
		),
		p95AnswerCompletionMs: nearestRankPercentile(
			successful.map(({ answerCompletionMs }) => answerCompletionMs),
			0.95,
		),
		medianTotalCompletionMs: median(
			successful.map(({ totalCompletionMs }) => totalCompletionMs),
		),
		p95TotalCompletionMs: nearestRankPercentile(
			successful.map(({ totalCompletionMs }) => totalCompletionMs),
			0.95,
		),
		medianCostUsd: median(
			successful.flatMap(({ cost }) =>
				cost === null ? [] : [cost.totalEstimatedUsd],
			),
		),
	};
}

function summarizeCandidate(
	results: EvalRunResult[],
	judgments: Map<string, ManualJudgment>,
	baselineP95: number | null,
): CandidateSummary {
	const metrics = summarizeMetrics(results, judgments);
	const failedGates: string[] = [];
	if (metrics.personMixupRate !== 0) failedGates.push("person_mixup");
	if (metrics.unsupportedPersonOrBiographyCount !== 0) {
		failedGates.push("unsupported_person_or_biography");
	}
	if (metrics.groundedAnswerRate < 0.95) failedGates.push("grounded_answer");
	if (metrics.appropriateDeferralRate < 1) {
		failedGates.push("appropriate_deferral");
	}
	if (metrics.formatPassRate < 0.9) failedGates.push("format");
	if (metrics.failureRate > 0.05) failedGates.push("failure_rate");
	if (
		baselineP95 !== null &&
		metrics.p95TotalCompletionMs > baselineP95 * 1.5
	) {
		failedGates.push("completion_latency");
	}
	const cases: EvalCaseSummary[] = [
		...Map.groupBy(results, ({ caseId }) => caseId),
	]
		.map(([caseId, caseResults]) => ({
			caseId,
			...summarizeMetrics(caseResults, judgments),
		}))
		.sort((left, right) => left.caseId.localeCompare(right.caseId));
	return {
		candidateId: results[0].candidateId,
		...metrics,
		cases,
		passesQualityGate: failedGates.length === 0,
		failedGates,
	};
}

export function summarizeEvaluation(
	results: EvalRunResult[],
	manualJudgments: ManualJudgment[],
	baselineCandidateId: string,
): EvalSummary {
	const judgments = new Map(
		manualJudgments.map((judgment) => [judgment.runId, judgment]),
	);
	const groups = Map.groupBy(results, ({ candidateId }) => candidateId);
	const baselineResults = groups.get(baselineCandidateId);
	if (!baselineResults?.length) throw new Error("baseline results are missing");
	const baselineP95 = nearestRankPercentile(
		baselineResults.flatMap(({ success, totalCompletionMs }) =>
			success ? [totalCompletionMs] : [],
		),
		0.95,
	);
	const candidates = [...groups.values()].map((candidateResults) =>
		summarizeCandidate(candidateResults, judgments, baselineP95),
	);
	const passing = candidates.filter(
		({ passesQualityGate }) => passesQualityGate,
	);
	if (passing.length === 0) {
		return {
			candidates,
			recommendedCandidateId: baselineCandidateId,
			recommendationReason:
				"No candidate passed every pre-registered quality gate; keep Gemini.",
		};
	}
	passing.sort((a, b) => {
		const lowerCost = Math.min(a.medianCostUsd, b.medianCostUsd);
		const costDifference =
			lowerCost === 0
				? Math.abs(a.medianCostUsd - b.medianCostUsd)
				: Math.abs(a.medianCostUsd - b.medianCostUsd) / lowerCost;
		return costDifference <= 0.1
			? a.p95FirstTextMs - b.p95FirstTextMs
			: a.medianCostUsd - b.medianCostUsd;
	});
	return {
		candidates,
		recommendedCandidateId: passing[0].candidateId,
		recommendationReason:
			"Selected the lowest-cost passing candidate; candidates within 10% cost are ordered by p95 first-text latency.",
	};
}
