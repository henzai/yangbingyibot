import type { AnswerLimits } from "../../sheets/answers/contracts";

/**
 * Per-question budget for the sheet tool path. Fixed in code, not env vars:
 * these start from the provisional design budget (#513: 100 s / 8 tool calls /
 * 9 model rounds / 32 KiB per result / 128 KiB cumulative) and must be
 * recalibrated from measured representative questions (work item G).
 */
export const SHEET_TOOL_LIMITS = Object.freeze({
	/** From prepareSheetTools to the end of final Discord delivery. */
	questionDeadlineMs: 100_000,
	/** The last model round and its tool calls must finish by this offset. */
	toolPhaseDeadlineMs: 85_000,
	/** A round needs at least this much time left to start. */
	minRoundMs: 5_000,
	maxModelRounds: 9,
	maxToolCalls: 8,
	/** One serialized tool output, including the budget envelope. */
	maxToolResultBytes: 33 * 1024,
	maxCumulativeToolResultBytes: 128 * 1024,
	/** Opaque continuation state; keeps each round checkpoint under 1 MiB. */
	maxStateBytes: 640 * 1024,
	maxOutputTokensPerRound: 16_000,
	/** Sum of provider-reported totalTokens over all rounds. */
	maxTotalTokens: 600_000,
	/** Code-rendered list/aggregate attachment (work item D collector). */
	render: Object.freeze({
		maxPages: 20,
		maxResultBytes: 256 * 1024,
		maxChunks: 8,
		chunkLimit: 2000,
	}) satisfies Required<AnswerLimits>,
});

/** Step-level timeouts sit above the shared deadline, never below it. */
export const SHEET_TOOL_STEP_TIMEOUTS = Object.freeze({
	prepare: "30 seconds",
	round: "95 seconds",
	deliver: "30 seconds",
});

export type SheetToolBudgetReason =
	| "deadline"
	| "model_rounds"
	| "tool_calls"
	| "tool_result_bytes"
	| "state_bytes"
	| "output_tokens"
	| "total_tokens"
	| "usage_unavailable";
