import type { LlmUsage } from "../../src/llm/types";
import { nearestRankPercentile } from "../llm-eval/scoring";
import type { AnswerPath, PathResult } from "./paths";

type Distribution = Record<string, number>;

function count(into: Distribution, key: string | number, by = 1): void {
	into[String(key)] = (into[String(key)] ?? 0) + by;
}

function percentiles(values: number[]) {
	return {
		count: values.length,
		p50: nearestRankPercentile(values, 0.5),
		p95: nearestRankPercentile(values, 0.95),
	};
}

function outcomeKey(result: PathResult): string {
	return result.outcome.kind;
}

function sumUsage(results: PathResult[], rounds: boolean) {
	const total = {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		unknownUsageRequests: 0,
	};
	const add = (usage: LlmUsage | null) => {
		if (
			!usage ||
			usage.inputTokens === null ||
			usage.cachedInputTokens === null ||
			usage.outputTokens === null ||
			usage.reasoningTokens === null ||
			usage.totalTokens === null
		) {
			total.unknownUsageRequests++;
			return;
		}
		total.inputTokens += usage.inputTokens;
		total.cachedInputTokens += usage.cachedInputTokens;
		total.outputTokens += usage.outputTokens;
		total.reasoningTokens += usage.reasoningTokens;
		total.totalTokens += usage.totalTokens;
	};
	for (const result of results) {
		if (rounds) for (const round of result.rounds) add(round.usage);
		else if (result.rounds.length === 0 && result.attempts > 0)
			add(result.usage);
	}
	return total;
}

export function summarizePath(results: PathResult[]) {
	const outcomes: Distribution = {};
	const budgetReasons: Distribution = {};
	const technicalFailures: Distribution = {};
	const toolOutcomes: Distribution = {};
	const roundsDistribution: Distribution = {};
	const toolCallsDistribution: Distribution = {};
	const categories: Record<string, { count: number; outcomes: Distribution }> =
		{};
	for (const result of results) {
		count(outcomes, outcomeKey(result));
		if (result.outcome.kind === "budget_exceeded")
			count(budgetReasons, result.outcome.reason);
		if (result.outcome.kind === "technical_failure")
			count(
				technicalFailures,
				`${result.outcome.service}:${result.outcome.operation}:${result.outcome.status ?? "none"}`,
			);
		for (const [name, value] of Object.entries(result.toolOutcomes))
			count(toolOutcomes, name, value);
		count(roundsDistribution, result.rounds.length);
		count(toolCallsDistribution, result.toolCallCount);
		categories[result.category] ??= { count: 0, outcomes: {} };
		const category = categories[result.category];
		category.count++;
		count(category.outcomes, outcomeKey(result));
	}
	const answered = results.filter((r) => r.outcome.kind === "answered");
	const costs = results.map((r) => r.costUsd);
	const costSum = costs.reduce((total, cost) => total + cost, 0);
	return {
		questionCount: results.length,
		outcomes,
		budgetReasons,
		technicalFailures,
		categories,
		toolOutcomes,
		roundsDistribution,
		toolCallsDistribution,
		latencyMs: {
			total: percentiles(results.map((r) => r.totalMs)),
			answeredTotal: percentiles(answered.map((r) => r.totalMs)),
			firstFinalText: percentiles(
				results.flatMap((r) =>
					r.firstFinalTextMs === null ? [] : [r.firstFinalTextMs],
				),
			),
		},
		tokens: sumUsage(
			results,
			results.some((r) => r.rounds.length > 0),
		),
		costUsd: {
			sum: costSum,
			mean: results.length ? costSum / results.length : 0,
			max: Math.max(0, ...costs),
			estimatedQuestions: results.filter((r) => r.costKind === "estimated")
				.length,
		},
		maxBytes: {
			state: Math.max(0, ...results.map((r) => r.maxStateBytes)),
			toolResult: Math.max(0, ...results.map((r) => r.maxToolResultBytes)),
			roundOutput: Math.max(0, ...results.map((r) => r.maxRoundOutputBytes)),
		},
	};
}

/** Acceptance flags for G1; null when the tools path never ran. */
export function acceptanceFlags(toolResults: PathResult[]) {
	if (toolResults.length === 0)
		return {
			schemaAccepted: null,
			continuationObserved: null,
			usageAlwaysPresent: null,
		};
	const rounds = toolResults.map((r) => r.rounds);
	const responded = rounds.flat().filter((round) => round.responded);
	return {
		schemaAccepted: rounds.some((list) => list[0]?.responded === true),
		continuationObserved: rounds.some((list) =>
			list.some(
				(round, index) =>
					round.finishReason === "tool_calls" &&
					list[index + 1]?.responded === true &&
					["stop", "tool_calls"].includes(list[index + 1].finishReason),
			),
		),
		usageAlwaysPresent:
			responded.length > 0 &&
			responded.every(
				({ usage }) =>
					usage !== null &&
					usage.inputTokens !== null &&
					usage.cachedInputTokens !== null &&
					usage.outputTokens !== null &&
					usage.reasoningTokens !== null &&
					usage.totalTokens !== null,
			),
	};
}

export type SummaryMeta = {
	snapshotSha256: string;
	gitCommit: string;
	model: string;
	priceVersion: string;
	priceEffectiveDate: string;
	mode: string;
	maxUsd: number;
	spentUsd: number;
	questionDate: string | null;
};

export function buildSummary(results: PathResult[], meta: SummaryMeta) {
	const byPath = (path: AnswerPath) => results.filter((r) => r.path === path);
	const paths: Partial<Record<AnswerPath, ReturnType<typeof summarizePath>>> =
		{};
	for (const path of ["legacy", "tools"] as const)
		if (byPath(path).length > 0) paths[path] = summarizePath(byPath(path));
	return {
		schemaVersion: 1,
		...meta,
		paths,
		g1Acceptance: acceptanceFlags(byPath("tools")),
	};
}
