import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest, LlmStreamEvent } from "../types";

const mocks = vi.hoisted(() => ({
	generate: vi.fn(),
	stream: vi.fn(),
	constructor: vi.fn(),
}));
vi.mock("@google/genai", () => ({
	ThinkingLevel: { LOW: "LOW" },
	GoogleGenAI: class {
		models = {
			generateContent: mocks.generate,
			generateContentStream: mocks.stream,
		};
		constructor(options: unknown) {
			mocks.constructor(options);
		}
	},
}));

import {
	buildAnswerPrompt,
	buildThinkingSummaryPrompt,
} from "../promptBuilder";
import { GeminiLlmGateway } from "./gemini";

const request: LlmRequest = {
	model: "configured-model",
	prompt: buildAnswerPrompt({
		description: "policy",
		knowledge: "facts",
		history: [{ role: "assistant", text: "previous" }],
		question: "question",
	}),
};

async function* chunks(...values: unknown[]) {
	for (const value of values) yield value;
}
async function collect(stream: AsyncIterable<LlmStreamEvent>) {
	const events: LlmStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
const answer = {
	candidates: [
		{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" },
	],
};

beforeEach(() => {
	vi.resetAllMocks();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Gemini LLM adapter", () => {
	it("translates the common prompt and leaves retries to the application", async () => {
		mocks.stream.mockResolvedValue(chunks(answer));
		const events = await collect(
			new GeminiLlmGateway("test-key").generateStream(request),
		);
		expect(mocks.constructor).toHaveBeenCalledWith({
			apiKey: "test-key",
			httpOptions: { retryOptions: { attempts: 1 } },
		});
		expect(mocks.stream).toHaveBeenCalledWith({
			model: "configured-model",
			contents: [
				{ role: "model", parts: [{ text: "previous" }] },
				{ role: "user", parts: [{ text: "質問: question" }] },
			],
			config: expect.objectContaining({
				systemInstruction: `${request.prompt.systemInstruction}\n---\nスプレッドシートの情報:\nfacts\n---`,
				maxOutputTokens: 8192,
				abortSignal: expect.any(AbortSignal),
				thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" },
			}),
		});
		expect(events).toEqual([
			{ type: "text", delta: "answer" },
			{
				type: "finish",
				finish: {
					reason: "stop",
					providerFinishReason: "STOP",
					providerBlockReason: undefined,
				},
			},
		]);
	});

	it.each([true, false])(
		"only emits requested public summaries (%s)",
		async (includeReasoningSummary) => {
			mocks.stream.mockResolvedValue(
				chunks({
					candidates: [
						{
							content: {
								parts: [
									{ thought: true, text: "published summary" },
									{ text: "answer" },
								],
							},
							finishReason: "STOP",
						},
					],
				}),
			);
			const events = await collect(
				new GeminiLlmGateway("key").generateStream({
					...request,
					includeReasoningSummary,
				}),
			);
			expect(
				events.filter((event) => event.type === "reasoning_summary"),
			).toEqual(
				includeReasoningSummary
					? [{ type: "reasoning_summary", delta: "published summary" }]
					: [],
			);
			expect(events.filter((event) => event.type === "text")).toEqual([
				{ type: "text", delta: "answer" },
			]);
		},
	);

	it("returns the final usage snapshot once, preserving missing counters and zeros", async () => {
		mocks.stream.mockResolvedValue(
			chunks(
				{
					...answer,
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
				},
				{
					usageMetadata: {
						promptTokenCount: 10,
						cachedContentTokenCount: 0,
						candidatesTokenCount: 7,
						thoughtsTokenCount: 2,
						totalTokenCount: 19,
					},
				},
				{},
			),
		);
		const events = await collect(
			new GeminiLlmGateway("key").generateStream(request),
		);
		expect(events.filter((event) => event.type === "usage")).toEqual([
			{
				type: "usage",
				usage: {
					inputTokens: 10,
					cachedInputTokens: 0,
					outputTokens: 7,
					reasoningTokens: 2,
					totalTokens: 19,
				},
			},
		]);
		expect(events.at(-1)).toMatchObject({
			type: "finish",
			finish: { reason: "stop" },
		});
		mocks.generate.mockResolvedValue({
			...answer,
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
		});
		expect(
			(await new GeminiLlmGateway("key").generateText(request)).usage,
		).toEqual({
			inputTokens: 10,
			cachedInputTokens: null,
			outputTokens: 0,
			reasoningTokens: null,
			totalTokens: null,
		});
	});

	it.each([
		["STOP", undefined, "stop"],
		["MAX_TOKENS", undefined, "length"],
		["SAFETY", undefined, "blocked"],
		["RECITATION", undefined, "blocked"],
		["PROHIBITED_CONTENT", undefined, "blocked"],
		["SPII", undefined, "blocked"],
		[undefined, "SAFETY", "blocked"],
		["MAX_TOKENS", "SAFETY", "blocked"],
		["OTHER", undefined, "error"],
		[undefined, undefined, "unknown"],
	])(
		"normalizes empty answers ending with %s/%s",
		async (finishReason, blockReason, reason) => {
			const response = {
				candidates: [{ finishReason }],
				promptFeedback: { blockReason },
			};
			mocks.stream.mockResolvedValue(chunks(response, {}));
			mocks.generate.mockResolvedValue(response);
			const gateway = new GeminiLlmGateway("key");
			const finish = {
				reason,
				providerFinishReason: finishReason,
				providerBlockReason: blockReason,
			};
			expect(await collect(gateway.generateStream(request))).toEqual([
				{ type: "finish", finish },
			]);
			expect(await gateway.generateText(request)).toEqual({
				text: "",
				usage: null,
				finish,
			});
		},
	);

	it("retains partial text and a length finish so callers can distinguish truncation", async () => {
		mocks.stream.mockResolvedValue(
			chunks({
				candidates: [
					{
						content: { parts: [{ text: "partial" }] },
						finishReason: "MAX_TOKENS",
					},
				],
			}),
		);
		expect(
			await collect(new GeminiLlmGateway("key").generateStream(request)),
		).toEqual([
			{ type: "text", delta: "partial" },
			{
				type: "finish",
				finish: {
					reason: "length",
					providerFinishReason: "MAX_TOKENS",
					providerBlockReason: undefined,
				},
			},
		]);
	});

	it("generates summaries using the shared text contract without returning thought parts", async () => {
		mocks.generate.mockResolvedValue({
			candidates: [
				{
					content: {
						parts: [
							{ thought: true, text: "published reasoning" },
							{},
							{ text: "summary" },
						],
					},
					finishReason: "STOP",
				},
			],
		});
		const result = await new GeminiLlmGateway("key").generateText({
			model: "summary-model",
			prompt: buildThinkingSummaryPrompt("old", "new"),
			temperature: 0,
			maxOutputTokens: 128,
		});
		expect(result).toMatchObject({
			text: "summary",
			usage: null,
			finish: { reason: "stop" },
		});
		expect(mocks.generate.mock.calls[0][0]).toMatchObject({
			model: "summary-model",
			config: { temperature: 0, maxOutputTokens: 128 },
		});
	});

	it.each([400, 401, 403, 404])(
		"does not retry permanent status %s",
		async (status) => {
			mocks.stream.mockRejectedValue(
				Object.assign(new Error("private SDK body"), { status }),
			);
			await expect(
				collect(new GeminiLlmGateway("key").generateStream(request)),
			).rejects.toMatchObject({
				service: "llm",
				provider: "gemini",
				status,
				retryable: false,
			});
			expect(mocks.stream).toHaveBeenCalledTimes(1);
		},
	);

	it("retries stream establishment at most twice and honors Retry-After", async () => {
		vi.useFakeTimers();
		mocks.stream
			.mockRejectedValueOnce({ status: 429, headers: { "retry-after": "2" } })
			.mockResolvedValueOnce(chunks(answer));
		const result = collect(new GeminiLlmGateway("key").generateStream(request));
		await vi.advanceTimersByTimeAsync(1999);
		expect(mocks.stream).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toContainEqual({ type: "text", delta: "answer" });
		expect(mocks.stream).toHaveBeenCalledTimes(2);
	});

	it("exhausts two transport attempts without leaking response bodies", async () => {
		vi.useFakeTimers();
		mocks.stream.mockRejectedValue(new Error("secret network detail"));
		const pending = collect(
			new GeminiLlmGateway("key").generateStream(request),
		).catch((error) => error);
		await vi.runAllTimersAsync();
		const error = await pending;
		expect(error).toMatchObject({ kind: "transport", retryable: true });
		expect(error.message).not.toContain("secret");
		expect(mocks.stream).toHaveBeenCalledTimes(2);
	});

	it("never replays a stream after consumption fails", async () => {
		mocks.stream.mockResolvedValue(
			(async function* () {
				yield answer;
				throw Object.assign(new Error("private SDK body"), { status: 503 });
			})(),
		);
		const events: LlmStreamEvent[] = [];
		const pending = (async () => {
			for await (const event of new GeminiLlmGateway("key").generateStream(
				request,
			))
				events.push(event);
		})();
		await expect(pending).rejects.toMatchObject({
			status: 503,
			kind: "interrupted",
			retryable: false,
		});
		expect(events).toEqual([{ type: "text", delta: "answer" }]);
		expect(mocks.stream).toHaveBeenCalledTimes(1);
	});
});

describe("request lifetime", () => {
	it("does not contact the SDK for a cancelled request", async () => {
		const controller = new AbortController();
		controller.abort(new Error("private cancellation reason"));
		await expect(
			collect(
				new GeminiLlmGateway("key").generateStream({
					...request,
					signal: controller.signal,
				}),
			),
		).rejects.toMatchObject({ kind: "cancelled", retryable: false });
		expect(mocks.stream).not.toHaveBeenCalled();
	});

	it("cancels a pending text request even when the SDK does not settle", async () => {
		const controller = new AbortController();
		mocks.generate.mockImplementation(() => new Promise(() => {}));
		const pending = new GeminiLlmGateway("key")
			.generateText({ ...request, signal: controller.signal })
			.catch((error) => error);
		controller.abort();
		expect(await pending).toMatchObject({
			kind: "cancelled",
			retryable: false,
		});
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(mocks.generate.mock.calls[0][0].config.abortSignal.aborted).toBe(
			true,
		);
	});

	it("bounds a stalled text request and removes its deadline timer", async () => {
		vi.useFakeTimers();
		mocks.generate.mockImplementation(() => new Promise(() => {}));
		const pending = new GeminiLlmGateway("key")
			.generateText({ ...request, timeoutMs: 50 })
			.catch((error) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({ kind: "timeout", retryable: false });
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("applies one deadline to retries rather than restarting the budget", async () => {
		vi.useFakeTimers();
		mocks.stream.mockRejectedValue({
			status: 429,
			headers: { "retry-after": "60" },
		});
		const pending = collect(
			new GeminiLlmGateway("key").generateStream({ ...request, timeoutMs: 50 }),
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({ kind: "timeout", retryable: false });
		expect(mocks.stream).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a stalled stream read and invokes iterator cleanup", async () => {
		vi.useFakeTimers();
		const close = vi.fn().mockResolvedValue({ done: true });
		mocks.stream.mockResolvedValue({
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise(() => {}),
				return: close,
			}),
		});
		const pending = collect(
			new GeminiLlmGateway("key").generateStream({ ...request, timeoutMs: 50 }),
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toMatchObject({ kind: "timeout", retryable: false });
		expect(close).toHaveBeenCalledTimes(1);
		expect(mocks.stream).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts and cleans up when the consumer stops early", async () => {
		vi.useFakeTimers();
		const closed = vi.fn();
		mocks.stream.mockResolvedValue(
			(async function* () {
				try {
					yield answer;
					yield answer;
				} finally {
					closed();
				}
			})(),
		);
		for await (const event of new GeminiLlmGateway("key").generateStream(
			request,
		)) {
			expect(event.type).toBe("text");
			break;
		}
		expect(mocks.stream.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid deadline %s before making a call",
		async (timeoutMs) => {
			await expect(
				new GeminiLlmGateway("key").generateText({ ...request, timeoutMs }),
			).rejects.toThrow("timeoutMs");
			expect(mocks.generate).not.toHaveBeenCalled();
		},
	);
});
