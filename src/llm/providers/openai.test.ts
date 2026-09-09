import type OpenAI from "openai";
import type {
	Response,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnswerPrompt } from "../promptBuilder";
import type { LlmRequest, LlmStreamEvent } from "../types";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	retrieve: vi.fn(),
	constructor: vi.fn(),
}));
vi.mock("openai", () => ({
	default: class {
		responses = { create: mocks.create };
		models = { retrieve: mocks.retrieve };
		constructor(options: unknown) {
			mocks.constructor(options);
		}
	},
}));

import { OpenAILlmGateway } from "./openai";

const request: LlmRequest = {
	model: "configured-model",
	prompt: buildAnswerPrompt({
		description: "policy",
		knowledge: "facts",
		history: [{ role: "assistant", text: "previous" }],
		question: "question",
	}),
};

function response(overrides: Record<string, unknown> = {}): Response {
	return {
		id: "resp_test",
		created_at: 0,
		object: "response",
		model: "configured-model",
		status: "completed",
		output_text: "answer",
		output: [
			{
				id: "msg_test",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "answer", annotations: [] }],
			},
		],
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		parallel_tool_calls: false,
		previous_response_id: null,
		reasoning: null,
		store: false,
		temperature: null,
		tool_choice: "none",
		tools: [],
		top_p: null,
		truncation: "disabled",
		usage: null,
		...overrides,
	} as unknown as Response;
}

function event(value: Record<string, unknown>): ResponseStreamEvent {
	return value as unknown as ResponseStreamEvent;
}

async function* events(...values: ResponseStreamEvent[]) {
	for (const value of values) yield value;
}

async function collect(stream: AsyncIterable<LlmStreamEvent>) {
	const result: LlmStreamEvent[] = [];
	for await (const value of stream) result.push(value);
	return result;
}

beforeEach(() => {
	vi.resetAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("OpenAI LLM adapter", () => {
	it("probes one selected model without creating a Response", async () => {
		mocks.retrieve.mockResolvedValue({
			id: "configured-model",
			object: "model",
			created: 0,
			owned_by: "openai",
		});

		await expect(
			new OpenAILlmGateway("test-key").probe({ model: "configured-model" }),
		).resolves.toEqual({
			status: "available",
			scope: "model_metadata",
			generationSupport: "unverified",
			detail:
				"Model availability was verified; Responses generation was not executed",
		});
		expect(mocks.retrieve).toHaveBeenCalledWith("configured-model", {
			signal: expect.any(AbortSignal),
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("accepts a replaceable Responses client", async () => {
		const create = vi.fn().mockResolvedValue(response());
		const responses = { create } as unknown as OpenAI["responses"];
		await new OpenAILlmGateway("unused-key", undefined, responses).generateText(
			request,
		);
		expect(create).toHaveBeenCalledOnce();
		expect(mocks.constructor).not.toHaveBeenCalled();
	});

	it("uses stateless Responses input without silent context truncation", async () => {
		mocks.create.mockResolvedValue(
			events(event({ type: "response.completed", response: response() })),
		);
		await collect(new OpenAILlmGateway("test-key").generateStream(request));

		expect(mocks.constructor).toHaveBeenCalledWith({
			apiKey: "test-key",
			maxRetries: 0,
			timeout: 90_000,
		});
		expect(mocks.create).toHaveBeenCalledWith(
			{
				model: "configured-model",
				instructions: request.prompt.systemInstruction,
				input: [
					{
						role: "developer",
						content: expect.stringContaining("facts"),
					},
					{ role: "assistant", content: "previous" },
					{ role: "user", content: "質問: question" },
				],
				store: false,
				truncation: "disabled",
				stream: true,
			},
			{ signal: expect.any(AbortSignal) },
		);
		const body = mocks.create.mock.calls[0][0];
		expect(body).not.toHaveProperty("conversation");
		expect(body).not.toHaveProperty("previous_response_id");
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("reasoning");
	});

	it("sends only model-supported optional parameters", async () => {
		mocks.create.mockResolvedValue(response());
		const gateway = new OpenAILlmGateway("key");
		await gateway.generateText({
			...request,
			model: "gpt-4.1-mini",
			temperature: 0,
			maxOutputTokens: 128,
			includeReasoningSummary: true,
		});
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			model: "gpt-4.1-mini",
			temperature: 0,
			max_output_tokens: 128,
		});
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("reasoning");

		await gateway.generateText({
			...request,
			model: "o3",
			temperature: 0,
			includeReasoningSummary: true,
		});
		expect(mocks.create.mock.calls[1][0]).toMatchObject({
			model: "o3",
			reasoning: { summary: "auto" },
		});
		expect(mocks.create.mock.calls[1][0]).not.toHaveProperty("temperature");

		await gateway.generateText({
			...request,
			model: "future-unknown-model",
			temperature: 0,
			includeReasoningSummary: true,
		});
		expect(mocks.create.mock.calls[2][0]).not.toHaveProperty("temperature");
		expect(mocks.create.mock.calls[2][0]).not.toHaveProperty("reasoning");
	});

	it("maps text, public reasoning summaries, and one final usage snapshot", async () => {
		const completed = response({
			usage: {
				input_tokens: 20,
				input_tokens_details: { cached_tokens: 5 },
				output_tokens: 11,
				output_tokens_details: { reasoning_tokens: 4 },
				total_tokens: 31,
			},
		});
		mocks.create.mockResolvedValue(
			events(
				event({
					type: "response.reasoning_summary_text.delta",
					delta: "published summary",
				}),
				event({ type: "response.output_text.delta", delta: "answer" }),
				event({ type: "response.completed", response: completed }),
			),
		);
		expect(
			await collect(
				new OpenAILlmGateway("key").generateStream({
					...request,
					model: "o3",
					includeReasoningSummary: true,
				}),
			),
		).toEqual([
			{ type: "reasoning_summary", delta: "published summary" },
			{ type: "text", delta: "answer" },
			{
				type: "usage",
				usage: {
					inputTokens: 20,
					cachedInputTokens: 5,
					outputTokens: 7,
					reasoningTokens: 4,
					totalTokens: 31,
				},
			},
			{
				type: "finish",
				finish: { reason: "stop", providerFinishReason: "completed" },
			},
		]);
	});

	it("supports text-only streams and missing usage", async () => {
		mocks.create.mockResolvedValue(
			events(event({ type: "response.output_text.delta", delta: "text" })),
		);
		expect(
			await collect(new OpenAILlmGateway("key").generateStream(request)),
		).toEqual([
			{ type: "text", delta: "text" },
			{ type: "finish", finish: { reason: "unknown" } },
		]);
	});

	it("maps refusal without exposing refusal text", async () => {
		mocks.create.mockResolvedValue(
			events(
				event({ type: "response.refusal.delta", delta: "private refusal" }),
				event({ type: "response.completed", response: response() }),
			),
		);
		expect(
			await collect(new OpenAILlmGateway("key").generateStream(request)),
		).toEqual([
			{
				type: "finish",
				finish: {
					reason: "blocked",
					providerFinishReason: "completed",
					providerBlockReason: "refusal",
				},
			},
		]);
	});

	it.each([
		["max_output_tokens", "length"],
		["max_messages", "length"],
		["content_filter", "blocked"],
		["steered", "error"],
	] as const)("maps incomplete reason %s to %s", async (detail, reason) => {
		mocks.create.mockResolvedValue(
			response({
				status: "incomplete",
				output_text: "partial",
				incomplete_details: { reason: detail },
			}),
		);
		expect(
			await new OpenAILlmGateway("key").generateText(request),
		).toMatchObject({
			text: "partial",
			finish: {
				reason,
				providerFinishReason: "incomplete",
				providerBlockReason: detail,
			},
		});
	});

	it("preserves unknown usage counters instead of double counting", async () => {
		mocks.create.mockResolvedValue(
			response({
				usage: {
					input_tokens: 10,
					input_tokens_details: {},
					output_tokens: 4,
					output_tokens_details: {},
				},
			}),
		);
		expect(
			(await new OpenAILlmGateway("key").generateText(request)).usage,
		).toEqual({
			inputTokens: 10,
			cachedInputTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			totalTokens: null,
		});
	});

	it("retries stream establishment but never replays interrupted consumption", async () => {
		vi.useFakeTimers();
		const onAttempt = vi.fn();
		const onFirstText = vi.fn();
		mocks.create
			.mockRejectedValueOnce({ status: 429, headers: { "retry-after": "1" } })
			.mockResolvedValueOnce(
				(async function* () {
					yield event({ type: "response.output_text.delta", delta: "partial" });
					throw Object.assign(new Error("private body"), { status: 503 });
				})(),
			);
		const seen: LlmStreamEvent[] = [];
		const pending = (async () => {
			for await (const value of new OpenAILlmGateway("key").generateStream({
				...request,
				telemetry: { onAttempt, onFirstText },
			}))
				seen.push(value);
		})().catch((error) => error);
		await vi.advanceTimersByTimeAsync(1000);
		const error = await pending;
		expect(error).toMatchObject({
			provider: "openai",
			status: 503,
			kind: "interrupted",
			retryable: false,
		});
		expect(seen).toEqual([{ type: "text", delta: "partial" }]);
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(onAttempt).toHaveBeenCalledTimes(2);
		expect(onFirstText).toHaveBeenCalledOnce();
		expect(error.message).not.toContain("private");
	});

	it("turns an in-band stream error into an interrupted failure", async () => {
		mocks.create.mockResolvedValue(
			events(event({ type: "error", message: "private body" })),
		);
		await expect(
			collect(new OpenAILlmGateway("key").generateStream(request)),
		).rejects.toMatchObject({ kind: "interrupted", retryable: false });
	});

	it("maps a failed terminal response to an error finish", async () => {
		mocks.create.mockResolvedValue(
			events(
				event({
					type: "response.failed",
					response: response({
						status: "failed",
						output_text: "",
						error: { code: "server_error", message: "private body" },
					}),
				}),
			),
		);
		expect(
			await collect(new OpenAILlmGateway("key").generateStream(request)),
		).toContainEqual({
			type: "finish",
			finish: {
				reason: "error",
				providerFinishReason: "failed",
				providerBlockReason: "server_error",
			},
		});
	});

	it.each([401, 403])(
		"does not retry authentication status %s",
		async (status) => {
			mocks.create.mockRejectedValue(
				Object.assign(new Error("private body"), { status }),
			);
			await expect(
				new OpenAILlmGateway("key").generateText(request),
			).rejects.toMatchObject({
				provider: "openai",
				status,
				retryable: false,
			});
			expect(mocks.create).toHaveBeenCalledTimes(1);
		},
	);

	it("retries a 5xx error while establishing a stream", async () => {
		vi.useFakeTimers();
		mocks.create
			.mockRejectedValueOnce(
				Object.assign(new Error("private body"), { status: 503 }),
			)
			.mockResolvedValueOnce(
				events(event({ type: "response.completed", response: response() })),
			);
		const pending = collect(
			new OpenAILlmGateway("key").generateStream(request),
		);
		await vi.runAllTimersAsync();
		expect(await pending).toContainEqual(
			expect.objectContaining({ type: "finish" }),
		);
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it("bounds a stalled SDK request with the common deadline", async () => {
		vi.useFakeTimers();
		mocks.create.mockImplementation(() => new Promise(() => {}));
		const pending = new OpenAILlmGateway("key")
			.generateText({ ...request, timeoutMs: 50 })
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({
			provider: "openai",
			kind: "timeout",
			retryable: false,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("propagates caller cancellation without retrying", async () => {
		const controller = new AbortController();
		mocks.create.mockImplementation(() => new Promise(() => {}));
		const pending = new OpenAILlmGateway("key")
			.generateText({ ...request, signal: controller.signal })
			.catch((error) => error);
		controller.abort(new Error("private cancellation reason"));
		expect(await pending).toMatchObject({
			provider: "openai",
			kind: "cancelled",
			retryable: false,
		});
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true);
	});
});
