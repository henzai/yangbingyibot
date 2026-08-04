import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock("@google/genai", () => ({
	ThinkingLevel: { LOW: "LOW" },
	GoogleGenAI: vi.fn(
		class {
			models = {
				generateContent: mockGenerateContent,
				generateContentStream: mockGenerateContentStream,
			};
		},
	),
}));

import { createGeminiGateway, GeminiGateway } from "./gateway";
import type { GeminiStreamEvent } from "./types";

const prompt = {
	systemInstruction: "system",
	contents: [{ role: "user" as const, parts: [{ text: "question" }] }],
};

async function collect(
	iterable: AsyncIterable<GeminiStreamEvent>,
): Promise<GeminiStreamEvent[]> {
	const events: GeminiStreamEvent[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

describe("GeminiGateway", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes structured prompt fields and the configured model to the SDK", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "answer" }] } }],
				};
			})(),
		);

		await collect(
			new GeminiGateway("key").generateStream({
				model: "configured-model",
				prompt,
			}),
		);

		expect(mockGenerateContentStream).toHaveBeenCalledWith({
			model: "configured-model",
			contents: prompt.contents,
			config: expect.objectContaining({
				systemInstruction: "system",
				maxOutputTokens: 8192,
				thinkingConfig: {
					includeThoughts: true,
					thinkingLevel: "LOW",
				},
			}),
		});
		expect(
			mockGenerateContentStream.mock.calls[0]?.[0].config,
		).not.toHaveProperty("temperature");
		expect(
			mockGenerateContentStream.mock.calls[0]?.[0].config,
		).not.toHaveProperty("topP");
		expect(
			mockGenerateContentStream.mock.calls[0]?.[0].config,
		).not.toHaveProperty("topK");
	});

	it("emits typed thinking, accumulated response, and usage events", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [
						{
							content: {
								parts: [{ text: "thought", thought: true }, { text: "Hello " }],
							},
						},
					],
				};
				yield {
					candidates: [{ content: { parts: [{}, { text: "world" }] } }],
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 40,
						thoughtsTokenCount: 10,
						candidatesTokenCount: 20,
						totalTokenCount: 130,
					},
				};
			})(),
		);

		const events = await collect(
			new GeminiGateway("key").generateStream({
				model: "model",
				prompt,
			}),
		);

		expect(events).toEqual([
			{ type: "thinking", delta: "thought" },
			{ type: "response", delta: "Hello ", accumulated: "Hello " },
			{ type: "response", delta: "world", accumulated: "Hello world" },
			{
				type: "usage",
				usage: {
					promptTokens: 100,
					cachedTokens: 40,
					thoughtsTokens: 10,
					candidatesTokens: 20,
					totalTokens: 130,
				},
			},
			{ type: "finish", finishReason: undefined, blockReason: undefined },
		]);
	});

	it("emits the finish reason and block reason reported by the stream", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [
						{ content: { parts: [{ text: "thought", thought: true }] } },
					],
				};
				yield {
					candidates: [{ finishReason: "MAX_TOKENS" }],
					promptFeedback: { blockReason: "SAFETY" },
				};
			})(),
		);
		const log = makeLogger();

		const events = await collect(
			new GeminiGateway("key", log).generateStream({ model: "model", prompt }),
		);

		expect(events.at(-1)).toEqual({
			type: "finish",
			finishReason: "MAX_TOKENS",
			blockReason: "SAFETY",
		});
		expect(log.info).toHaveBeenCalledWith(
			"Gemini streaming API completed",
			expect.objectContaining({
				finishReason: "MAX_TOKENS",
				blockReason: "SAFETY",
			}),
		);
	});

	it("keeps the last reported finish reason instead of a later undefined one", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [
						{
							content: { parts: [{ text: "answer" }] },
							finishReason: "STOP",
						},
					],
				};
				yield { candidates: [{ content: { parts: [] } }] };
			})(),
		);

		const events = await collect(
			new GeminiGateway("key").generateStream({ model: "model", prompt }),
		);

		expect(events.at(-1)).toEqual({
			type: "finish",
			finishReason: "STOP",
			blockReason: undefined,
		});
	});

	it("normalizes an error raised while consuming the stream", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "partial" }] } }],
				};
				throw Object.assign(new Error("SDK body"), { status: 503 });
			})(),
		);

		const error = await collect(
			new GeminiGateway("key").generateStream({ model: "model", prompt }),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ExternalServiceError);
		expect(error).toMatchObject({
			service: "gemini",
			operation: "consume content stream",
			status: 503,
			retryable: true,
		});
		expect((error as Error).message).not.toContain("SDK body");
	});

	it("retries a retryable stream start error", async () => {
		vi.useFakeTimers();
		mockGenerateContentStream
			.mockRejectedValueOnce(
				Object.assign(new Error("unavailable"), { status: 503 }),
			)
			.mockResolvedValueOnce(
				(async function* () {
					yield {
						candidates: [{ content: { parts: [{ text: "answer" }] } }],
					};
				})(),
			);

		const promise = collect(
			new GeminiGateway("key").generateStream({ model: "model", prompt }),
		);
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toContainEqual({
			type: "response",
			delta: "answer",
			accumulated: "answer",
		});
		expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);
	});

	it.each([400, 401, 403, 404])(
		"does not retry permanent status %s",
		async (status) => {
			mockGenerateContentStream.mockRejectedValue(
				Object.assign(new Error("SDK body"), { status }),
			);

			const error = await collect(
				new GeminiGateway("key").generateStream({ model: "model", prompt }),
			).catch((caught: unknown) => caught);

			expect(error).toMatchObject({ status, retryable: false });
			expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
		},
	);

	it("maps a 429 to a stable user message", async () => {
		mockGenerateContentStream.mockRejectedValue(
			Object.assign(new Error("secret SDK body"), { status: 429 }),
		);

		const error = await collect(
			new GeminiGateway("key").generateStream({ model: "model", prompt }),
		).catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			status: 429,
			retryable: true,
			userMessage:
				"API使用制限に達しました。しばらく待ってから再度お試しください。",
		});
		expect((error as Error).message).not.toContain("secret SDK body");
	});

	it("generates text through the same gateway and returns typed usage", async () => {
		mockGenerateContent.mockResolvedValue({
			candidates: [
				{ content: { parts: [{ text: "要約" }, {}, { text: "結果" }] } },
			],
			usageMetadata: { promptTokenCount: 12, totalTokenCount: 16 },
		});

		const result = await new GeminiGateway("key").generateText({
			model: "summary-model",
			prompt,
			temperature: 0,
			maxOutputTokens: 128,
		});

		expect(mockGenerateContent).toHaveBeenCalledWith({
			model: "summary-model",
			contents: prompt.contents,
			config: {
				systemInstruction: "system",
				temperature: 0,
				maxOutputTokens: 128,
			},
		});
		expect(result).toEqual({
			text: "要約結果",
			usage: {
				promptTokens: 12,
				cachedTokens: 0,
				thoughtsTokens: 0,
				candidatesTokens: 0,
				totalTokens: 16,
			},
		});
	});

	it("warns without failing when usage metadata is absent", async () => {
		mockGenerateContentStream.mockResolvedValue(
			(async function* () {
				yield {
					candidates: [{ content: { parts: [{ text: "answer" }] } }],
				};
			})(),
		);
		const log = makeLogger();

		const events = await collect(
			new GeminiGateway("key", log).generateStream({ model: "model", prompt }),
		);

		expect(events).toEqual([
			{ type: "response", delta: "answer", accumulated: "answer" },
			{ type: "finish", finishReason: undefined, blockReason: undefined },
		]);
		expect(log.warn).toHaveBeenCalledWith("Gemini usage metadata missing", {
			mode: "stream",
		});
	});

	it("creates a gateway through the factory", () => {
		expect(createGeminiGateway("key")).toBeInstanceOf(GeminiGateway);
	});
});
