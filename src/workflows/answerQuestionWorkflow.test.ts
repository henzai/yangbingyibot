import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, HistoryEntry } from "../contracts";
import { formatAnswer } from "../discord/formatter";
import type { GeminiStreamEvent } from "../gemini/types";
import { ExternalServiceError } from "../utils/errors";
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

// Mock the repositories and clients
const mockSheetCacheRepository = {
	get: vi.fn(),
	save: vi.fn(),
};

const mockHistoryRepository = {
	get: vi.fn(),
	save: vi.fn(),
};

const mockDeduplicationStore = {
	isMarked: vi.fn(),
	mark: vi.fn(),
};

const mockGeminiGateway = {
	generateStream: vi.fn(),
	generateText: vi.fn(),
};

const mockThinkingSummarizer = {
	summarize: vi.fn(),
};

vi.mock("../repositories/sheetCache", () => ({
	createSheetCacheRepository: vi.fn(() => mockSheetCacheRepository),
}));

vi.mock("../repositories/conversationHistory", () => ({
	createConversationHistoryRepository: vi.fn(() => mockHistoryRepository),
}));

vi.mock("../repositories/deduplicationStore", () => ({
	createDeduplicationStore: vi.fn(() => mockDeduplicationStore),
}));

vi.mock("../gemini/gateway", () => ({
	createGeminiGateway: vi.fn(() => mockGeminiGateway),
}));

vi.mock("../gemini/thinkingSummarizer", () => ({
	createThinkingSummarizer: vi.fn(() => mockThinkingSummarizer),
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

import { getSheetData } from "../clients/spreadSheet";
import { createGeminiGateway } from "../gemini/gateway";
import { createThinkingSummarizer } from "../gemini/thinkingSummarizer";
import { createConversationHistoryRepository } from "../repositories/conversationHistory";
import {
	getHistoryStep,
	getSheetDataStep,
	reportErrorToGitHub,
	saveHistoryStep,
	sendDiscordResponseStep,
	streamGeminiWithDiscordEditsStep,
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
		mockDeduplicationStore.isMarked.mockResolvedValue(false);
		mockThinkingSummarizer.summarize.mockResolvedValue({
			text: "思考要約",
			usage: null,
			success: true,
		});
		// Reset fetch mock
		globalThis.fetch = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getSheetDataStep", () => {
		it("returns cached data when cache is available", async () => {
			mockSheetCacheRepository.get.mockResolvedValue({
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
			expect(mockSheetCacheRepository.get).toHaveBeenCalledWith({
				id: "1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg",
				dataSheetName: "test",
				descriptionSheetName: "description",
			});
		});

		it("fetches from Google Sheets when cache is empty", async () => {
			mockSheetCacheRepository.get.mockResolvedValue(null);
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
				{
					id: "1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg",
					dataSheetName: "test",
					descriptionSheetName: "description",
				},
			);
		});

		it("saves cache after fetching fresh data", async () => {
			mockSheetCacheRepository.get.mockResolvedValue(null);
			vi.mocked(getSheetData).mockResolvedValue({
				sheetInfo: "fresh sheet",
				description: "fresh desc",
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockSheetCacheRepository.save).toHaveBeenCalledWith(
				{
					id: "1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg",
					dataSheetName: "test",
					descriptionSheetName: "description",
				},
				"fresh sheet",
				"fresh desc",
			);
		});

		it("does not save cache when using cached data", async () => {
			mockSheetCacheRepository.get.mockResolvedValue({
				sheetInfo: "cached sheet",
				description: "cached desc",
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockSheetCacheRepository.save).not.toHaveBeenCalled();
		});
	});

	describe("getHistoryStep", () => {
		it("returns history from KV", async () => {
			const existingHistory = [
				{ role: "user", text: "old question" },
				{ role: "model", text: "old answer" },
			];
			mockHistoryRepository.get.mockResolvedValue(existingHistory);

			const result = await getHistoryStep(
				mockEnv,
				"conversation-key",
				mockLogger,
			);

			expect(result).toEqual({ history: existingHistory });
			expect(mockHistoryRepository.get).toHaveBeenCalledWith(
				"conversation-key",
			);
		});

		it("returns empty array when no history exists", async () => {
			mockHistoryRepository.get.mockResolvedValue([]);

			const result = await getHistoryStep(
				mockEnv,
				"conversation-key",
				mockLogger,
			);

			expect(result).toEqual({ history: [] });
		});

		it("uses the configured history TTL", async () => {
			mockHistoryRepository.get.mockResolvedValue([]);

			await getHistoryStep(
				{ ...mockEnv, HISTORY_TTL_SECONDS: "900" },
				"conversation-key",
				mockLogger,
			);

			expect(createConversationHistoryRepository).toHaveBeenCalledWith(
				mockEnv.sushanshan_bot,
				900,
				mockLogger,
			);
		});

		it("skips history for an in-flight workflow without a conversation key", async () => {
			const result = await getHistoryStep(mockEnv, undefined, mockLogger);

			expect(result).toEqual({ history: [] });
			expect(mockHistoryRepository.get).not.toHaveBeenCalled();
		});
	});

	describe("saveHistoryStep", () => {
		it("saves history to KV", async () => {
			const updatedHistory: HistoryEntry[] = [
				{ role: "user", text: "question" },
				{ role: "model", text: "answer" },
			];

			const result = await saveHistoryStep(
				mockEnv,
				"conversation-key",
				updatedHistory,
				mockLogger,
			);

			expect(mockHistoryRepository.save).toHaveBeenCalledWith(
				"conversation-key",
				updatedHistory,
			);
			expect(result).toEqual({ success: true });
		});

		it("returns success false on error", async () => {
			mockHistoryRepository.save.mockRejectedValue(new Error("KV error"));

			const result = await saveHistoryStep(
				mockEnv,
				"conversation-key",
				[],
				mockLogger,
			);

			expect(result).toEqual({ success: false });
		});

		it("skips save for an in-flight workflow without a conversation key", async () => {
			const result = await saveHistoryStep(mockEnv, undefined, [], mockLogger);

			expect(result).toEqual({ success: false });
			expect(mockHistoryRepository.save).not.toHaveBeenCalled();
		});
	});

	describe("streamGeminiWithDiscordEditsStep", () => {
		const sheetData: SheetDataOutput = {
			sheetInfo: "sheet data",
			description: "description",
			fromCache: true,
		};
		const history: HistoryOutput = { history: [] };

		const mockStream = (events: GeminiStreamEvent[]) => {
			mockGeminiGateway.generateStream.mockImplementation(async function* () {
				for (const event of events) {
					yield event;
				}
			});
		};

		it("streams typed events, edits Discord, and returns history and usage", async () => {
			const updatedHistory: HistoryEntry[] = [
				{ role: "user", text: "質問: test message" },
				{ role: "model", text: "full response" },
			];
			mockStream([
				{ type: "response", delta: "partial", accumulated: "partial" },
				{
					type: "response",
					delta: " response",
					accumulated: "full response",
				},
				{
					type: "usage",
					usage: {
						promptTokens: 100,
						cachedTokens: 25,
						thoughtsTokens: 10,
						candidatesTokens: 20,
						totalTokens: 130,
					},
				},
			]);
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
			expect(result.usage).toEqual({
				promptTokens: 100,
				cachedTokens: 25,
				thoughtsTokens: 10,
				candidatesTokens: 20,
				totalTokens: 130,
			});
			const lastCall =
				mockDiscordInstance.editOriginalMessage.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe("> user question\nfull response");
		});

		it("delivers a long final answer in ordered chunks without loss", async () => {
			const response = "a".repeat(4500);
			mockStream([
				{ type: "response", delta: response, accumulated: response },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(undefined);
			mockDiscordInstance.postMessage.mockResolvedValue(undefined);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"test-token",
				"question",
				"message",
				sheetData,
				history,
				mockLogger,
			);

			const deliveredChunks = [
				mockDiscordInstance.editOriginalMessage.mock.calls[0]?.[0] as string,
				...mockDiscordInstance.postMessage.mock.calls.map(
					([content]) => content as string,
				),
			];
			expect(deliveredChunks.every((chunk) => chunk.length <= 2000)).toBe(true);
			expect(deliveredChunks.join("")).toBe(formatAnswer("question", response));
			expect(result).toMatchObject({
				editCount: 2,
				chunkCount: 2,
				deliveryStatus: "success",
				failedChunks: [],
			});
		});

		it("rejects an empty Gemini answer before persisting history", async () => {
			mockStream([{ type: "thinking", delta: "thought only" }]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(undefined);

			await expect(
				streamGeminiWithDiscordEditsStep(
					mockEnv,
					"token",
					"question",
					"message",
					sheetData,
					history,
					mockLogger,
				),
			).rejects.toMatchObject({
				service: "gemini",
				operation: "validate streamed response",
				retryable: false,
			});

			expect(mockDiscordInstance.postMessage).not.toHaveBeenCalled();
		});

		it("logs the finish reason and token budget when the answer is empty", async () => {
			mockStream([
				{ type: "thinking", delta: "thought only" },
				{
					type: "usage",
					usage: {
						promptTokens: 100,
						cachedTokens: 0,
						thoughtsTokens: 8192,
						candidatesTokens: 0,
						totalTokens: 8292,
					},
				},
				{ type: "finish", finishReason: "MAX_TOKENS" },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(undefined);

			await expect(
				streamGeminiWithDiscordEditsStep(
					mockEnv,
					"token",
					"question",
					"message",
					sheetData,
					history,
					mockLogger,
				),
			).rejects.toThrow();

			expect(mockLogger.error).toHaveBeenCalledWith(
				"Gemini returned an empty answer",
				{
					finishReason: "MAX_TOKENS",
					blockReason: undefined,
					thinkingLength: "thought only".length,
					thoughtsTokens: 8192,
				},
			);
		});

		it("explains a token-budget exhaustion to the user", async () => {
			mockStream([
				{ type: "thinking", delta: "thought only" },
				{ type: "finish", finishReason: "MAX_TOKENS" },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(undefined);

			await expect(
				streamGeminiWithDiscordEditsStep(
					mockEnv,
					"token",
					"question",
					"message",
					sheetData,
					history,
					mockLogger,
				),
			).rejects.toMatchObject({
				service: "gemini",
				operation: "validate streamed response",
				retryable: false,
				userMessage:
					"思考が長くなりすぎて回答を生成できませんでした。質問を短く区切って再度お試しください。",
			});
		});

		it.each(["SAFETY", "RECITATION", "PROHIBITED_CONTENT"])(
			"explains a %s finish reason as a safety block",
			async (finishReason) => {
				mockStream([{ type: "finish", finishReason }]);

				await expect(
					streamGeminiWithDiscordEditsStep(
						mockEnv,
						"token",
						"question",
						"message",
						sheetData,
						history,
						mockLogger,
					),
				).rejects.toMatchObject({
					userMessage: "安全性フィルタにより回答できませんでした。",
				});
			},
		);

		it("explains a prompt-level block reason as a safety block", async () => {
			mockStream([{ type: "finish", blockReason: "SAFETY" }]);

			await expect(
				streamGeminiWithDiscordEditsStep(
					mockEnv,
					"token",
					"question",
					"message",
					sheetData,
					history,
					mockLogger,
				),
			).rejects.toMatchObject({
				userMessage: "安全性フィルタにより回答できませんでした。",
			});
		});

		it("keeps the generic message when no finish reason explains the empty answer", async () => {
			mockStream([
				{ type: "thinking", delta: "thought only" },
				{ type: "finish", finishReason: "STOP" },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(undefined);

			await expect(
				streamGeminiWithDiscordEditsStep(
					mockEnv,
					"token",
					"question",
					"message",
					sheetData,
					history,
					mockLogger,
				),
			).rejects.toMatchObject({
				userMessage: "AIから有効な応答が得られませんでした。",
			});
		});

		it("displays summarized thinking content with thought balloon", async () => {
			mockThinkingSummarizer.summarize.mockResolvedValue({
				text: "問題を多角的に分析中",
				usage: null,
				success: true,
			});
			mockStream([
				{ type: "thinking", delta: "private thought" },
				{
					type: "response",
					delta: "final answer",
					accumulated: "final answer",
				},
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
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
			expect(mockThinkingSummarizer.summarize).toHaveBeenCalledWith(
				"",
				"private thought",
			);
			expect(result.response).toBe("final answer");
			expect(result.updatedHistory).not.toContainEqual(
				expect.objectContaining({ text: expect.stringContaining("private") }),
			);
		});

		it("summarizes only new thinking and aggregates summary usage", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const secondThought = "x".repeat(200);
			mockThinkingSummarizer.summarize
				.mockResolvedValueOnce({
					text: "最初の要約",
					usage: {
						promptTokens: 10,
						cachedTokens: 1,
						thoughtsTokens: 0,
						candidatesTokens: 2,
						totalTokens: 12,
					},
					success: true,
				})
				.mockResolvedValueOnce({
					text: "更新後の要約",
					usage: {
						promptTokens: 20,
						cachedTokens: 2,
						thoughtsTokens: 0,
						candidatesTokens: 3,
						totalTokens: 23,
					},
					success: true,
				});
			mockGeminiGateway.generateStream.mockImplementation(async function* () {
				yield { type: "thinking", delta: "first thought" };
				vi.setSystemTime(2000);
				yield { type: "thinking", delta: secondThought };
				yield {
					type: "response",
					delta: "answer",
					accumulated: "answer",
				};
			});
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"message",
				sheetData,
				history,
				mockLogger,
			);

			expect(mockThinkingSummarizer.summarize).toHaveBeenNthCalledWith(
				1,
				"",
				"first thought",
			);
			expect(mockThinkingSummarizer.summarize).toHaveBeenNthCalledWith(
				2,
				"最初の要約",
				secondThought,
			);
			expect(result).toMatchObject({
				thinkingSummaryCallCount: 2,
				thinkingSummarySuccessCount: 2,
				thinkingSummaryUsage: {
					promptTokens: 30,
					cachedTokens: 3,
					thoughtsTokens: 0,
					candidatesTokens: 5,
					totalTokens: 35,
				},
			});
		});

		it("forces Discord edit on phase transition from thinking to response", async () => {
			mockStream([
				{ type: "thinking", delta: "thought" },
				{
					type: "response",
					delta: "response start",
					accumulated: "response start",
				},
			]);
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
			mockStream([
				{
					type: "response",
					delta: "response text",
					accumulated: "response text",
				},
			]);
			// Intermediate edits may fail, but final edit succeeds
			mockDiscordInstance.editOriginalMessage
				.mockRejectedValueOnce(
					new ExternalServiceError({
						service: "discord",
						operation: "edit original message",
						status: 400,
						retryable: false,
						userMessage: "Discordへの応答送信に失敗しました。",
					}),
				)
				.mockResolvedValueOnce(undefined);

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
			expect(mockDiscordInstance.editOriginalMessage).toHaveBeenCalledTimes(2);
		});

		it("passes structured history and configured models to the AI services", async () => {
			const existingHistory: HistoryEntry[] = [
				{ role: "user", text: "previous" },
			];
			const historyWithExisting: HistoryOutput = {
				history: existingHistory,
			};
			mockStream([
				{ type: "response", delta: "response", accumulated: "response" },
			]);
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

			expect(createGeminiGateway).toHaveBeenCalledWith(
				mockEnv.GEMINI_API_KEY,
				mockLogger,
			);
			expect(createThinkingSummarizer).toHaveBeenCalledWith(
				mockGeminiGateway,
				"gemini-2.5-flash-lite",
				mockLogger,
			);
			expect(mockGeminiGateway.generateStream).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "gemini-3.5-flash-lite",
					prompt: expect.objectContaining({
						contents: [
							{ role: "user", parts: [{ text: "previous" }] },
							{ role: "user", parts: [{ text: "質問: message" }] },
						],
					}),
				}),
			);
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
			mockDeduplicationStore.isMarked.mockResolvedValue(true);

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.isDuplicate).not.toHaveBeenCalled();
			expect(mockGitHubInstance.createIssue).not.toHaveBeenCalled();
		});

		it("skips when GitHub search finds duplicate", async () => {
			mockGitHubInstance.generateFingerprint.mockReturnValue("fingerprint-2");
			mockGitHubInstance.isDuplicate.mockResolvedValue(true);

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.createIssue).not.toHaveBeenCalled();
			// Should cache in KV to avoid future searches
			expect(mockDeduplicationStore.mark).toHaveBeenCalledWith(
				"error_reported:fingerprint-2",
				3600,
			);
		});

		it("creates issue and caches in KV on new error", async () => {
			mockGitHubInstance.generateFingerprint.mockReturnValue("fingerprint-3");
			mockGitHubInstance.isDuplicate.mockResolvedValue(false);
			mockGitHubInstance.createIssue.mockResolvedValue(true);

			await reportErrorToGitHub(mockEnv, sampleReport, mockLogger);

			expect(mockGitHubInstance.createIssue).toHaveBeenCalledWith(
				sampleReport,
				"fingerprint-3",
			);
			expect(mockDeduplicationStore.mark).toHaveBeenCalledWith(
				"error_reported:fingerprint-3",
				3600,
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
		const discordError = (
			status: number,
			options: { retryable: boolean; retryAfterMs?: number },
		) =>
			new ExternalServiceError({
				service: "discord",
				operation: "post message",
				status,
				retryable: options.retryable,
				userMessage: "Discordへのメッセージ送信に失敗しました。",
				retryAfterMs: options.retryAfterMs,
			});

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
			expect(result).toEqual({
				success: true,
				statusCode: 200,
				retryCount: 0,
				editCount: 0,
				chunkCount: 1,
				deliveryStatus: "success",
				failedChunks: [],
			});
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
			expect(result).toEqual({
				success: true,
				statusCode: 200,
				retryCount: 0,
				editCount: 0,
				chunkCount: 1,
				deliveryStatus: "success",
				failedChunks: [],
			});
		});

		it("retries on failure", async () => {
			vi.useFakeTimers();
			mockDiscordInstance.postMessage
				.mockRejectedValueOnce(discordError(500, { retryable: true }))
				.mockResolvedValueOnce(undefined);

			const promise = sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledTimes(2);
			expect(result).toEqual({
				success: true,
				statusCode: 200,
				retryCount: 1,
				editCount: 0,
				chunkCount: 1,
				deliveryStatus: "success",
				failedChunks: [],
			});
		});

		it("returns failure after all retries exhausted", async () => {
			vi.useFakeTimers();
			mockDiscordInstance.postMessage.mockRejectedValue(
				discordError(500, { retryable: true }),
			);

			const promise = sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(mockDiscordInstance.postMessage).toHaveBeenCalledTimes(3); // Initial + 2 retries
			expect(result).toEqual({
				success: false,
				statusCode: 500,
				retryCount: 2,
				editCount: 0,
				chunkCount: 0,
				deliveryStatus: "failed",
				failedChunks: [0],
			});
		});

		it.each([400, 401, 403, 404])(
			"does not retry permanent status %s",
			async (status) => {
				mockDiscordInstance.postMessage.mockRejectedValue(
					discordError(status, { retryable: false }),
				);

				const result = await sendDiscordResponseStep(
					mockEnv,
					"token",
					"question",
					"answer",
					mockLogger,
				);

				expect(mockDiscordInstance.postMessage).toHaveBeenCalledTimes(1);
				expect(result).toEqual({
					success: false,
					statusCode: status,
					retryCount: 0,
					editCount: 0,
					chunkCount: 0,
					deliveryStatus: "failed",
					failedChunks: [0],
				});
			},
		);

		it("uses Retry-After for status 429", async () => {
			vi.useFakeTimers();
			mockDiscordInstance.postMessage
				.mockRejectedValueOnce(
					discordError(429, { retryable: true, retryAfterMs: 2500 }),
				)
				.mockResolvedValueOnce(undefined);

			const promise = sendDiscordResponseStep(
				mockEnv,
				"token",
				"question",
				"answer",
				mockLogger,
			);
			await vi.runAllTimersAsync();

			await expect(promise).resolves.toEqual({
				success: true,
				statusCode: 200,
				retryCount: 1,
				editCount: 0,
				chunkCount: 1,
				deliveryStatus: "success",
				failedChunks: [],
			});
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"Retrying external service request",
				expect.objectContaining({ delayMs: 2500, status: 429 }),
			);
		});
	});
});
