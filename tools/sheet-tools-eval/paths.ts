import {
	createDiscordDeliveryService,
	type DiscordWebhookTransport,
} from "../../src/discord/delivery";
import { formatAnswer } from "../../src/discord/formatter";
import { buildAnswerPrompt } from "../../src/llm/promptBuilder";
import type { LlmFinish, LlmUsage } from "../../src/llm/types";
import { addLlmUsage } from "../../src/llm/usage";
import { ExternalServiceError } from "../../src/utils/errors";
import { type LogContext, Logger } from "../../src/utils/logger";
import { SHEET_TOOL_LIMITS } from "../../src/workflows/sheetTools/limits";
import {
	captureStepFailure,
	deliverSheetToolAnswerStep,
	prepareSheetToolsStep,
	rethrowStepFailure,
	runSheetToolRound,
	SheetToolBudgetError,
	type SheetToolDeps,
	type SheetToolPrepareOutput,
	type SheetToolRoundMetrics,
	type SheetToolRoundOutput,
	type SheetToolStepFailure,
} from "../../src/workflows/sheetTools/loop";
import type { ToolOutcome } from "../../src/workflows/sheetTools/tools";
import type { EvalQuestion, EvalSnapshot } from "./inputs";
import {
	HarnessBudgetStop,
	type MeteredGateway,
	type RequestRecord,
	utf8Bytes,
} from "./metered";

export type AnswerPath = "legacy" | "tools";

export type PathOutcome =
	| { kind: "answered" }
	| { kind: "budget_exceeded"; reason: string }
	| {
			kind: "technical_failure";
			service: string;
			operation: string;
			status: number | null;
	  }
	| { kind: "harness_budget_stop" };

export type ToolCallRecord = {
	name: string;
	outcome: ToolOutcome;
	reason?: string;
};

export type RoundRecord = {
	round: number;
	responded: boolean;
	finishReason: LlmFinish["reason"];
	toolCallCount: number;
	usage: LlmUsage | null;
	attempts: number;
	durationMs: number;
	firstTextDurationMs: number | null;
	costUsd: number;
	/** Serialized opaque provider state; 0 for a final round. */
	stateBytes: number;
	/** Serialized checkpoint (what a Workflow step would persist). */
	roundOutputBytes: number;
	/** Cumulative serialized tool results after this round. */
	toolResultBytes: number;
	calls: ToolCallRecord[];
	/** Arguments as the model sent them, for diagnosing invalid_arguments. */
	requestedCalls: RequestRecord["toolCalls"];
};

export type PathResult = {
	id: string;
	category: string;
	path: AnswerPath;
	outcome: PathOutcome;
	finalText: string;
	/** In-memory fake Discord: final edit content plus follow-up chunks. */
	deliveredChunks: string[];
	progressEditCount: number;
	rounds: RoundRecord[];
	toolCallCount: number;
	toolOutcomes: Record<ToolOutcome, number>;
	usage: LlmUsage | null;
	attempts: number;
	costUsd: number;
	costKind: "observed" | "estimated";
	totalMs: number;
	firstFinalTextMs: number | null;
	questionDate: string | null;
	maxStateBytes: number;
	maxToolResultBytes: number;
	maxRoundOutputBytes: number;
};

/** Records delivery calls in memory; there is no network. */
export class FakeDiscordTransport implements DiscordWebhookTransport {
	phase: "progress" | "final" = "progress";
	progressEdits = 0;
	finalEdits: string[] = [];
	posts: string[] = [];

	async editOriginalMessage(content: string): Promise<void> {
		if (this.phase === "progress") this.progressEdits++;
		else this.finalEdits.push(content);
	}

	async postMessage(content: string): Promise<void> {
		this.posts.push(content);
	}

	get chunks(): string[] {
		return [...this.finalEdits, ...this.posts];
	}
}

type Call = { round: number; calls: ToolCallRecord[] };

/** Captures the loop's per-call outcome log; never prints anything. */
export class CaptureLogger extends Logger {
	readonly toolRounds: Call[];

	constructor(toolRounds: Call[] = []) {
		super();
		this.toolRounds = toolRounds;
	}

	override withContext(): Logger {
		return this;
	}

	override info(message: string, context?: LogContext): void {
		if (message === "Sheet tool round executed tools" && context)
			this.toolRounds.push({
				round: context.round as number,
				calls: context.calls as ToolCallRecord[],
			});
	}

	override warn(): void {}
	override error(): void {}
	override debug(): void {}
}

const emptyOutcomes = (): Record<ToolOutcome, number> => ({
	ok: 0,
	zero: 0,
	ambiguous: 0,
	missing: 0,
	error: 0,
});

function classify(
	error: unknown,
	meter: MeteredGateway,
	requestStart: number,
): PathOutcome {
	if (error instanceof HarnessBudgetStop)
		return { kind: "harness_budget_stop" };
	if (error instanceof SheetToolBudgetError)
		return { kind: "budget_exceeded", reason: error.reason };
	const failed = meter.records.slice(requestStart).find((r) => r.error)?.error;
	if (error instanceof ExternalServiceError)
		return {
			kind: "technical_failure",
			service: error.service,
			operation: error.operation,
			// Step boundaries drop the status, so prefer the gateway's record.
			status: failed?.status ?? error.status ?? null,
		};
	return {
		kind: "technical_failure",
		service: failed?.service ?? "harness",
		operation: failed?.operation ?? "unexpected error",
		status: failed?.status ?? null,
	};
}

function sumRecords(records: RequestRecord[]) {
	const costUsd = records.reduce((total, r) => total + r.costUsd, 0);
	return {
		costUsd,
		costKind: records.some((r) => r.costKind === "estimated")
			? ("estimated" as const)
			: ("observed" as const),
	};
}

export type PathContext = {
	snapshot: EvalSnapshot;
	meter: MeteredGateway;
	model: string;
	description: string;
	sheetInfo: string;
	now?: () => number;
};

export async function runToolsPath(
	ctx: PathContext,
	question: EvalQuestion,
): Promise<PathResult> {
	const now = ctx.now ?? Date.now;
	const transport = new FakeDiscordTransport();
	const callLog: Call[] = [];
	const log = new CaptureLogger(callLog);
	const deps: SheetToolDeps = {
		gateway: ctx.meter,
		model: ctx.model,
		openEngine: ctx.snapshot.openEngine,
		delivery: (signal, retryConfig) =>
			createDiscordDeliveryService(transport, log, retryConfig, signal),
		log,
	};
	const requestStart = ctx.meter.records.length;
	const started = now();
	const rounds: RoundRecord[] = [];
	let last: SheetToolRoundOutput | null = null;
	let failedRound: SheetToolRoundMetrics | null = null;
	let prepared: SheetToolPrepareOutput | null = null;
	let outcome: PathOutcome = { kind: "answered" };
	let finalText = "";
	const checkpoint = <T>(value: T): [T, number] => {
		const serialized = JSON.stringify(value);
		return [JSON.parse(serialized) as T, utf8Bytes(serialized)];
	};
	const roundRecord = (
		metrics: SheetToolRoundMetrics,
		output: SheetToolRoundOutput | null,
		outputBytes: number,
		records: RequestRecord[],
	): RoundRecord => ({
		round: metrics.round,
		responded: records.some((r) => r.error === null),
		finishReason: metrics.finishReason,
		toolCallCount: metrics.toolCallCount,
		usage: metrics.usage,
		attempts: metrics.attempts,
		durationMs: metrics.durationMs,
		firstTextDurationMs: metrics.firstTextDurationMs,
		costUsd: records.reduce((total, r) => total + r.costUsd, 0),
		stateBytes: output?.kind === "tools" ? utf8Bytes(output.state) : 0,
		roundOutputBytes: outputBytes,
		toolResultBytes: output?.totals.toolResultBytes ?? 0,
		calls: callLog.find((entry) => entry.round === metrics.round)?.calls ?? [],
		requestedCalls: records.flatMap((r) => r.toolCalls),
	});
	try {
		const [prep] = checkpoint(
			rethrowStepFailure(
				await captureStepFailure(() =>
					prepareSheetToolsStep(deps, ctx.snapshot.ref),
				),
			),
		);
		prepared = prep;
		for (let round = 1; round <= SHEET_TOOL_LIMITS.maxModelRounds; round++) {
			const before = ctx.meter.records.length;
			let attempted: SheetToolRoundMetrics | null = null;
			const previous: SheetToolRoundOutput | null = last;
			try {
				const captured = await captureStepFailure(() =>
					runSheetToolRound(
						deps,
						{
							round,
							question: question.question,
							prepared: prep,
							history: question.history,
							deliveredIds: [],
							previous,
						},
						(metrics) => {
							attempted = metrics;
						},
					),
				);
				const [roundtrip, outputBytes] = checkpoint(
					captured as SheetToolRoundOutput | SheetToolStepFailure,
				);
				const output = rethrowStepFailure(roundtrip) as SheetToolRoundOutput;
				last = output;
				rounds.push(
					roundRecord(
						output.metrics,
						output,
						outputBytes,
						ctx.meter.records.slice(before),
					),
				);
			} catch (error) {
				failedRound = attempted;
				if (attempted)
					rounds.push(
						roundRecord(attempted, null, 0, ctx.meter.records.slice(before)),
					);
				throw error;
			}
			if (last.kind === "final") break;
		}
		const final = last;
		if (final?.kind !== "final") throw new SheetToolBudgetError("model_rounds");
		finalText = final.text;
		transport.phase = "final";
		const [delivered] = checkpoint(
			rethrowStepFailure(
				await captureStepFailure(() =>
					deliverSheetToolAnswerStep(deps, {
						question: question.question,
						prepared: prep,
						final,
						deliveredIds: [],
					}),
				),
			),
		);
		if (delivered.deliveryStatus === "failed")
			throw new ExternalServiceError({
				service: "discord",
				operation: "fake delivery",
				retryable: false,
				userMessage: "delivery failed",
			});
	} catch (error) {
		outcome = classify(error, ctx.meter, requestStart);
	}
	const records = ctx.meter.records.slice(requestStart);
	const totals = (last as SheetToolRoundOutput | null)?.totals;
	const usage =
		failedRound && totals
			? addLlmUsage(totals.usage, (failedRound as SheetToolRoundMetrics).usage)
			: (totals?.usage ??
				(failedRound as SheetToolRoundMetrics | null)?.usage ??
				null);
	const finalRound = last as SheetToolRoundOutput | null;
	return {
		id: question.id,
		category: question.category,
		path: "tools",
		outcome,
		finalText: outcome.kind === "answered" ? finalText : "",
		deliveredChunks: outcome.kind === "answered" ? transport.chunks : [],
		progressEditCount: transport.progressEdits,
		rounds,
		toolCallCount: totals?.toolCalls ?? 0,
		toolOutcomes: totals?.outcomes ?? emptyOutcomes(),
		usage,
		attempts: records.reduce((total, r) => total + r.attempts, 0),
		...sumRecords(records),
		totalMs: now() - started,
		firstFinalTextMs:
			finalRound?.kind === "final" ? finalRound.finalFirstTextMs : null,
		questionDate: prepared?.questionDate ?? null,
		maxStateBytes: Math.max(0, ...rounds.map((r) => r.stateBytes)),
		maxToolResultBytes: Math.max(0, ...rounds.map((r) => r.toolResultBytes)),
		maxRoundOutputBytes: Math.max(0, ...rounds.map((r) => r.roundOutputBytes)),
	};
}

export async function runLegacyPath(
	ctx: PathContext,
	question: EvalQuestion,
): Promise<PathResult> {
	const now = ctx.now ?? Date.now;
	const transport = new FakeDiscordTransport();
	const delivery = createDiscordDeliveryService(transport, new CaptureLogger());
	const requestStart = ctx.meter.records.length;
	const started = now();
	const prompt = buildAnswerPrompt({
		description: ctx.description,
		knowledge: ctx.sheetInfo,
		history: question.history,
		question: question.question,
	});
	let text = "";
	let usage: LlmUsage | null = null;
	let finish: LlmFinish = { reason: "unknown" };
	let attempts = 0;
	let firstTextAt: number | null = null;
	let outcome: PathOutcome = { kind: "answered" };
	try {
		// Summary stays disabled, exactly as in production.
		for await (const event of ctx.meter.generateStream({
			model: ctx.model,
			prompt,
			telemetry: {
				onAttempt: () => {
					attempts++;
				},
				onFirstText: () => {
					firstTextAt ??= now();
				},
			},
		})) {
			if (event.type === "text") text += event.delta;
			else if (event.type === "usage") usage = event.usage;
			else if (event.type === "finish") finish = event.finish;
		}
		const answer = text.trim();
		if (finish.reason !== "stop" || !answer) {
			outcome = {
				kind: "technical_failure",
				service: "llm",
				operation: `validate legacy answer (${finish.reason})`,
				status: null,
			};
		} else {
			transport.phase = "final";
			const result = await delivery.deliverFinal(
				formatAnswer(question.question, answer),
			);
			if (result.status === "failed")
				outcome = {
					kind: "technical_failure",
					service: "discord",
					operation: "fake delivery",
					status: null,
				};
		}
	} catch (error) {
		outcome = classify(error, ctx.meter, requestStart);
	}
	const records = ctx.meter.records.slice(requestStart);
	const answered = outcome.kind === "answered";
	return {
		id: question.id,
		category: question.category,
		path: "legacy",
		outcome,
		finalText: answered ? text.trim() : "",
		deliveredChunks: answered ? transport.chunks : [],
		progressEditCount: 0,
		rounds: [],
		toolCallCount: 0,
		toolOutcomes: emptyOutcomes(),
		usage,
		attempts: attempts || records.reduce((total, r) => total + r.attempts, 0),
		...sumRecords(records),
		totalMs: now() - started,
		firstFinalTextMs: firstTextAt === null ? null : firstTextAt - started,
		questionDate: null,
		maxStateBytes: 0,
		maxToolResultBytes: 0,
		maxRoundOutputBytes: 0,
	};
}
