import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

// vitest 4 は `new` 呼び出し時に実装を Reflect.construct するため、
// コンストラクタとして使うモックの実装はアロー関数にできない（class 式で代用）
vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn(
		class {
			models = {
				generateContent: mockGenerateContent,
				generateContentStream: mockGenerateContentStream,
			};
		},
	),
}));

import { createGeminiClient, GeminiClient } from "./gemini";

describe("GeminiClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor", () => {
		it("initializes with empty history by default", () => {
			const client = new GeminiClient("test-api-key");
			expect(client.getHistory()).toEqual([]);
		});

		it("initializes with provided history", () => {
			const history = [{ role: "user", text: "previous question" }];
			const client = new GeminiClient("test-api-key", history);
			expect(client.getHistory()).toEqual(history);
		});
	});

	describe("ask", () => {
		it("returns generated response text", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [{ text: "AI response" }],
						},
					},
				],
			});

			const client = new GeminiClient("test-api-key");
			const result = await client.ask("question", "sheet data", "description");

			expect(result).toBe("AI response");
		});

		it("adds user question and model response to history", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [{ text: "AI response" }],
						},
					},
				],
			});

			const client = new GeminiClient("test-api-key");
			await client.ask("test question", "sheet", "desc");

			const history = client.getHistory();
			expect(history).toHaveLength(2);
			expect(history[0].role).toBe("user");
			expect(history[0].text).toBe("質問: test question");
			expect(history[1].role).toBe("model");
			expect(history[1].text).toBe("AI response");
		});

		it("throws error when response has no candidates", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: null,
			});

			const client = new GeminiClient("test-api-key");

			await expect(client.ask("q", "s", "d")).rejects.toThrow(
				"AIからの応答形式が不正です。",
			);
		});

		it("throws error when response has empty candidates array", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [],
			});

			const client = new GeminiClient("test-api-key");

			await expect(client.ask("q", "s", "d")).rejects.toThrow(
				"AIからの応答形式が不正です。",
			);
		});

		it("throws error when response has no text", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [{ text: null }],
						},
					},
				],
			});

			const client = new GeminiClient("test-api-key");

			await expect(client.ask("q", "s", "d")).rejects.toThrow(
				"AIから有効な応答が得られませんでした。",
			);
		});

		it("includes conversation history in subsequent calls", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [{ text: "response" }],
						},
					},
				],
			});

			const history = [{ role: "user", text: "previous" }];
			const client = new GeminiClient("test-api-key", history);

			await client.ask("new question", "sheet", "desc");

			expect(mockGenerateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					contents: expect.stringContaining("previous"),
				}),
			);
		});
	});

	describe("askStream", () => {
		// Helper to create a mock chunk with candidates/parts structure
		const makeChunk = (parts: { text?: string; thought?: boolean }[]) => ({
			candidates: [{ content: { parts } }],
		});

		it("accumulates streamed text and calls onChunk with response phase", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "Hello " }]);
				yield makeChunk([{ text: "world" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const chunks: { text: string; phase: string }[] = [];
			const client = new GeminiClient("test-api-key");
			const result = await client.askStream(
				"question",
				"sheet",
				"desc",
				async (text, phase) => {
					chunks.push({ text, phase });
				},
			);

			expect(result).toBe("Hello world");
			expect(chunks).toEqual([
				{ text: "Hello ", phase: "response" },
				{ text: "Hello world", phase: "response" },
			]);
		});

		it("calls onChunk with thinking phase for thought parts", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "Let me think...", thought: true }]);
				yield makeChunk([{ text: "Step 2...", thought: true }]);
				yield makeChunk([{ text: "The answer is 42" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const chunks: { text: string; phase: string }[] = [];
			const client = new GeminiClient("test-api-key");
			const result = await client.askStream(
				"q",
				"s",
				"d",
				async (text, phase) => {
					chunks.push({ text, phase });
				},
			);

			expect(result).toBe("The answer is 42");
			expect(chunks).toEqual([
				{ text: "Let me think...", phase: "thinking" },
				{ text: "Step 2...", phase: "thinking" },
				{ text: "The answer is 42", phase: "response" },
			]);
		});

		it("excludes thinking text from return value and history", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "thinking stuff", thought: true }]);
				yield makeChunk([{ text: "actual response" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			const result = await client.askStream("q", "s", "d", async () => {});

			expect(result).toBe("actual response");
			const history = client.getHistory();
			expect(history[1].text).toBe("actual response");
		});

		it("updates history after streaming completes", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "streamed response" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			await client.askStream("test question", "sheet", "desc", async () => {});

			const history = client.getHistory();
			expect(history).toHaveLength(2);
			expect(history[0]).toEqual({
				role: "user",
				text: "質問: test question",
			});
			expect(history[1]).toEqual({
				role: "model",
				text: "streamed response",
			});
		});

		it("throws on empty streaming response", async () => {
			const mockStream = (async function* () {
				// yields nothing
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			await expect(
				client.askStream("q", "s", "d", async () => {}),
			).rejects.toThrow("AIから有効な応答が得られませんでした。");
		});

		it("throws on thinking-only response with no response text", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "just thinking", thought: true }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			await expect(
				client.askStream("q", "s", "d", async () => {}),
			).rejects.toThrow("AIから有効な応答が得られませんでした。");
		});

		it("does not update history if stream fails mid-way", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "partial" }]);
				throw new Error("stream interrupted");
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			await expect(
				client.askStream("q", "s", "d", async () => {}),
			).rejects.toThrow("AI APIへのリクエストに失敗しました。");
			expect(client.getHistory()).toEqual([]);
		});

		it("skips parts with no text", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "Hello" }]);
				yield { candidates: [{ content: { parts: [{}] } }] };
				yield makeChunk([{ text: " world" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const chunks: { text: string; phase: string }[] = [];
			const client = new GeminiClient("test-api-key");
			const result = await client.askStream(
				"q",
				"s",
				"d",
				async (text, phase) => {
					chunks.push({ text, phase });
				},
			);

			expect(result).toBe("Hello world");
			expect(chunks).toEqual([
				{ text: "Hello", phase: "response" },
				{ text: "Hello world", phase: "response" },
			]);
		});

		it("handles chunks with missing candidates gracefully", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "Hello" }]);
				yield {}; // no candidates (e.g., usage metadata chunk)
				yield makeChunk([{ text: " world" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const client = new GeminiClient("test-api-key");
			const result = await client.askStream("q", "s", "d", async () => {});

			expect(result).toBe("Hello world");
		});

		it("includes conversation history in prompt", async () => {
			const mockStream = (async function* () {
				yield makeChunk([{ text: "response" }]);
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const history = [{ role: "user", text: "previous" }];
			const client = new GeminiClient("test-api-key", history);

			await client.askStream("new question", "sheet", "desc", async () => {});

			expect(mockGenerateContentStream).toHaveBeenCalledWith(
				expect.objectContaining({
					contents: expect.stringContaining("previous"),
				}),
			);
		});
	});

	describe("handleUnexpectedError (outer catch)", () => {
		describe("ask", () => {
			it("re-throws errors containing 'API' in message", async () => {
				mockGenerateContent.mockResolvedValue({
					candidates: null,
				});

				const client = new GeminiClient("test-api-key");

				// "AIからの応答形式が不正です。" thrown in validation, re-thrown by handleUnexpectedError
				// because it contains "AI"
				await expect(client.ask("q", "s", "d")).rejects.toThrow(
					"AIからの応答形式が不正です。",
				);
			});

			it("converts non-API/AI errors to generic message", async () => {
				// Pass null in history to cause a TypeError in buildPrompt's map()
				// TypeError message doesn't contain "API" or "AI"
				const client = new GeminiClient("test-api-key", [
					null as unknown as { role: string; text: string },
				]);

				await expect(client.ask("q", "s", "d")).rejects.toThrow(
					"AI処理中に予期しないエラーが発生しました。",
				);
			});
		});

		describe("askStream", () => {
			it("re-throws errors containing 'AI' in message", async () => {
				const mockStream = (async function* () {
					// yields nothing
				})();
				mockGenerateContentStream.mockResolvedValue(mockStream);

				const client = new GeminiClient("test-api-key");

				// Empty stream triggers "AIから有効な応答が得られませんでした。" which contains "AI"
				await expect(
					client.askStream("q", "s", "d", async () => {}),
				).rejects.toThrow("AIから有効な応答が得られませんでした。");
			});

			it("converts non-API/AI errors to generic message", async () => {
				// Pass null in history to cause a TypeError in buildPrompt's map()
				// TypeError message doesn't contain "API" or "AI"
				const client = new GeminiClient("test-api-key", [
					null as unknown as { role: string; text: string },
				]);

				await expect(
					client.askStream("q", "s", "d", async () => {}),
				).rejects.toThrow("AI処理中に予期しないエラーが発生しました。");
			});
		});
	});

	describe("token usage logging", () => {
		const makeLogger = () => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			withContext: vi.fn().mockReturnThis(),
		});

		const usageOf = (log: ReturnType<typeof makeLogger>) =>
			log.info.mock.calls.find(
				([message]) => message === "Gemini token usage",
			)?.[1];

		it("logs the token breakdown from a non-streaming response", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "AI response" }] } }],
				usageMetadata: {
					promptTokenCount: 110000,
					cachedContentTokenCount: 88000,
					thoughtsTokenCount: 800,
					candidatesTokenCount: 400,
					totalTokenCount: 111200,
				},
			});

			const log = makeLogger();
			await new GeminiClient("test-api-key", [], log).ask("q", "s", "d");

			expect(usageOf(log)).toMatchObject({
				mode: "generate",
				promptTokens: 110000,
				cachedTokens: 88000,
				cachedRatio: 0.8,
				thoughtsTokens: 800,
				candidatesTokens: 400,
				totalTokens: 111200,
			});
		});

		it("logs usage carried on the final streaming chunk", async () => {
			const mockStream = (async function* () {
				yield { candidates: [{ content: { parts: [{ text: "Hello" }] } }] };
				yield {
					candidates: [{ content: { parts: [{ text: " world" }] } }],
					usageMetadata: {
						promptTokenCount: 1000,
						cachedContentTokenCount: 250,
						totalTokenCount: 1200,
					},
				};
			})();
			mockGenerateContentStream.mockResolvedValue(mockStream);

			const log = makeLogger();
			await new GeminiClient("test-api-key", [], log).askStream(
				"q",
				"s",
				"d",
				async () => {},
			);

			expect(usageOf(log)).toMatchObject({
				mode: "stream",
				promptTokens: 1000,
				cachedTokens: 250,
				cachedRatio: 0.25,
			});
		});

		it("reports a zero cache ratio when nothing was cached", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "AI response" }] } }],
				usageMetadata: { promptTokenCount: 500, totalTokenCount: 600 },
			});

			const log = makeLogger();
			await new GeminiClient("test-api-key", [], log).ask("q", "s", "d");

			expect(usageOf(log)).toMatchObject({ cachedTokens: 0, cachedRatio: 0 });
		});

		it("uses a null ratio rather than dividing by zero", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "AI response" }] } }],
				usageMetadata: { totalTokenCount: 0 },
			});

			const log = makeLogger();
			await new GeminiClient("test-api-key", [], log).ask("q", "s", "d");

			expect(usageOf(log)).toMatchObject({
				promptTokens: 0,
				cachedRatio: null,
			});
		});

		it("warns instead of throwing when usage metadata is absent", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "AI response" }] } }],
			});

			const log = makeLogger();
			const result = await new GeminiClient("test-api-key", [], log).ask(
				"q",
				"s",
				"d",
			);

			expect(result).toBe("AI response");
			expect(usageOf(log)).toBeUndefined();
			expect(log.warn).toHaveBeenCalledWith("Gemini usage metadata missing", {
				mode: "generate",
			});
		});
	});

	describe("createGeminiClient", () => {
		it("creates a new GeminiClient instance", () => {
			const client = createGeminiClient("test-api-key");
			expect(client).toBeInstanceOf(GeminiClient);
		});

		it("creates client with initial history", () => {
			const history = [{ role: "user", text: "hello" }];
			const client = createGeminiClient("test-api-key", history);
			expect(client.getHistory()).toEqual(history);
		});
	});
});
