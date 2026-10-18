import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, WorkflowParams } from "../contracts";
import type { ILlmGateway, LlmStreamEvent } from "../llm/types";
import { searchArgs } from "../sheets/search/testFixtures";
import { memberFixture } from "../sheets/testFixtures";

const discord = {
	editOriginalMessage: vi.fn(async (_content: string) => {}),
	postMessage: vi.fn(async (_content: string) => {}),
};
const rounds: LlmStreamEvent[][] = [];
const gateway: ILlmGateway = {
	provider: "openai",
	capabilities: { reasoningSummary: true, tools: true },
	generateStream: vi.fn(async function* () {
		const events = rounds.shift();
		if (!events) throw new Error("unexpected model round");
		yield* events;
	}),
	generateText: vi.fn(),
};

vi.mock("../clients/discord", () => ({
	createDiscordWebhookClient: vi.fn(() => discord),
}));
vi.mock("../llm/factory", () => ({ createLlmGateway: vi.fn(() => gateway) }));
vi.mock("../clients/spreadSheet", () => ({ getSheetData: vi.fn() }));

import { createDiscordWebhookClient } from "../clients/discord";
import { getSheetData } from "../clients/spreadSheet";
import { AnswerQuestionWorkflow } from "./answerQuestionWorkflow";

const USAGE = {
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 10,
	reasoningTokens: 5,
	totalTokens: 115,
};

function memoryKv() {
	const data = new Map<string, string>();
	const kv = {
		get: async (key: string, type?: string) => {
			const value = data.get(key) ?? null;
			return value !== null && type === "json" ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
	} as unknown as KVNamespace;
	return { kv, data };
}

class Evicted extends Error {}

/** Persists completed step results like Workflows, and can stop the instance. */
function checkpointedSteps(evictAt?: string) {
	const cache = new Map<string, string>();
	const executed: string[] = [];
	let evicted = false;
	const step = {
		do: async (
			name: string,
			configOrCallback: unknown,
			maybeCallback?: () => Promise<unknown>,
		) => {
			if (cache.has(name)) return JSON.parse(cache.get(name) as string);
			// After eviction nothing else runs in this attempt, error steps included.
			if (evicted || name === evictAt) {
				evicted = true;
				throw new Evicted(name);
			}
			const callback = (maybeCallback ??
				configOrCallback) as () => Promise<unknown>;
			executed.push(name);
			const result = await callback();
			cache.set(name, JSON.stringify(result));
			return JSON.parse(cache.get(name) as string);
		},
	};
	return {
		step: step as unknown as WorkflowStep,
		executed,
		evictAt: (name?: string) => {
			evictAt = name;
			evicted = false;
		},
	};
}

function run(env: Bindings, step: WorkflowStep) {
	const event = {
		payload: {
			token: "interaction-token",
			message: "人工の質問",
			requestId: "req-tools",
			conversationKey: "conv",
			answerMode: "tools",
		},
		instanceId: "instance-tools",
	} as unknown as WorkflowEvent<WorkflowParams>;
	return AnswerQuestionWorkflow.prototype.run.call(
		{ env } as unknown as AnswerQuestionWorkflow,
		event,
		step,
	);
}

describe("AnswerQuestionWorkflow tool path", () => {
	let env: Bindings;
	let data: Map<string, string>;
	const writeDataPoint = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		rounds.length = 0;
		const memory = memoryKv();
		data = memory.data;
		env = {
			DISCORD_TOKEN: "test-token",
			DISCORD_PUBLIC_KEY: "test-public-key",
			DISCORD_APPLICATION_ID: "test-app-id",
			OPENAI_API_KEY: "test-openai-key",
			LLM_PROVIDER: "openai",
			LLM_MODEL: "gpt-6-luna",
			LLM_SUMMARY_ENABLED: "false",
			LLM_ANSWER_MODE: "tools",
			GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
			sushanshan_bot: memory.kv,
			// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
			ANSWER_QUESTION_WORKFLOW: {} as Workflow<any>,
			METRICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
		};
		vi.mocked(getSheetData).mockResolvedValue({
			sheetInfo: "人工TSV（ツール経路では送らない）",
			description: "人工の人格と回答規則",
			structuredSheet: memberFixture(),
		});
		rounds.push(
			[
				{ type: "text", delta: "検索前の推測" },
				{
					type: "tool_calls",
					calls: [
						{
							callId: "c1",
							name: "search_records",
							arguments: {
								ok: true,
								value: { ...searchArgs, query: "架空同名" },
							},
						},
					],
					state: { provider: "openai", items: [], pendingCallIds: ["c1"] },
				},
				{ type: "usage", usage: USAGE },
				{ type: "finish", finish: { reason: "tool_calls" } },
			],
			[
				{ type: "text", delta: "同名の候補が2人います。" },
				{ type: "usage", usage: USAGE },
				{ type: "finish", finish: { reason: "stop" } },
			],
		);
	});

	it("answers through checkpointed rounds and delivers only the final text", async () => {
		const steps = checkpointedSteps();
		await run(env, steps.step);

		expect(steps.executed).toEqual([
			"getSheetData",
			"getHistory",
			"prepareSheetTools",
			"sheetToolRound1",
			"sheetToolRound2",
			"deliverSheetToolAnswer",
			"saveHistory",
		]);
		const edits = discord.editOriginalMessage.mock.calls.map(([c]) => c);
		expect(edits.at(-1)).toBe("> 人工の質問\n同名の候補が2人います。");
		expect(edits.join()).not.toContain("検索前の推測");
		expect(discord.postMessage).not.toHaveBeenCalled();
		expect(
			vi.mocked(createDiscordWebhookClient).mock.calls[0][3],
		).toMatchObject({
			inert: true,
		});
		// The TSV is not sent on the tool path.
		const requests = vi.mocked(gateway.generateStream).mock.calls;
		expect(JSON.stringify(requests[0][0].prompt)).not.toContain("人工TSV");
		expect(JSON.parse(data.get("chat_history:v2:conv") as string)).toEqual([
			{ role: "user", text: "質問: 人工の質問" },
			{ role: "model", text: "同名の候補が2人います。" },
		]);
		expect(JSON.parse(data.get("chat_delivered:v1:conv") as string)).toEqual({
			version: 1,
			ids: [],
		});
		const events = writeDataPoint.mock.calls.map(([point]) => point.blobs);
		expect(events).toContainEqual([
			"sheet_tools_v1",
			"req-tools",
			"answered",
			"",
		]);
		expect(
			events.filter((blobs) => blobs[0] === "llm_api_call_v2").map((b) => b[4]),
		).toEqual(["answer_round", "answer_round", "answer"]);
		// Logs never carry the question, rows or provider state.
		expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("架空同名");
	});

	it("resumes after eviction without calling the model or delivering twice", async () => {
		const steps = checkpointedSteps("deliverSheetToolAnswer");
		await expect(run(env, steps.step)).rejects.toBeInstanceOf(Evicted);
		expect(gateway.generateStream).toHaveBeenCalledTimes(2);
		const editsBefore = discord.editOriginalMessage.mock.calls.length;

		steps.evictAt(undefined);
		await run(env, steps.step);

		expect(gateway.generateStream).toHaveBeenCalledTimes(2);
		const finals = discord.editOriginalMessage.mock.calls
			.slice(editsBefore)
			.map(([c]) => c);
		expect(finals).toEqual(["> 人工の質問\n同名の候補が2人います。"]);
		expect(discord.postMessage).not.toHaveBeenCalled();
		expect(
			steps.executed.filter((name) => name.startsWith("sheetToolRound")),
		).toEqual(["sheetToolRound1", "sheetToolRound2"]);
	});

	it("reports a budget stop as its own outcome without falling back to the TSV", async () => {
		rounds.length = 0;
		rounds.push([
			{ type: "usage", usage: USAGE },
			{ type: "finish", finish: { reason: "length" } },
		]);
		const steps = checkpointedSteps();
		await run(env, steps.step);

		expect(steps.executed).toEqual([
			"getSheetData",
			"getHistory",
			"prepareSheetTools",
			"sheetToolRound1",
			"sendErrorResponse",
		]);
		expect(discord.postMessage.mock.calls[0][0]).toContain(
			"検索の上限（時間・回数・データ量）に達したため",
		);
		const events = writeDataPoint.mock.calls.map(([point]) => point.blobs);
		expect(events).toContainEqual([
			"sheet_tools_v1",
			"req-tools",
			"budget_exceeded",
			"output_tokens",
		]);
		expect(data.has("chat_history:v2:conv")).toBe(false);
	});
});
