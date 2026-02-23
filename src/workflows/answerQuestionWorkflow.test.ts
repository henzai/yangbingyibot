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
	postMessage: vi.fn(),
};

vi.mock("../clients/discord", () => ({
	createDiscordWebhookClient: vi.fn(() => mockDiscordInstance),
}));

const mockGitHubInstance = {
	generateFingerprint: vi.fn(),
	isDuplicate: vi.fn(),
	createIssue: vi.fn(),
};

vi.mock("../clients/github", () => ({
	createGitHubIssueClient: vi.fn(() => mockGitHubInstance),
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
	getHistoryStep,
	getSheetDataStep,
	reportErrorToGitHub,
	saveHistoryStep,
	sendDiscordResponseStep,
	streamGeminiWithDiscordEditsStep,
	summarizeThinking,
} from "./answerQuestionWorkflow";

// Mock Analytics Engine Dataset
const mockAnalyticsDataset = {
	writeDataPoint: vi.fn(),
};

const mockKVNamespace = {
	get: vi.fn(),
	put: vi.fn(),
} as unknown as KVNamespace;

const mockEnv: Bindings = {
	DISCORD_TOKEN: "test-token",
	DISCORD_PUBLIC_KEY: "test-public-key",
	DISCORD_APPLICATION_ID: "test-app-id",
	GEMINI_API_KEY: "test-gemini-key",
	GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
	sushanshan_bot: mockKVNamespace,
	// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
	ANSWER_QUESTION_WORKFLOW: {} as Workflow<any>,
	METRICS: mockAnalyticsDataset as unknown as AnalyticsEngineDataset,
	GITHUB_TOKEN: "test-github-token",
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
			// Simulate multiple thinking chunks as the real streaming client sends them
			const thinkingChunk1 =
				"analyzing the problem in detail here, considering multiple factors";
			const thinkingChunk2 =
				" and approaches, weighing pros and cons of each option, looking at historical data for patterns and insights that might help us";
			const thinkingChunk3 =
				" and finally synthesizing all findings into a coherent answer strategy";
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
					// Individual thinking chunks (not accumulated) — matching gemini.ts behavior
					await onChunk(thinkingChunk1, "thinking");
					await onChunk(thinkingChunk2, "thinking");
					await onChunk(thinkingChunk3, "thinking");
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

			// Verify summarizeThinking received accumulated text (not just the last chunk)
			const summarizeCall = mockGenerateContent.mock.calls[0]?.[0];
			const promptText = summarizeCall?.contents as string;
			expect(promptText).toContain(thinkingChunk1);
			expect(promptText).toContain(thinkingChunk2);
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
					// Individual thinking chunks (matching gemini.ts behavior)
					await onChunk(
						"long thinking text that exceeds minimum chunk size threshold for display",
						"thinking",
					);
					await onChunk(
						" continued analysis with additional considerations and reasoning steps here",
						"thinking",
					);
					await onChunk(
						" and more thoughts to accumulate past the threshold value needed",
						"thinking",
					);
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

	describe("reportErrorToGitHub", () => {
		const sampleReport = {
			errorMessage: "Gemini API failed",
			requestId: "req-123",
			workflowId: "wf-456",
			durationMs: 5000,
			stepCount: 2,
			timestamp: "2026-02-14T12:00:00.000Z",
		};

		it("skips when GITHUB_TOKEN is not set", async () => {
			const envWithoutToken = { ...mockEnv, GITHUB_TOKEN: undefined };

			await reportErrorToGitHub(envWithoutToken, sampleReport, mockLogger);

			expect(mockGitHubInstance.generateFingerprint).not.toHaveBeenCalled();
		});

		it("skips when KV cache indicates already reported", async () => {
			mockGitHubInstance.generateFingerprint.mockReturnValue("fingerprint-1");
			vi.mocked(mockKVNamespace.get).mockResolvedValue("1");

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.isDuplicate).not.toHaveBeenCalled();
			expect(mockGitHubInstance.createIssue).not.toHaveBeenCalled();
		});

		it("skips when GitHub search finds duplicate", async () => {
			mockGitHubInstance.generateFingerprint.mockReturnValue("fingerprint-2");
			vi.mocked(mockKVNamespace.get).mockResolvedValue(null);
			mockGitHubInstance.isDuplicate.mockResolvedValue(true);

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.createIssue).not.toHaveBeenCalled();
			// Should cache in KV to avoid future searches
			expect(mockKVNamespace.put).toHaveBeenCalledWith(
				"error_reported:fingerprint-2",
				"1",
				{ expirationTtl: 3600 },
			);
		});

		it("creates issue and caches in KV on new error", async () => {
			mockGitHubInstance.generateFingerprint.mockReturnValue("fingerprint-3");
			vi.mocked(mockKVNamespace.get).mockResolvedValue(null);
			mockGitHubInstance.isDuplicate.mockResolvedValue(false);
			mockGitHubInstance.createIssue.mockResolvedValue(true);

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.createIssue).toHaveBeenCalledWith(
				sampleReport,
				"fingerprint-3",
			);
			expect(mockKVNamespace.put).toHaveBeenCalledWith(
				"error_reported:fingerprint-3",
				"1",
				{ expirationTtl: 3600 },
			);
		});

		it("does not throw on any error", async () => {
			mockGitHubInstance.generateFingerprint.mockImplementation(() => {
				throw new Error("unexpected error");
			});

			await expect(
				reportErrorToGitHub(mockEnv, sampleReport, mockLogger),
			).resolves.toBeUndefined();
		});
	});

	describe("sendDiscordResponseStep", () => {
		it("sends successful response to Discord webhook", async () => {
			mockDiscordInstance.postMessage.mockResolvedValue(true);

			const result = await sendDiscordResponseStep(
				mockEnv,
				"test-token-123",
				"user question",
				"AI answer",
				mockLogger,
			);

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledWith(
				"> user question\nAI answer",
			);
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 0 });
		});

		it("sends error response when AI fails", async () => {
			mockDiscordInstance.postMessage.mockResolvedValue(true);

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				null,
				mockLogger,
				"Some error occurred",
			);

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledWith(
				"> question\n:rotating_light: エラーが発生しました: Some error occurred",
			);
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 0 });
		});

		it("retries on failure", async () => {
			mockDiscordInstance.postMessage
				.mockRejectedValueOnce(new Error("Discord POST failed with status 500"))
				.mockResolvedValueOnce(true);

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledTimes(2);
			expect(result).toEqual({ success: true, statusCode: 200, retryCount: 1 });
		});

		it("returns failure after all retries exhausted", async () => {
			mockDiscordInstance.postMessage.mockRejectedValue(
				new Error("Discord POST failed with status 500"),
			);

			const result = await sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledTimes(3); // Initial + 2 retries
			expect(result).toEqual({
				success: false,
				statusCode: 500,
				retryCount: 2,
			});
		});
	});
});
