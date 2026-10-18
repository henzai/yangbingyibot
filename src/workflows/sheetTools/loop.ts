import type { HistoryEntry } from "../../contracts";
import type {
	DeliveryResult,
	DeliveryStatus,
	DiscordDeliveryService,
} from "../../discord/delivery";
import {
	formatAnswer,
	formatThinking,
	normalizeDiscordText,
	splitContent,
} from "../../discord/formatter";
import { buildSheetToolPrompt } from "../../llm/promptBuilder";
import type {
	ILlmGateway,
	LlmFinish,
	LlmStreamEvent,
	LlmUsage,
} from "../../llm/types";
import { addLlmUsage, zeroUsage } from "../../llm/usage";
import type { PreparedSheetAnswer } from "../../sheets/answers/contracts";
import { tokyoDay } from "../../sheets/search/cells";
import type { SheetSearchEngine } from "../../sheets/search/engine";
import type { SheetSnapshotRef } from "../../sheets/snapshot";
import { ExternalServiceError } from "../../utils/errors";
import type { Logger } from "../../utils/logger";
import type { RetryConfig } from "../../utils/retry";
import { SHEET_TOOL_LIMITS, type SheetToolBudgetReason } from "./limits";
import {
	catalogText,
	executeToolCall,
	prepareAttachment,
	SHEET_TOOL_DEFINITIONS,
	type SheetToolAttachment,
	type ToolOutcome,
} from "./tools";

const BUDGET_USER_MESSAGE =
	"検索の上限（時間・回数・データ量）に達したため、回答を完成できませんでした。対象や条件を絞って、もう一度お試しください。";
const TECHNICAL_USER_MESSAGE =
	"シートの検索中に問題が発生したため、回答を作成できませんでした。";
const EMPTY_USER_MESSAGE = "AIから有効な応答が得られませんでした。";
const BLOCKED_USER_MESSAGE = "安全性フィルタにより回答できませんでした。";
const ATTACHMENT_LEAD = "シートから確認した結果は以下のとおりです。";
const PROGRESS_TEXT = "シートを確認しています…";

/** Budget exhaustion is its own outcome; it is never reported as an answer. */
export class SheetToolBudgetError extends ExternalServiceError {
	readonly reason: SheetToolBudgetReason;

	constructor(reason: SheetToolBudgetReason) {
		super({
			service: "llm",
			operation: `sheet tool budget ${reason}`,
			retryable: false,
			userMessage: BUDGET_USER_MESSAGE,
		});
		this.name = "SheetToolBudgetError";
		this.reason = reason;
	}
}

function technical(
	service: "llm" | "sheets",
	operation: string,
	userMessage = TECHNICAL_USER_MESSAGE,
): ExternalServiceError {
	return new ExternalServiceError({
		service,
		operation,
		retryable: false,
		userMessage,
	});
}

function bytes(value: unknown): number {
	return new TextEncoder().encode(
		typeof value === "string" ? value : JSON.stringify(value),
	).byteLength;
}

export type SheetToolPrepareOutput = {
	/** Shared deadline origin, persisted so replay never extends the budget. */
	startedAt: number;
	/** Asia/Tokyo date fixed once; reused by every engine reopen. */
	questionDate: string;
	snapshotRef: SheetSnapshotRef;
	/** The pinned snapshot's description; small, unlike the structured sheet. */
	description: string;
	catalog: string;
};

export type SheetToolTotals = {
	rounds: number;
	toolCalls: number;
	toolResultBytes: number;
	totalTokens: number;
	usage: LlmUsage;
	attempts: number;
	modelDurationMs: number;
	searchDurationMs: number;
	outcomes: Record<ToolOutcome, number>;
};

export type SheetToolRoundMetrics = {
	round: number;
	usage: LlmUsage | null;
	attempts: number;
	durationMs: number;
	/** From this round's start; null when the round produced no text. */
	firstTextDurationMs: number | null;
	finishReason: LlmFinish["reason"];
	toolCallCount: number;
};

type RoundBase = {
	round: number;
	totals: SheetToolTotals;
	attachment: SheetToolAttachment | null;
	metrics: SheetToolRoundMetrics;
};

export type SheetToolRoundOutput =
	| (RoundBase & {
			kind: "tools";
			/** Opaque provider state; never logged or inspected here. */
			state: Extract<LlmStreamEvent, { type: "tool_calls" }>["state"];
			results: { callId: string; output: string }[];
	  })
	| (RoundBase & {
			kind: "final";
			/** Final answer text only; interim tool-round text is never kept. */
			text: string;
			/** From startedAt to the final round's first text delta. */
			finalFirstTextMs: number | null;
	  });

export type SheetToolDeliveryOutput = {
	deliveryStatus: DeliveryStatus;
	editCount: number;
	chunkCount: number;
	failedChunks: number[];
	retryCount: number;
	statusCode?: number;
	deliveryDurationMs: number;
	attachmentStatus: "none" | "unsent" | "partial" | "complete";
	/** Only IDs from confirmed, unchanged rendered chunks. */
	deliveredIds: string[];
	/** Final text plus confirmed rendered chunks, for conversation history. */
	historyText: string;
};

export type OpenEngine = (
	prepared: Pick<SheetToolPrepareOutput, "snapshotRef" | "questionDate">,
	options: { deliveredIds: readonly string[]; signal?: AbortSignal },
) => Promise<SheetSearchEngine>;

export type SheetToolDeps = {
	gateway: ILlmGateway;
	model: string;
	openEngine: OpenEngine;
	/** A delivery service whose transport and retries stop at `signal`. */
	delivery(
		signal: AbortSignal,
		retryConfig?: Partial<RetryConfig>,
	): DiscordDeliveryService;
	log: Logger;
	now?: () => number;
};

function emptyTotals(): SheetToolTotals {
	return {
		rounds: 0,
		toolCalls: 0,
		toolResultBytes: 0,
		totalTokens: 0,
		usage: zeroUsage(),
		attempts: 0,
		modelDurationMs: 0,
		searchDurationMs: 0,
		outcomes: { ok: 0, zero: 0, ambiguous: 0, missing: 0, error: 0 },
	};
}

export async function prepareSheetToolsStep(
	deps: Pick<SheetToolDeps, "openEngine" | "now">,
	snapshotRef: SheetSnapshotRef | undefined,
): Promise<SheetToolPrepareOutput> {
	const now = deps.now ?? Date.now;
	// No silent legacy fallback: without a pinned snapshot the tool path fails.
	if (!snapshotRef) throw technical("sheets", "pin sheet tool snapshot");
	const startedAt = now();
	const questionDate = tokyoDay(startedAt);
	const engine = await deps.openEngine(
		{ snapshotRef, questionDate },
		{ deliveredIds: [] },
	);
	return {
		startedAt,
		questionDate,
		snapshotRef,
		description: engine.description,
		catalog: catalogText(engine),
	};
}

export type SheetToolRoundInput = {
	round: number;
	question: string;
	prepared: SheetToolPrepareOutput;
	history: readonly HistoryEntry[];
	deliveredIds: readonly string[];
	previous: SheetToolRoundOutput | null;
};

/**
 * One model call plus the tool calls it requested, as one checkpointed step.
 * Replay reruns only an unfinished round, on the same snapshot and date.
 */
export async function runSheetToolRound(
	deps: SheetToolDeps,
	input: SheetToolRoundInput,
	onMetrics?: (metrics: SheetToolRoundMetrics) => void,
): Promise<SheetToolRoundOutput> {
	const limits = SHEET_TOOL_LIMITS;
	const now = deps.now ?? Date.now;
	const { prepared, round, previous } = input;
	if (round > limits.maxModelRounds)
		throw new SheetToolBudgetError("model_rounds");
	if ((round === 1) !== (previous === null) || previous?.kind === "final")
		throw technical("llm", "sequence sheet tool rounds");
	const totals = structuredClone(previous?.totals ?? emptyTotals());
	let attachment = previous?.attachment ?? null;
	const roundStart = now();
	const remaining =
		prepared.startedAt + limits.toolPhaseDeadlineMs - roundStart;
	if (remaining < limits.minRoundMs) throw new SheetToolBudgetError("deadline");
	const signal = AbortSignal.timeout(remaining);

	// Fixed progress text only, one attempt: retries would spend the model budget.
	const progress = await deps
		.delivery(signal, { maxAttempts: 1 })
		.deliverPreview(
			formatThinking(
				input.question,
				round === 1 ? PROGRESS_TEXT : `${PROGRESS_TEXT}（${round}回目）`,
			),
		);
	if (!progress.success)
		deps.log.warn("Sheet tool progress edit failed (non-fatal)", {
			round,
			deliveryStatus: progress.status,
			statusCode: progress.statusCode,
		});

	const prompt = buildSheetToolPrompt({
		description: prepared.description,
		questionDate: prepared.questionDate,
		catalog: prepared.catalog,
		maxToolCalls: limits.maxToolCalls,
		history: input.history,
		question: input.question,
	});
	let text = "";
	let usage: LlmUsage | null = null;
	let finish: LlmFinish = { reason: "unknown" };
	let toolEvent: Extract<LlmStreamEvent, { type: "tool_calls" }> | null = null;
	let attempts = 0;
	let firstTextAt: number | null = null;
	const report = () => {
		const metrics: SheetToolRoundMetrics = {
			round,
			usage,
			attempts,
			durationMs: now() - roundStart,
			firstTextDurationMs:
				firstTextAt === null ? null : firstTextAt - roundStart,
			finishReason: finish.reason,
			toolCallCount: toolEvent?.calls.length ?? 0,
		};
		onMetrics?.(metrics);
		return metrics;
	};
	try {
		for await (const event of deps.gateway.generateStream({
			model: deps.model,
			prompt,
			tools: SHEET_TOOL_DEFINITIONS,
			...(previous?.kind === "tools"
				? {
						continuation: { state: previous.state, results: previous.results },
					}
				: {}),
			maxOutputTokens: limits.maxOutputTokensPerRound,
			timeoutMs: remaining,
			signal,
			telemetry: {
				onAttempt: () => {
					attempts++;
				},
				onFirstText: () => {
					firstTextAt ??= now();
				},
			},
		})) {
			// Text is buffered, never previewed: it may be interim tool-round text.
			if (event.type === "text") text += event.delta;
			else if (event.type === "tool_calls") toolEvent = event;
			else if (event.type === "usage") usage = event.usage;
			else if (event.type === "finish") finish = event.finish;
		}
	} catch (error) {
		report();
		if (signal.aborted) throw new SheetToolBudgetError("deadline");
		throw error;
	}
	const metrics = report();
	totals.rounds = round;
	totals.attempts += attempts;
	totals.modelDurationMs += metrics.durationMs;
	totals.usage = addLlmUsage(totals.usage, usage);
	if (usage?.totalTokens == null)
		throw new SheetToolBudgetError("usage_unavailable");
	totals.totalTokens += usage.totalTokens;
	if (totals.totalTokens > limits.maxTotalTokens)
		throw new SheetToolBudgetError("total_tokens");

	if (finish.reason === "tool_calls") {
		if (!toolEvent) throw technical("llm", "read sheet tool calls");
		// The last permitted round must answer, so no round is left for results.
		if (round >= limits.maxModelRounds)
			throw new SheetToolBudgetError("model_rounds");
		if (totals.toolCalls + toolEvent.calls.length > limits.maxToolCalls)
			throw new SheetToolBudgetError("tool_calls");
		if (bytes(toolEvent.state) > limits.maxStateBytes)
			throw new SheetToolBudgetError("state_bytes");
		const searchStart = now();
		const engine = await deps.openEngine(prepared, {
			deliveredIds: input.deliveredIds,
			signal,
		});
		const results: { callId: string; output: string }[] = [];
		const calls: { name: string; outcome: ToolOutcome; reason?: string }[] = [];
		for (const call of toolEvent.calls) {
			const execution = await executeToolCall(
				engine,
				call,
				attachment !== null,
				now,
			);
			if (signal.aborted) throw new SheetToolBudgetError("deadline");
			totals.toolCalls++;
			totals.outcomes[execution.outcome]++;
			const output = JSON.stringify({
				result: execution.output,
				budget: {
					remaining_tool_calls: limits.maxToolCalls - totals.toolCalls,
					remaining_model_rounds: limits.maxModelRounds - round,
				},
			});
			const size = bytes(output);
			totals.toolResultBytes += size;
			if (
				size > limits.maxToolResultBytes ||
				totals.toolResultBytes > limits.maxCumulativeToolResultBytes
			)
				throw new SheetToolBudgetError("tool_result_bytes");
			if (execution.attachment) attachment = execution.attachment;
			results.push({ callId: call.callId, output });
			calls.push({
				name: execution.name,
				outcome: execution.outcome,
				...(execution.reason ? { reason: execution.reason } : {}),
			});
		}
		totals.searchDurationMs += now() - searchStart;
		// Counts and codes only: never arguments, rows, state items or the question.
		deps.log.info("Sheet tool round executed tools", {
			round,
			calls,
			resultBytes: totals.toolResultBytes,
			attempts,
			durationMs: metrics.durationMs,
			usage,
		});
		return {
			kind: "tools",
			round,
			totals,
			attachment,
			metrics,
			state: toolEvent.state,
			results,
		};
	}
	if (finish.reason === "stop") {
		const answer = normalizeDiscordText(text).trim();
		if (!answer && !attachment)
			throw technical("llm", "validate sheet tool answer", EMPTY_USER_MESSAGE);
		deps.log.info("Sheet tool round produced final answer", {
			round,
			attempts,
			durationMs: metrics.durationMs,
			responseLength: answer.length,
			usage,
		});
		return {
			kind: "final",
			round,
			totals,
			attachment,
			metrics,
			text: answer,
			finalFirstTextMs:
				firstTextAt === null ? null : firstTextAt - prepared.startedAt,
		};
	}
	if (finish.reason === "length")
		throw new SheetToolBudgetError("output_tokens");
	if (finish.reason === "blocked")
		throw technical("llm", "validate sheet tool answer", BLOCKED_USER_MESSAGE);
	throw technical("llm", "validate sheet tool answer", EMPTY_USER_MESSAGE);
}

function addDelivery(
	total: Omit<
		SheetToolDeliveryOutput,
		"attachmentStatus" | "deliveredIds" | "historyText"
	>,
	result: DeliveryResult,
	offset: number,
) {
	total.editCount += result.editCount;
	total.chunkCount += result.chunkCount;
	total.retryCount += result.retryCount;
	total.failedChunks.push(
		...result.failedChunks.map((index) => index + offset),
	);
	if (!result.success) total.statusCode = result.statusCode;
}

/**
 * Delivers the checkpointed final text once, then re-prepared rendered chunks.
 * The model is never called here, so a retry cannot regenerate the answer.
 */
export async function deliverSheetToolAnswerStep(
	deps: Pick<SheetToolDeps, "openEngine" | "delivery" | "log" | "now">,
	input: {
		question: string;
		prepared: SheetToolPrepareOutput;
		final: Extract<SheetToolRoundOutput, { kind: "final" }>;
		deliveredIds: readonly string[];
	},
): Promise<SheetToolDeliveryOutput> {
	const now = deps.now ?? Date.now;
	const { prepared, final } = input;
	const remaining =
		prepared.startedAt + SHEET_TOOL_LIMITS.questionDeadlineMs - now();
	if (remaining <= 0) throw new SheetToolBudgetError("deadline");
	const signal = AbortSignal.timeout(remaining);
	let rendered: PreparedSheetAnswer | null = null;
	if (final.attachment) {
		const engine = await deps.openEngine(prepared, {
			deliveredIds: input.deliveredIds,
			signal,
		});
		const result = await prepareAttachment(engine, final.attachment);
		// Same snapshot, args and date must reproduce the checked rendering.
		if (
			result.status === "error" ||
			result.metadata.result_set_id !== final.attachment.resultSetId ||
			result.chunks.length !== final.attachment.chunkCount
		)
			throw technical("sheets", "rebuild sheet tool attachment");
		rendered = result;
	}
	const delivery = deps.delivery(signal);
	const started = now();
	const text = final.text || ATTACHMENT_LEAD;
	const content = formatAnswer(input.question, text);
	const main = await delivery.deliverFinal(content);
	const total = {
		deliveryStatus: main.status,
		editCount: 0,
		chunkCount: 0,
		failedChunks: [] as number[],
		retryCount: 0,
		statusCode: main.statusCode,
		deliveryDurationMs: 0,
	};
	addDelivery(total, main, 0);
	const confirmed: string[] = [];
	if (rendered && main.status !== "failed") {
		const offset = splitContent(content).length;
		for (const [index, chunk] of rendered.chunks.entries()) {
			const result = await delivery.deliverFollowup(chunk.content);
			addDelivery(total, result, offset + index);
			if (
				result.success &&
				rendered.confirmDelivered([{ index, content: chunk.content }])
			)
				confirmed.push(chunk.content);
		}
	}
	total.deliveryDurationMs = now() - started;
	const state = rendered?.deliveryState();
	const attachmentFailed =
		rendered !== null && confirmed.length !== rendered.chunks.length;
	if (main.status === "success" && attachmentFailed)
		total.deliveryStatus = "partial";
	const output: SheetToolDeliveryOutput = {
		...total,
		attachmentStatus: state?.status ?? "none",
		deliveredIds: state?.delivered_ids ?? [],
		historyText: [text, ...confirmed].join("\n\n"),
	};
	deps.log.info("Final Discord delivery completed", {
		editCount: output.editCount,
		chunkCount: output.chunkCount,
		deliveryStatus: output.deliveryStatus,
		failedChunks: output.failedChunks,
		responseLength: text.length,
		attachmentStatus: output.attachmentStatus,
		deliveredIdCount: output.deliveredIds.length,
	});
	return output;
}
