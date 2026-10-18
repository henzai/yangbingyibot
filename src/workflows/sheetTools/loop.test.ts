import { describe, expect, it, vi } from "vitest";
import type { DiscordDeliveryService } from "../../discord/delivery";
import type {
	ILlmGateway,
	LlmRequest,
	LlmStreamEvent,
	LlmToolCall,
	LlmUsage,
} from "../../llm/types";
import { SheetSearchEngine } from "../../sheets/search/engine";
import {
	fixture,
	NOW,
	queryArgs,
	SOURCE,
	searchArgs,
} from "../../sheets/search/testFixtures";
import { ExternalServiceError } from "../../utils/errors";
import type { Logger } from "../../utils/logger";
import { SHEET_TOOL_LIMITS } from "./limits";
import {
	captureStepFailure,
	deliverSheetToolAnswerStep,
	prepareSheetToolsStep,
	rethrowStepFailure,
	runSheetToolRound,
	SheetToolBudgetError,
	type SheetToolDeps,
	type SheetToolPrepareOutput,
	type SheetToolRoundOutput,
} from "./loop";
import { SHEET_TOOL_DEFINITIONS } from "./tools";

const USAGE: LlmUsage = {
	inputTokens: 1000,
	cachedInputTokens: 0,
	outputTokens: 50,
	reasoningTokens: 10,
	totalTokens: 1060,
};
const STATE = {
	provider: "openai",
	items: [{ opaque: 1 }],
	pendingCallIds: [],
};
const QUESTION = "人工の質問";

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: () => log,
} as unknown as Logger;

function call(
	name: string,
	value: Record<string, unknown>,
	callId = `call-${name}`,
): LlmToolCall {
	return { callId, name, arguments: { ok: true, value } };
}

function toolRound(
	calls: LlmToolCall[],
	text = "途中の推測",
): LlmStreamEvent[] {
	return [
		{ type: "text", delta: text },
		{
			type: "tool_calls",
			calls,
			state: { ...STATE, pendingCallIds: calls.map((c) => c.callId) },
		},
		{ type: "usage", usage: USAGE },
		{ type: "finish", finish: { reason: "tool_calls" } },
	];
}

function finalRound(text: string, usage: LlmUsage | null = USAGE) {
	return [
		{ type: "text", delta: text },
		...(usage ? [{ type: "usage", usage }] : []),
		{ type: "finish", finish: { reason: "stop" } },
	] as LlmStreamEvent[];
}

function scriptedGateway(rounds: LlmStreamEvent[][]) {
	const requests: LlmRequest[] = [];
	const gateway: ILlmGateway = {
		provider: "openai",
		capabilities: { reasoningSummary: true, tools: true },
		async *generateStream(request) {
			const { signal: _signal, telemetry: _telemetry, ...recorded } = request;
			requests.push(structuredClone(recorded) as LlmRequest);
			request.telemetry?.onAttempt();
			const events = rounds.shift();
			if (!events) throw new Error("unexpected model round");
			for (const event of events) {
				if (event.type === "text") request.telemetry?.onFirstText?.();
				yield event;
			}
		},
		generateText: vi.fn(),
	};
	return { gateway, requests };
}

function fakeDelivery(fail: { final?: boolean; followups?: number[] } = {}) {
	const sent: { kind: string; content: string }[] = [];
	let followup = 0;
	const result = (success: boolean) => ({
		status: success ? ("success" as const) : ("failed" as const),
		success,
		editCount: success ? 1 : 0,
		chunkCount: 0,
		failedChunks: success ? [] : [0],
		retryCount: 0,
		statusCode: success ? 200 : 500,
	});
	const service = {
		deliverPreview: vi.fn(async (content: string) => {
			sent.push({ kind: "preview", content });
			return result(true);
		}),
		deliverFinal: vi.fn(async (content: string) => {
			sent.push({ kind: "final", content });
			return result(!fail.final);
		}),
		deliverFollowup: vi.fn(async (content: string) => {
			const index = followup++;
			sent.push({ kind: "followup", content });
			const ok = !fail.followups?.includes(index);
			return { ...result(ok), editCount: 0, chunkCount: ok ? 1 : 0 };
		}),
	};
	return { service: service as unknown as DiscordDeliveryService, sent };
}

async function setup(
	rounds: LlmStreamEvent[][],
	options: {
		clock?: () => number;
		delivery?: ReturnType<typeof fakeDelivery>;
	} = {},
) {
	const clock = options.clock ?? (() => NOW);
	const { repository, ref } = await fixture(undefined, undefined, clock);
	const { gateway, requests } = scriptedGateway(rounds);
	const delivery = options.delivery ?? fakeDelivery();
	const opened: { questionDate: string; deliveredIds: readonly string[] }[] =
		[];
	const deps: SheetToolDeps = {
		gateway,
		model: "gpt-6-luna",
		openEngine: async (prepared, { deliveredIds, signal }) => {
			opened.push({ questionDate: prepared.questionDate, deliveredIds });
			const result = await SheetSearchEngine.open(
				repository,
				SOURCE,
				prepared.snapshotRef,
				{
					questionDate: prepared.questionDate,
					deliveredIds,
					signal,
					now: clock,
				},
			);
			if (result.status !== "ready")
				throw new ExternalServiceError({
					service: "sheets",
					operation: result.reason,
					retryable: false,
					userMessage: "x",
				});
			return result.engine;
		},
		delivery: () => delivery.service,
		log,
		now: clock,
	};
	const prepared = await prepareSheetToolsStep(deps, ref);
	return { deps, prepared, requests, delivery, opened, ref };
}

/** Run rounds like the Workflow does, each from the previous checkpoint. */
async function runAll(
	deps: SheetToolDeps,
	prepared: SheetToolPrepareOutput,
	deliveredIds: string[] = [],
) {
	const outputs: SheetToolRoundOutput[] = [];
	let previous: SheetToolRoundOutput | null = null;
	for (let round = 1; round <= SHEET_TOOL_LIMITS.maxModelRounds; round++) {
		// Round-trip through JSON like a Workflow checkpoint.
		const output: SheetToolRoundOutput = JSON.parse(
			JSON.stringify(
				await runSheetToolRound(deps, {
					round,
					question: QUESTION,
					prepared,
					history: [{ role: "user", text: "質問: 前の質問" }],
					deliveredIds,
					previous,
				}),
			),
		);
		outputs.push(output);
		if (output.kind === "final") return outputs;
		previous = output;
	}
	throw new Error("no final round");
}

function parsedResults(output: SheetToolRoundOutput) {
	if (output.kind !== "tools") throw new Error("expected tool round");
	return output.results.map((result) => JSON.parse(result.output));
}

describe("prepareSheetToolsStep", () => {
	it("pins the snapshot, its description and the Tokyo question date", async () => {
		const { prepared, ref } = await setup([]);
		expect(prepared).toMatchObject({
			startedAt: NOW,
			questionDate: "2026-10-17",
			snapshotRef: ref,
			description: "人工の人格・回答規則と用語定義",
		});
		expect(prepared.catalog).toContain("full_name (text)");
		expect(prepared.catalog).not.toContain("架空");
	});

	it("fails technically without a pinned snapshot instead of using the TSV", async () => {
		const { deps } = await setup([]);
		await expect(prepareSheetToolsStep(deps, undefined)).rejects.toMatchObject({
			name: "ExternalServiceError",
			service: "sheets",
		});
	});
});

describe("runSheetToolRound", () => {
	it("answers without tools and never previews model text", async () => {
		const { deps, prepared, requests, delivery } = await setup([
			finalRound("回答です<br>二行目"),
		]);
		const [output] = await runAll(deps, prepared);
		expect(output).toMatchObject({
			kind: "final",
			text: "回答です\n二行目",
			finalFirstTextMs: 0,
			totals: { rounds: 1, toolCalls: 0, totalTokens: 1060, attempts: 1 },
		});
		expect(delivery.sent).toEqual([
			{
				kind: "preview",
				content: `> ${QUESTION}\n:thought_balloon: シートを確認しています…`,
			},
		]);
		expect(requests[0]).toMatchObject({
			model: "gpt-6-luna",
			maxOutputTokens: SHEET_TOOL_LIMITS.maxOutputTokensPerRound,
		});
		expect(requests[0].tools?.map((tool) => tool.name)).toEqual(
			SHEET_TOOL_DEFINITIONS.map((tool) => tool.name),
		);
		expect(requests[0].continuation).toBeUndefined();
		expect(requests[0].prompt.context).not.toContain("架空甲");
	});

	it("executes requested tools, then continues with the same instructions", async () => {
		const { deps, prepared, requests, delivery, opened } = await setup([
			toolRound([call("search_records", { ...searchArgs, query: "架空甲" })]),
			finalRound("架空甲さんです。"),
		]);
		const outputs = await runAll(deps, prepared, ["src:999"]);
		expect(outputs.map((output) => output.kind)).toEqual(["tools", "final"]);
		const [result] = parsedResults(outputs[0]);
		expect(result.result).toMatchObject({
			status: "ok",
			coverage: "candidate_only",
		});
		expect(result.budget).toEqual({
			remaining_tool_calls: SHEET_TOOL_LIMITS.maxToolCalls - 1,
			remaining_model_rounds: SHEET_TOOL_LIMITS.maxModelRounds - 1,
		});
		expect(outputs[0].totals.outcomes.ok).toBe(1);
		// Interim tool-round text is neither kept nor delivered.
		expect(JSON.stringify(outputs)).not.toContain("途中の推測");
		expect(delivery.sent.every((item) => item.kind === "preview")).toBe(true);
		expect(delivery.sent.map((item) => item.content).join()).not.toContain(
			"途中の推測",
		);
		expect(requests[1].continuation).toEqual({
			state: { ...STATE, pendingCallIds: ["call-search_records"] },
			results: [{ callId: "call-search_records", output: expect.any(String) }],
		});
		expect(requests[1].prompt).toEqual(requests[0].prompt);
		expect(requests[1].tools).toEqual(requests[0].tools);
		// Reopened on the persisted date with the conversation's delivered IDs.
		expect(opened.at(-1)).toEqual({
			questionDate: "2026-10-17",
			deliveredIds: ["src:999"],
		});
		expect(outputs[1]).toMatchObject({
			totals: { rounds: 2, toolCalls: 1, totalTokens: 2120, attempts: 2 },
		});
	});

	it("classifies zero, ambiguous and invalid results without failing the round", async () => {
		const { deps, prepared } = await setup([
			toolRound([
				call(
					"search_records",
					{ ...searchArgs, query: "存在しない人工名" },
					"a",
				),
			]),
			toolRound([
				call("search_records", { ...searchArgs, query: "架空乙" }, "b"),
			]),
			toolRound([
				{
					callId: "c",
					name: "get_records",
					arguments: { ok: false, error: "invalid_json" },
				},
			]),
			toolRound([call("drop_table", {}, "d")]),
			finalRound("確認できませんでした。"),
		]);
		const outputs = await runAll(deps, prepared);
		expect(outputs.at(-1)?.totals.outcomes).toEqual({
			ok: 0,
			zero: 1,
			ambiguous: 1,
			missing: 0,
			error: 2,
		});
		expect(parsedResults(outputs[2])[0].result).toEqual({
			status: "error",
			reason: "invalid_arguments",
		});
		expect(parsedResults(outputs[3])[0].result).toEqual({
			status: "error",
			reason: "unknown_tool",
		});
	});

	it("attaches one verified list and rejects a second attachment", async () => {
		const present = {
			...queryArgs,
			where: {
				any: [
					{
						all: [{ field: "generation_group", op: "eq", values: ["SNH48"] }],
					},
				],
			},
		};
		const { deps, prepared } = await setup([
			toolRound([call("present_query_answer", present, "p1")]),
			toolRound([call("present_query_answer", present, "p2")]),
			finalRound("該当者は以下のとおりです。"),
		]);
		const outputs = await runAll(deps, prepared);
		expect(parsedResults(outputs[0])[0].result).toMatchObject({
			status: "ok",
			attached: true,
		});
		expect(parsedResults(outputs[1])[0].result).toEqual({
			status: "error",
			reason: "attachment_already_set",
		});
		expect(outputs[2].attachment).toMatchObject({
			kind: "query",
			args: present,
			chunkCount: expect.any(Number),
		});
	});

	it.each([
		[
			"tool call budget",
			() =>
				toolRound(
					Array.from({ length: SHEET_TOOL_LIMITS.maxToolCalls + 1 }, (_, i) =>
						call("search_records", { ...searchArgs, query: "架空甲" }, `c${i}`),
					),
				),
			"tool_calls",
		],
		[
			"output token limit",
			() =>
				[
					{ type: "usage", usage: USAGE },
					{ type: "finish", finish: { reason: "length" } },
				] as LlmStreamEvent[],
			"output_tokens",
		],
		["missing usage", () => finalRound("回答", null), "usage_unavailable"],
		[
			"total token budget",
			() =>
				finalRound("回答", {
					...USAGE,
					totalTokens: SHEET_TOOL_LIMITS.maxTotalTokens + 1,
				}),
			"total_tokens",
		],
	])("stops on the %s", async (_name, events, reason) => {
		const { deps, prepared, delivery } = await setup([events()]);
		await expect(runAll(deps, prepared)).rejects.toMatchObject({
			name: "SheetToolBudgetError",
			reason,
		});
		expect(delivery.sent.every((item) => item.kind === "preview")).toBe(true);
	});

	it("refuses to request tools in the last permitted round", async () => {
		const rounds = Array.from(
			{ length: SHEET_TOOL_LIMITS.maxModelRounds },
			(_, i) =>
				toolRound([
					call("search_records", { ...searchArgs, query: "架空甲" }, `r${i}`),
				]),
		);
		const { deps, prepared } = await setup(rounds);
		// 8 calls fit the tool budget; the 9th round may not ask for more.
		await expect(runAll(deps, prepared)).rejects.toMatchObject({
			reason: "model_rounds",
		});
	});

	it.each([
		["one oversized result", 1, 40 * 1024],
		["the cumulative total", 7, 20 * 1024],
	])("stops when %s exceeds the byte budget", async (_name, count, size) => {
		const calls = Array.from({ length: count }, (_, i) =>
			call("search_records", { ...searchArgs, query: "架空甲" }, `b${i}`),
		);
		const { deps, prepared } = await setup([toolRound(calls)]);
		const open = deps.openEngine;
		deps.openEngine = async (...args) => {
			const engine = await open(...args);
			const execute = engine.execute.bind(engine);
			engine.execute = async (name, input) => {
				const result = await execute(name, input);
				const padded = { ...result, padding: "x".repeat(size) };
				return padded as typeof result;
			};
			return engine;
		};
		await expect(runAll(deps, prepared)).rejects.toMatchObject({
			reason: "tool_result_bytes",
		});
	});

	it("stops at the shared deadline before calling the model", async () => {
		let now = NOW;
		const { deps, prepared, requests } = await setup([finalRound("遅い回答")], {
			clock: () => now,
		});
		now = NOW + SHEET_TOOL_LIMITS.toolPhaseDeadlineMs;
		await expect(runAll(deps, prepared)).rejects.toMatchObject({
			reason: "deadline",
		});
		expect(requests).toHaveLength(0);
	});

	it("maps a stream cut by the shared deadline to the deadline budget", async () => {
		const { deps, prepared } = await setup([]);
		deps.gateway.generateStream = async function* (request) {
			request.telemetry?.onAttempt();
			yield { type: "text", delta: "途中" };
			throw new Error("stream cancelled");
		};
		// The round's shared AbortSignal has fired by the time the stream fails.
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => AbortSignal.abort());
		try {
			await expect(runAll(deps, prepared)).rejects.toMatchObject({
				reason: "deadline",
			});
		} finally {
			timeout.mockRestore();
		}
	});

	it("rethrows a stream failure that is not a deadline", async () => {
		const { deps, prepared } = await setup([]);
		const failure = new ExternalServiceError({
			service: "llm",
			operation: "consume response stream",
			retryable: false,
			userMessage: "接続が中断されました。",
		});
		deps.gateway.generateStream = async function* (request) {
			request.telemetry?.onAttempt();
			yield { type: "text", delta: "途中" };
			throw failure;
		};
		await expect(runAll(deps, prepared)).rejects.toBe(failure);
	});

	it.each([
		["blocked", "安全性フィルタにより回答できませんでした。"],
		["error", "AIから有効な応答が得られませんでした。"],
	] as const)(
		"reports a %s finish as a technical failure",
		async (reason, message) => {
			const { deps, prepared } = await setup([
				[
					{ type: "usage", usage: USAGE },
					{ type: "finish", finish: { reason } },
				],
			]);
			await expect(runAll(deps, prepared)).rejects.toMatchObject({
				name: "ExternalServiceError",
				userMessage: message,
			});
		},
	);

	it("rejects an empty final answer without an attachment", async () => {
		const { deps, prepared } = await setup([finalRound("  ")]);
		await expect(runAll(deps, prepared)).rejects.toMatchObject({
			userMessage: "AIから有効な応答が得られませんでした。",
		});
	});

	it("reports metrics for a failed round", async () => {
		const { deps, prepared } = await setup([finalRound("回答", null)]);
		const onMetrics = vi.fn();
		await expect(
			runSheetToolRound(
				deps,
				{
					round: 1,
					question: QUESTION,
					prepared,
					history: [],
					deliveredIds: [],
					previous: null,
				},
				onMetrics,
			),
		).rejects.toBeInstanceOf(SheetToolBudgetError);
		expect(onMetrics).toHaveBeenCalledWith(
			expect.objectContaining({ round: 1, attempts: 1, usage: null }),
		);
	});

	it("never logs arguments, rows, provider state or the question", async () => {
		const info = vi.fn();
		const { deps, prepared } = await setup([
			toolRound([call("search_records", { ...searchArgs, query: "架空甲" })]),
			finalRound("架空甲さんです。"),
		]);
		deps.log = { ...log, info } as unknown as Logger;
		await runAll(deps, prepared);
		const logged = JSON.stringify(info.mock.calls);
		expect(logged).not.toContain("架空甲");
		expect(logged).not.toContain(QUESTION);
		expect(logged).not.toContain("opaque");
	});
});

describe("deliverSheetToolAnswerStep", () => {
	const generationWhere = {
		any: [
			{ all: [{ field: "generation_group", op: "eq", values: ["SNH48"] }] },
		],
	};

	// where=null is fully determinable; generationWhere has an unknown member.
	async function finalWithAttachment(
		delivery = fakeDelivery(),
		where: unknown = null,
	) {
		const context = await setup(
			[
				toolRound([call("present_query_answer", { ...queryArgs, where })]),
				finalRound("SNH48の該当者です。"),
			],
			{ delivery },
		);
		const outputs = await runAll(context.deps, context.prepared);
		const final = outputs.at(-1);
		if (final?.kind !== "final") throw new Error("expected final");
		return { ...context, final };
	}

	it("delivers the final text once, then confirmed rendered chunks", async () => {
		const { deps, prepared, final, delivery } = await finalWithAttachment();
		delivery.sent.length = 0;
		const output = await deliverSheetToolAnswerStep(deps, {
			question: QUESTION,
			prepared,
			final,
			deliveredIds: [],
		});
		expect(delivery.sent[0]).toEqual({
			kind: "final",
			content: `> ${QUESTION}\nSNH48の該当者です。`,
		});
		expect(
			delivery.sent.slice(1).every((item) => item.kind === "followup"),
		).toBe(true);
		expect(output).toMatchObject({
			deliveryStatus: "success",
			attachmentStatus: "complete",
		});
		expect(output.deliveredIds).toHaveLength(5);
		expect(output.historyText.startsWith("SNH48の該当者です。\n\n")).toBe(true);
		expect(deps.gateway.generateText).not.toHaveBeenCalled();
	});

	it("keeps an incomplete condition set partial even when every chunk is sent", async () => {
		const { deps, prepared, final } = await finalWithAttachment(
			fakeDelivery(),
			generationWhere,
		);
		const output = await deliverSheetToolAnswerStep(deps, {
			question: QUESTION,
			prepared,
			final,
			deliveredIds: [],
		});
		expect(output).toMatchObject({
			deliveryStatus: "success",
			attachmentStatus: "partial",
		});
		expect(output.historyText).not.toContain("BEJ48");
		expect(output.historyText).toContain("一部表示・未完了");
	});

	it("records only acknowledged chunks when a follow-up fails", async () => {
		const delivery = fakeDelivery({ followups: [0] });
		const { deps, prepared, final } = await finalWithAttachment(delivery);
		const output = await deliverSheetToolAnswerStep(deps, {
			question: QUESTION,
			prepared,
			final,
			deliveredIds: [],
		});
		expect(output.deliveryStatus).toBe("partial");
		expect(output.attachmentStatus).not.toBe("complete");
		expect(output.deliveredIds).toEqual([]);
		expect(output.historyText).toBe("SNH48の該当者です。");
	});

	it("does not post the list when the main answer could not be delivered", async () => {
		const delivery = fakeDelivery({ final: true });
		const { deps, prepared, final } = await finalWithAttachment(delivery);
		delivery.sent.length = 0;
		const output = await deliverSheetToolAnswerStep(deps, {
			question: QUESTION,
			prepared,
			final,
			deliveredIds: [],
		});
		expect(delivery.sent.map((item) => item.kind)).toEqual(["final"]);
		expect(output).toMatchObject({
			deliveryStatus: "failed",
			deliveredIds: [],
		});
	});

	it("refuses to deliver when the rebuilt attachment differs from the checkpoint", async () => {
		const { deps, prepared, final, delivery } = await finalWithAttachment();
		delivery.sent.length = 0;
		await expect(
			deliverSheetToolAnswerStep(deps, {
				question: QUESTION,
				prepared,
				final: {
					...final,
					attachment: final.attachment && {
						...final.attachment,
						resultSetId: "0".repeat(64),
					},
				},
				deliveredIds: [],
			}),
		).rejects.toMatchObject({ service: "sheets" });
		expect(delivery.sent).toEqual([]);
	});

	it("stops after the question deadline without delivering", async () => {
		let now = NOW;
		const { deps, prepared, delivery } = await setup([finalRound("回答")], {
			clock: () => now,
		});
		const [final] = await runAll(deps, prepared);
		if (final.kind !== "final") throw new Error("expected final");
		delivery.sent.length = 0;
		now = NOW + SHEET_TOOL_LIMITS.questionDeadlineMs;
		await expect(
			deliverSheetToolAnswerStep(deps, {
				question: QUESTION,
				prepared,
				final,
				deliveredIds: [],
			}),
		).rejects.toMatchObject({ reason: "deadline" });
		expect(delivery.sent).toEqual([]);
	});

	it("uses a fixed lead when the model leaves the text empty with an attachment", async () => {
		const context = await setup([
			toolRound([
				call("present_query_answer", { ...queryArgs, where: generationWhere }),
			]),
			finalRound(""),
		]);
		const outputs = await runAll(context.deps, context.prepared);
		const final = outputs.at(-1);
		if (final?.kind !== "final") throw new Error("expected final");
		const output = await deliverSheetToolAnswerStep(context.deps, {
			question: QUESTION,
			prepared: context.prepared,
			final,
			deliveredIds: [],
		});
		expect(output.historyText).toContain(
			"シートから確認した結果は以下のとおりです。",
		);
	});
});

describe("Workflow replay", () => {
	it("keeps the question date fixed across Tokyo midnight", async () => {
		// 23:59:30 JST on 2026-10-17; the snapshot is still within its 24 h TTL.
		let now = Date.parse("2026-10-17T14:59:30Z");
		const { deps, prepared } = await setup(
			[toolRound([call("query_records", queryArgs)]), finalRound("回答")],
			{ clock: () => now },
		);
		now += 40_000;
		const [tools] = await runAll(deps, prepared);
		expect(prepared.questionDate).toBe("2026-10-17");
		expect(parsedResults(tools)[0].result.calculation_context).toEqual({
			as_of: "2026-10-17",
			target_age: null,
		});
	});
});

describe("step failure records", () => {
	it("rebuild budget and technical errors after a JSON checkpoint", async () => {
		const budget = JSON.parse(
			JSON.stringify(
				await captureStepFailure(async () => {
					throw new SheetToolBudgetError("tool_calls");
				}),
			),
		);
		expect(() => rethrowStepFailure(budget)).toThrow(SheetToolBudgetError);
		expect(() => rethrowStepFailure(budget)).toThrow(
			expect.objectContaining({ reason: "tool_calls" }),
		);
		const technical = JSON.parse(
			JSON.stringify(
				await captureStepFailure(async () => {
					throw new ExternalServiceError({
						service: "sheets",
						operation: "open pinned sheet snapshot expired",
						retryable: false,
						userMessage: "読み込めませんでした。",
					});
				}),
			),
		);
		expect(() => rethrowStepFailure(technical)).toThrow(
			expect.objectContaining({
				name: "ExternalServiceError",
				userMessage: "読み込めませんでした。",
			}),
		);
		await expect(
			captureStepFailure(async () => {
				throw new TypeError("bug");
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(rethrowStepFailure({ kind: "final", text: "x" })).toEqual({
			kind: "final",
			text: "x",
		});
	});
});
