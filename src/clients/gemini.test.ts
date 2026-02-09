import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		models: {
			generateContent: mockGenerateContent,
			generateContentStream: mockGenerateContentStream,
		},
	})),
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
				{ text: "Let me think...Step 2...", phase: "thinking" },
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
