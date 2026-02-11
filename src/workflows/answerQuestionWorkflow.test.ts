import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../types";
import type { Logger } from "../utils/logger";
import type { HistoryOutput, SheetDataOutput } from "./types";

// Mock logger
const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trackTiming: vi.fn(),
	withContext: vi.fn(() => mockLogger),
} as unknown as Logger;

// Mock the clients
const mockKVInstance = {
	getCache: vi.fn(),
	getHistory: vi.fn(),
	saveCache: vi.fn(),
	saveHistory: vi.fn(),
};

const mockGeminiInstance = {
	ask: vi.fn(),
	askStream: vi.fn(),
	getHistory: vi.fn(),
};

vi.mock("../clients/kv", () => ({
	createKV: vi.fn(() => mockKVInstance),
}));

vi.mock("../clients/gemini", () => ({
	createGeminiClient: vi.fn(() => mockGeminiInstance),
}));

const mockDiscordInstance = {
	editOriginalMessage: vi.fn(),
};

vi.mock("../clients/discord", () => ({
	createDiscordWebhookClient: vi.fn(() => mockDiscordInstance),
}));

vi.mock("../clients/spreadSheet", () => ({
	getSheetData: vi.fn(),
}));

const mockGenerateContent = vi.fn();

vi.mock("@google/genai", () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		models: {
			generateContent: mockGenerateContent,
		},
	})),
}));

import { createGeminiClient } from "../clients/gemini";
import { getSheetData } from "../clients/spreadSheet";
import {
	callGeminiStep,
	getHistoryStep,
	getSheetDataStep,
	saveHistoryStep,
	sendDiscordResponseStep,
	streamGeminiWithDiscordEditsStep,
	summarizeThinking,
} from "./answerQuestionWorkflow";

// Mock Analytics Engine Dataset
const mockAnalyticsDataset = {
	writeDataPoint: vi.fn(),
};

const mockEnv: Bindings = {
	DISCORD_TOKEN: "test-token",
	DISCORD_PUBLIC_KEY: "test-public-key",
	DISCORD_APPLICATION_ID: "test-app-id",
	GEMINI_API_KEY: "test-gemini-key",
	GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
	sushanshan_bot: {} as KVNamespace,
	// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
	ANSWER_QUESTION_WORKFLOW: {} as Workflow<any>,
	METRICS: mockAnalyticsDataset as unknown as AnalyticsEngineDataset,
};

describe("AnswerQuestionWorkflow Steps", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset fetch mock
		globalThis.fetch = vi.fn();
	});

	describe("getSheetDataStep", () => {
		it("returns cached data when cache is available", async () => {
			mockKVInstance.getCache.mockResolvedValue({
				sheetInfo: "cached sheet",
				description: "cached desc",
			});

			const result = await getSheetDataStep(mockEnv, mockLogger);

			expect(result).toEqual({
				sheetInfo: "cached sheet",
				description: "cached desc",
				fromCache: true,
			});
			expect(getSheetData).not.toHaveBeenCalled();
		});

		it("fetches from Google Sheets when cache is empty", async () => {
			mockKVInstance.getCache.mockResolvedValue(null);
			vi.mocked(getSheetData).mockResolvedValue({
				sheetInfo: "fresh sheet",
				description: "fresh desc",
			});

			const result = await getSheetDataStep(mockEnv, mockLogger);

			expect(result).toEqual({
				sheetInfo: "fresh sheet",
				description: "fresh desc",
				fromCache: false,
			});
			expect(getSheetData).toHaveBeenCalledWith(
				mockEnv.GOOGLE_SERVICE_ACCOUNT,
				mockLogger,
			);
		});

		it("saves cache after fetching fresh data", async () => {
			mockKVInstance.getCache.mockResolvedValue(null);
			vi.mocked(getSheetData).mockResolvedValue({
				sheetInfo: "fresh sheet",
				description: "fresh desc",
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockKVInstance.saveCache).toHaveBeenCalledWith(
				"fresh sheet",
				"fresh desc",
			);
		});

		it("does not save cache when using cached data", async () => {
			mockKVInstance.getCache.mockResolvedValue({
				sheetInfo: "cached sheet",
				description: "cached desc",
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockKVInstance.saveCache).not.toHaveBeenCalled();
		});
	});

	describe("getHistoryStep", () => {
		it("returns history from KV", async () => {
			const existingHistory = [
				{ role: "user", text: "old question" },
				{ role: "model", text: "old answer" },
			];
			mockKVInstance.getHistory.mockResolvedValue(existingHistory);

			const result = await getHistoryStep(mockEnv, mockLogger);

			expect(result).toEqual({ history: existingHistory });
		});

		it("returns empty array when no history exists", async () => {
			mockKVInstance.getHistory.mockResolvedValue([]);

			const result = await getHistoryStep(mockEnv, mockLogger);

			expect(result).toEqual({ history: [] });
		});
	});

	describe("callGeminiStep", () => {
		it("calls Gemini with correct parameters", async () => {
			const sheetData: SheetDataOutput = {
				sheetInfo: "sheet data",
				description: "sheet description",
				fromCache: true,
			};
			const history: HistoryOutput = { history: [] };
			mockGeminiInstance.ask.mockResolvedValue("AI response");
			mockGeminiInstance.getHistory.mockReturnValue([
				{ role: "user", text: "質問: test message" },
				{ role: "model", text: "AI response" },
			]);

			const result = await callGeminiStep(
				mockEnv,
				"test message",
				sheetData,
				history,
				mockLogger,
			);

			expect(createGeminiClient).toHaveBeenCalledWith(
				mockEnv.GEMINI_API_KEY,
				[],
				mockLogger,
			);
			expect(mockGeminiInstance.ask).toHaveBeenCalledWith(
				"test message",
				"sheet data",
				"sheet description",
			);
			expect(result.response).toBe("AI response");
			expect(result.updatedHistory).toHaveLength(2);
		});

		it("passes existing history to GeminiClient", async () => {
			const existingHistory = [{ role: "user", text: "previous question" }];
			const sheetData: SheetDataOutput = {
				sheetInfo: "sheet",
				description: "desc",
				fromCache: true,
			};
			const history: HistoryOutput = { history: existingHistory };
			mockGeminiInstance.ask.mockResolvedValue("response");
			mockGeminiInstance.getHistory.mockReturnValue([]);

			await callGeminiStep(
				mockEnv,
				"new message",
				sheetData,
				history,
				mockLogger,
			);

			expect(createGeminiClient).toHaveBeenCalledWith(
				mockEnv.GEMINI_API_KEY,
				existingHistory,
				mockLogger,
			);
		});
	});

	describe("saveHistoryStep", () => {
		it("saves history to KV", async () => {
			const updatedHistory = [
				{ role: "user", text: "question" },
				{ role: "model", text: "answer" },
			];

			const result = await saveHistoryStep(mockEnv, updatedHistory, mockLogger);

			expect(mockKVInstance.saveHistory).toHaveBeenCalledWith(updatedHistory);
			expect(result).toEqual({ success: true });
		});

		it("returns success false on error", async () => {
			mockKVInstance.saveHistory.mockRejectedValue(new Error("KV error"));

			const result = await saveHistoryStep(mockEnv, [], mockLogger);

			expect(result).toEqual({ success: false });
		});
	});

	describe("streamGeminiWithDiscordEditsStep", () => {
		const sheetData: SheetDataOutput = {
			sheetInfo: "sheet data",
			description: "description",
			fromCache: true,
		};
		const history: HistoryOutput = { history: [] };

		it("streams Gemini response and edits Discord message", async () => {
			const updatedHistory = [
				{ role: "user", text: "質問: test message" },
				{ role: "model", text: "full response" },
			];
			mockGeminiInstance.askStream.mockImplementation(
				async (
					_input: string,
					_sheet: string,
					_desc: string,
					onChunk: (
						text: string,
						phase: "thinking" | "response",
					) => Promise<void>,
				) => {
					await onChunk("partial", "response");
					await onChunk("full response", "response");
					return "full response";
				},
			);
			mockGeminiInstance.getHistory.mockReturnValue(updatedHistory);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"test-token",
				"user question",
				"test message",
				sheetData,
				history,
				mockLogger,
			);

			expect(result.response).toBe("full response");
			expect(result.updatedHistory).toEqual(updatedHistory);
			// Final edit should contain only response text (not thinking)
			const lastCall =
				mockDiscordInstance.editOriginalMessage.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe("> user question\nfull response");
		});

		it("displays summarized thinking content with thought balloon", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{ content: { parts: [{ text: "問題を多角的に分析中" }] } },
				],
			});
			mockGeminiInstance.askStream.mockImplementation(
				async (
					_input: string,
					_sheet: string,
					_desc: string,
					onChunk: (
						text: string,
						phase: "thinking" | "response",
					) => Promise<void>,
				) => {
					await onChunk(
						"analyzing the problem in detail here, considering multiple factors and approaches...",
						"thinking",
					);
					await onChunk("final answer", "response");
					return "final answer";
				},
			);
			mockGeminiInstance.getHistory.mockReturnValue([]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"q",
				"message",
				sheetData,
				history,
				mockLogger,
			);

			// First edit should be summarized thinking format
			const firstCall = mockDiscordInstance.editOriginalMessage.mock
				.calls[0]?.[0] as string;
			expect(firstCall).toContain(":thought_balloon:");
			expect(firstCall).toContain("問題を多角的に分析中");
			expect(firstCall).not.toContain("```");
		});

		it("forces Discord edit on phase transition from thinking to response", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "思考要約" }] } }],
			});
			mockGeminiInstance.askStream.mockImplementation(
				async (
					_input: string,
					_sheet: string,
					_desc: string,
					onChunk: (
						text: string,
						phase: "thinking" | "response",
					) => Promise<void>,
				) => {
					await onChunk("long thinking text that exceeds minimum", "thinking");
					await onChunk("response start", "response");
					return "response start";
				},
			);
			mockGeminiInstance.getHistory.mockReturnValue([]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"message",
				sheetData,
				history,
				mockLogger,
			);

			// Should have at least: thinking edit, phase transition edit, final edit
			const calls = mockDiscordInstance.editOriginalMessage.mock.calls;
			expect(calls.length).toBeGreaterThanOrEqual(2);
			// The final call should be the response-only content
			expect(calls.at(-1)?.[0]).toBe("> question\nresponse start");
		});

		it("continues streaming when intermediate Discord edit fails", async () => {
			mockGeminiInstance.askStream.mockImplementation(
				async (
					_input: string,
					_sheet: string,
					_desc: string,
					onChunk: (
						text: string,
						phase: "thinking" | "response",
					) => Promise<void>,
				) => {
					await onChunk("response text", "response");
					return "response text";
				},
			);
			mockGeminiInstance.getHistory.mockReturnValue([]);
			// Intermediate edits may fail, but final edit succeeds
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"test-token",
				"question",
				"message",
				sheetData,
				history,
				mockLogger,
			);

			expect(result.response).toBe("response text");
		});

		it("passes existing history to GeminiClient", async () => {
			const existingHistory = [{ role: "user", text: "previous" }];
			const historyWithExisting: HistoryOutput = {
				history: existingHistory,
			};
			mockGeminiInstance.askStream.mockResolvedValue("response");
			mockGeminiInstance.getHistory.mockReturnValue([]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"message",
				sheetData,
				historyWithExisting,
				mockLogger,
			);

			expect(createGeminiClient).toHaveBeenCalledWith(
				mockEnv.GEMINI_API_KEY,
				existingHistory,
				mockLogger,
			);
		});
	});

	describe("summarizeThinking", () => {
		it("returns summarized text from LLM", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "要約結果テスト" }] } }],
			});
			const { GoogleGenAI } = await import("@google/genai");
			const client = new GoogleGenAI({ apiKey: "test" });

			const result = await summarizeThinking(
				client,
				"long thinking text here",
				mockLogger,
			);

			expect(result).toBe("要約結果テスト");
		});

		it("returns fallback on empty response", async () => {
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: "" }] } }],
			});
			const { GoogleGenAI } = await import("@google/genai");
			const client = new GoogleGenAI({ apiKey: "test" });

			const result = await summarizeThinking(
				client,
				"thinking text",
				mockLogger,
			);

			expect(result).toBe("考え中...");
		});

		it("returns fallback on API error", async () => {
			mockGenerateContent.mockRejectedValue(new Error("API error"));
			const { GoogleGenAI } = await import("@google/genai");
			const client = new GoogleGenAI({ apiKey: "test" });

			const result = await summarizeThinking(
				client,
				"thinking text",
				mockLogger,
			);

			expect(result).toBe("考え中...");
		});
	});

	describe("sendDiscordResponseStep", () => {
		it("sends successful response to Discord webhook", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(
				mockEnv,
				"test-token-123",
				"user question",
				"AI answer",
				mockLogger,
			);

			expect(mockFetch).toHaveBeenCalledWith(
				`https://discord.com/api/v10/webhooks/${mockEnv.DISCORD_APPLICATION_ID}/test-token-123`,
				{
					method: "POST",
					body: JSON.stringify({ content: "> user question\nAI answer" }),
					headers: { "Content-Type": "application/json" },
				},
			);
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 0 });
		});

		it("sends error response when AI fails", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				null,
				mockLogger,
				"Some error occurred",
			);

			expect(mockFetch).toHaveBeenCalledWith(expect.any(String), {
				method: "POST",
				body: JSON.stringify({
					content:
						"> question\n:rotating_light: エラーが発生しました: Some error occurred",
				}),
				headers: { "Content-Type": "application/json" },
			});
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 0 });
		});

		it("retries on failure", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => "Server error",
				})
				.mockResolvedValueOnce({ ok: true, status: 200 });
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);

			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 1 });
		});

		it("returns failure after all retries exhausted", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Server error"),
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);

			expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
			expect(result).toEqual({
				success: false,
				statusCode: 500,
				retryCount: 2,
			});
		});
	});
});
