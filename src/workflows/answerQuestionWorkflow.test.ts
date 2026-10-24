import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import type { Bindings, HistoryEntry, WorkflowParams } from "../contracts";
import { formatAnswer } from "../discord/formatter";
import type { LlmRequest, LlmStreamEvent } from "../llm/types";
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

const mockLlmGateway = {
	provider: "gemini",
	capabilities: { reasoningSummary: true },
	generateStream: vi.fn(),
	generateText: vi.fn(),
};

const mockThinkingSummarizer = {
	summarize: vi.fn(),
};

vi.mock("../repositories/sheetCache", () => ({
	createSheetCacheRepository: vi.fn(() => mockSheetCacheRepository),
}));

vi.mock("../repositories/conversationHistory", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../repositories/conversationHistory")
	>()),
	createConversationHistoryRepository: vi.fn(() => mockHistoryRepository),
}));

vi.mock("../repositories/deduplicationStore", () => ({
	createDeduplicationStore: vi.fn(() => mockDeduplicationStore),
}));

vi.mock("../llm/factory", () => ({
	createLlmGateway: vi.fn(() => mockLlmGateway),
}));

vi.mock("../llm/thinkingSummarizer", async (importOriginal) => ({
	...(await importOriginal<typeof import("../llm/thinkingSummarizer")>()),
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
import { createLlmGateway } from "../llm/factory";
import { createThinkingSummarizer } from "../llm/thinkingSummarizer";
import { createConversationHistoryRepository } from "../repositories/conversationHistory";
import {
	AnswerQuestionWorkflow,
	getHistoryStep,
	getSheetDataStep,
	normalizeStreamingOutput,
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
		mockLlmGateway.provider = "gemini";
		mockLlmGateway.capabilities.reasoningSummary = true;
		vi.mocked(createLlmGateway).mockImplementation(() => mockLlmGateway);
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
				{ role: "assistant", text: "old answer" },
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
				{ role: "assistant", text: "answer" },
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

		const mockStream = (events: LlmStreamEvent[]) => {
			mockLlmGateway.generateStream.mockImplementation(async function* () {
				for (const event of events) {
					yield event;
				}
			});
		};

		it("captures answer retries and first-text/completion latency", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(1_000);
			mockLlmGateway.generateStream.mockImplementation(async function* (
				request: LlmRequest,
			) {
				request.telemetry?.onAttempt();
				request.telemetry?.onAttempt();
				vi.setSystemTime(1_200);
				request.telemetry?.onFirstText?.();
				yield { type: "text", delta: "answer" };
				vi.setSystemTime(1_500);
				yield { type: "finish", finish: { reason: "stop" } };
			});
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"question",
				sheetData,
				history,
				mockLogger,
			);

			expect(result).toMatchObject({
				answerRetryCount: 1,
				answerFirstTextDurationMs: 200,
				answerDurationMs: 500,
			});
		});

		it.each(["disabled", "unsupported"])(
			"uses generic progress without summary calls when %s",
			async (mode) => {
				const env = {
					...mockEnv,
					LLM_SUMMARY_ENABLED: mode === "disabled" ? "false" : "true",
				};
				mockLlmGateway.capabilities.reasoningSummary = mode !== "unsupported";
				mockStream([
					{ type: "reasoning_summary", delta: "private summary" },
					{ type: "text", delta: "answer" },
					{ type: "finish", finish: { reason: "stop" } },
				]);
				mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
				const result = await streamGeminiWithDiscordEditsStep(
					env,
					"token",
					"question",
					"question",
					sheetData,
					history,
					mockLogger,
				);
				expect(createThinkingSummarizer).not.toHaveBeenCalled();
				expect(mockThinkingSummarizer.summarize).not.toHaveBeenCalled();
				expect(mockLlmGateway.generateStream).toHaveBeenCalledWith(
					expect.objectContaining({ includeReasoningSummary: false }),
				);
				expect(
					mockDiscordInstance.editOriginalMessage.mock.calls[0][0],
				).toContain("考え中");
				expect(result.thinkingSummaryCallCount).toBe(0);
				expect(result.thinkingSummaryUsage).toBeNull();
				expect(JSON.stringify(result.updatedHistory)).not.toContain(
					"private summary",
				);
			},
		);
		it("completes with OpenAI and summaries disabled without Gemini credentials", async () => {
			const env = {
				...mockEnv,
				GEMINI_API_KEY: undefined,
				OPENAI_API_KEY: "openai-key",
				LLM_PROVIDER: "openai",
				LLM_MODEL: "openai-answer",
				LLM_SUMMARY_ENABLED: "false",
			};
			const config = loadConfig(env);
			mockLlmGateway.provider = "openai";
			mockStream([
				{ type: "text", delta: "answer" },
				{ type: "finish", finish: { reason: "stop" } },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
			const oldHistory = {
				history: [{ role: "model", text: "old answer" }],
			} as unknown as HistoryOutput;
			const result = await streamGeminiWithDiscordEditsStep(
				env,
				"token",
				"question",
				"question",
				sheetData,
				oldHistory,
				mockLogger,
				config,
			);
			expect(createLlmGateway).toHaveBeenCalledExactlyOnceWith(
				config.llm.answer,
				mockLogger,
			);
			expect(mockLlmGateway.generateStream).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "openai-answer",
					includeReasoningSummary: false,
					prompt: expect.objectContaining({
						messages: expect.arrayContaining([
							{ role: "assistant", text: "old answer" },
						]),
					}),
				}),
			);
			expect(result.updatedHistory[0]).toEqual({
				role: "assistant",
				text: "old answer",
			});
			expect(createThinkingSummarizer).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain("openai-key");
		});
		it("uses a separate provider only for enabled summaries", async () => {
			const env = {
				...mockEnv,
				OPENAI_API_KEY: "summary-key",
				LLM_SUMMARY_PROVIDER: "openai",
				LLM_SUMMARY_MODEL: "openai-summary",
			};
			const config = loadConfig(env);
			const summaryGateway = { ...mockLlmGateway, provider: "openai" };
			vi.mocked(createLlmGateway).mockImplementation((selection) =>
				selection.provider === "openai" ? summaryGateway : mockLlmGateway,
			);
			mockStream([
				{ type: "reasoning_summary", delta: "summary source" },
				{ type: "text", delta: "answer" },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
			await streamGeminiWithDiscordEditsStep(
				env,
				"token",
				"question",
				"question",
				sheetData,
				history,
				mockLogger,
				config,
			);
			expect(createLlmGateway).toHaveBeenCalledTimes(2);
			expect(createThinkingSummarizer).toHaveBeenCalledWith(
				summaryGateway,
				"openai-summary",
				mockLogger,
			);
			expect(mockThinkingSummarizer.summarize).toHaveBeenCalled();
		});
		it("reuses the answer gateway for the same summary provider", async () => {
			mockStream([{ type: "text", delta: "answer" }]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
			await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"question",
				sheetData,
				history,
				mockLogger,
			);
			expect(createLlmGateway).toHaveBeenCalledTimes(1);
			expect(createThinkingSummarizer).toHaveBeenCalledWith(
				mockLlmGateway,
				"gemini-2.5-flash-lite",
				mockLogger,
			);
		});
		it("marks truncated final answers without putting the notice in conversation history", async () => {
			mockStream([
				{ type: "text", delta: "partial answer" },
				{ type: "finish", finish: { reason: "length" } },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"question",
				sheetData,
				history,
				mockLogger,
			);
			expect(
				mockDiscordInstance.editOriginalMessage.mock.calls.at(-1)?.[0],
			).toContain("出力上限");
			expect(result.updatedHistory.at(-1)?.text).toBe("partial answer");
		});
		it.each(["blocked", "error"] as const)(
			"rejects a nonempty %s completion",
			async (reason) => {
				mockStream([
					{ type: "text", delta: "partial" },
					{ type: "finish", finish: { reason } },
				]);
				mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
				await expect(
					streamGeminiWithDiscordEditsStep(
						mockEnv,
						"token",
						"question",
						"question",
						sheetData,
						history,
						mockLogger,
					),
				).rejects.toBeInstanceOf(ExternalServiceError);
				expect(mockHistoryRepository.save).not.toHaveBeenCalled();
			},
		);
		it("streams typed events, edits Discord, and returns history and usage", async () => {
			const updatedHistory: HistoryEntry[] = [
				{ role: "user", text: "質問: test message" },
				{ role: "assistant", text: "full response" },
			];
			mockStream([
				{ type: "text", delta: "full" },
				{
					type: "text",
					delta: " response",
				},
				{
					type: "usage",
					usage: {
						inputTokens: 100,
						cachedInputTokens: 25,
						reasoningTokens: 10,
						outputTokens: 20,
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
				inputTokens: 100,
				cachedInputTokens: 25,
				reasoningTokens: 10,
				outputTokens: 20,
				totalTokens: 130,
			});
			const lastCall =
				mockDiscordInstance.editOriginalMessage.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe("> user question\nfull response");
		});

		it("normalizes HTML line breaks in previews, final output, and history", async () => {
			const rawResponse = "概要<br>2015年加入<BR />2016年移籍";
			const normalizedResponse = "概要\n2015年加入\n2016年移籍";
			mockStream([
				{
					type: "text",
					delta: rawResponse,
				},
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);

			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"test-token",
				"経歴",
				"経歴を教えて",
				sheetData,
				history,
				mockLogger,
			);

			expect(result.response).toBe(normalizedResponse);
			expect(result.updatedHistory.at(-1)).toEqual({
				role: "assistant",
				text: normalizedResponse,
			});
			expect(mockDiscordInstance.editOriginalMessage).toHaveBeenCalledWith(
				`> 経歴\n${normalizedResponse}`,
			);
		});

		it("delivers a long final answer in ordered chunks without loss", async () => {
			const response = "a".repeat(4500);
			mockStream([{ type: "text", delta: response }]);
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
			mockStream([{ type: "reasoning_summary", delta: "thought only" }]);
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
				service: "llm",
				provider: "gemini",
				operation: "validate streamed response",
				retryable: false,
			});

			expect(mockDiscordInstance.postMessage).not.toHaveBeenCalled();
		});

		it("logs the finish reason and token budget when the answer is empty", async () => {
			mockStream([
				{ type: "reasoning_summary", delta: "thought only" },
				{
					type: "usage",
					usage: {
						inputTokens: 100,
						cachedInputTokens: 0,
						reasoningTokens: 8192,
						outputTokens: 0,
						totalTokens: 8292,
					},
				},
				{
					type: "finish",
					finish: { reason: "length", providerFinishReason: "MAX_TOKENS" },
				},
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
				"LLM returned an empty answer",
				{
					provider: "gemini",
					finish: { reason: "length", providerFinishReason: "MAX_TOKENS" },
					thinkingLength: "thought only".length,
					reasoningTokens: 8192,
				},
			);
		});

		it("explains a token-budget exhaustion to the user", async () => {
			mockStream([
				{ type: "reasoning_summary", delta: "thought only" },
				{
					type: "finish",
					finish: { reason: "length", providerFinishReason: "MAX_TOKENS" },
				},
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
				service: "llm",
				provider: "gemini",
				operation: "validate streamed response",
				retryable: false,
				userMessage:
					"思考が長くなりすぎて回答を生成できませんでした。質問を短く区切って再度お試しください。",
			});
		});

		it.each(["SAFETY", "RECITATION", "PROHIBITED_CONTENT"])(
			"explains a %s finish reason as a safety block",
			async (finishReason) => {
				mockStream([
					{
						type: "finish",
						finish: { reason: "blocked", providerFinishReason: finishReason },
					},
				]);

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
			mockStream([
				{
					type: "finish",
					finish: { reason: "blocked", providerBlockReason: "SAFETY" },
				},
			]);

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
				{ type: "reasoning_summary", delta: "thought only" },
				{
					type: "finish",
					finish: { reason: "stop", providerFinishReason: "STOP" },
				},
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
				{ type: "reasoning_summary", delta: "private thought" },
				{
					type: "text",
					delta: "final answer",
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

		it("delivers and saves only the final answer when summary generation falls back", async () => {
			mockThinkingSummarizer.summarize.mockResolvedValueOnce({
				text: "考え中...",
				usage: null,
				success: false,
			});
			mockStream([
				{ type: "reasoning_summary", delta: "summary source" },
				{ type: "text", delta: "final answer" },
				{ type: "finish", finish: { reason: "stop" } },
			]);
			mockDiscordInstance.editOriginalMessage.mockResolvedValue(true);
			const result = await streamGeminiWithDiscordEditsStep(
				mockEnv,
				"token",
				"question",
				"question",
				sheetData,
				history,
				mockLogger,
			);
			expect(result.thinkingSummaryCallCount).toBe(1);
			expect(result.thinkingSummarySuccessCount).toBe(0);
			expect(result.thinkingSummaryUsage?.inputTokens).toBeNull();
			expect(result.updatedHistory).toEqual([
				{ role: "user", text: "質問: question" },
				{ role: "assistant", text: "final answer" },
			]);
			expect(
				mockDiscordInstance.editOriginalMessage.mock.calls.at(-1)?.[0],
			).toContain("final answer");
		});
		it("summarizes only new thinking and aggregates summary usage", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const secondThought = "x".repeat(200);
			mockThinkingSummarizer.summarize
				.mockResolvedValueOnce({
					text: "最初の要約",
					usage: {
						inputTokens: 10,
						cachedInputTokens: 1,
						reasoningTokens: 0,
						outputTokens: 2,
						totalTokens: 12,
					},
					success: true,
					retryCount: 1,
				})
				.mockResolvedValueOnce({
					text: "更新後の要約",
					usage: {
						inputTokens: 20,
						cachedInputTokens: 2,
						reasoningTokens: 0,
						outputTokens: 3,
						totalTokens: 23,
					},
					success: true,
					retryCount: 2,
				});
			mockLlmGateway.generateStream.mockImplementation(async function* () {
				yield { type: "reasoning_summary", delta: "first thought" };
				vi.setSystemTime(2000);
				yield { type: "reasoning_summary", delta: secondThought };
				yield {
					type: "text",
					delta: "answer",
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
				thinkingSummaryRetryCount: 3,
				thinkingSummaryUsage: {
					inputTokens: 30,
					cachedInputTokens: 3,
					reasoningTokens: 0,
					outputTokens: 5,
					totalTokens: 35,
				},
			});
		});

		it("forces Discord edit on phase transition from thinking to response", async () => {
			mockStream([
				{ type: "reasoning_summary", delta: "thought" },
				{
					type: "text",
					delta: "response start",
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
					type: "text",
					delta: "response text",
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
			mockStream([{ type: "text", delta: "response" }]);
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

			expect(createLlmGateway).toHaveBeenCalledWith(
				{
					provider: "gemini",
					model: "gemini-3.5-flash-lite",
					apiKey: mockEnv.GEMINI_API_KEY,
				},
				mockLogger,
			);
			expect(createThinkingSummarizer).toHaveBeenCalledWith(
				mockLlmGateway,
				"gemini-2.5-flash-lite",
				mockLogger,
			);
			expect(mockLlmGateway.generateStream).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "gemini-3.5-flash-lite",
					prompt: expect.objectContaining({
						messages: [
							{ role: "user", text: "previous" },
							{ role: "user", text: "質問: message" },
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

describe("completed Workflow checkpoint compatibility", () => {
	it("replays completed generation without invoking or delivering twice and preserves step options", async () => {
		vi.clearAllMocks();
		mockHistoryRepository.save.mockResolvedValue(undefined);
		const checkpoint = {
			response: "answer",
			updatedHistory: [
				{ role: "user", text: "question" },
				{ role: "model", text: "answer" },
			],
			usage: {
				promptTokens: 10,
				cachedTokens: 0,
				candidatesTokens: 3,
				thoughtsTokens: 2,
				totalTokens: 15,
			},
			thinkingSummaryUsage: null,
			thinkingSummaryCallCount: 0,
			thinkingSummarySuccessCount: 0,
			thinkingSummaryDurationMs: 0,
			editCount: 1,
			chunkCount: 1,
			deliveryStatus: "success",
			failedChunks: [],
			retryCount: 0,
			deliveryDurationMs: 1,
		};
		const execute = vi.fn(async (name: string, ...args: unknown[]) => {
			if (name === "getSheetData")
				return {
					sheetInfo: "knowledge",
					description: "description",
					fromCache: true,
				};
			if (name === "getHistory")
				return { history: [{ role: "model", text: "old answer" }] };
			if (name === "streamGeminiAndEditDiscord")
				return JSON.parse(JSON.stringify(checkpoint));
			const callback = args.at(-1) as () => Promise<unknown>;
			return callback();
		});
		const event = {
			instanceId: "workflow-id",
			payload: {
				token: "token",
				message: "question",
				requestId: "request-id",
				conversationKey: "conversation",
			},
		} as WorkflowEvent<WorkflowParams>;
		await AnswerQuestionWorkflow.prototype.run.call(
			{ env: mockEnv } as unknown as AnswerQuestionWorkflow,
			event,
			{ do: execute } as unknown as WorkflowStep,
		);
		expect(execute.mock.calls.map((call) => call[0])).toEqual([
			"getSheetData",
			"getHistory",
			"streamGeminiAndEditDiscord",
			"saveHistory",
		]);
		expect(execute).toHaveBeenCalledWith(
			"streamGeminiAndEditDiscord",
			{
				retries: { limit: 0, delay: "1 second", backoff: "exponential" },
				timeout: "120 seconds",
			},
			expect.any(Function),
		);
		expect(createLlmGateway).not.toHaveBeenCalled();
		expect(mockDiscordInstance.editOriginalMessage).not.toHaveBeenCalled();
		expect(mockHistoryRepository.save).toHaveBeenCalledWith("conversation", [
			{ role: "user", text: "question" },
			{ role: "assistant", text: "answer" },
		]);
		expect(mockAnalyticsDataset.writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: [
					"gemini_api_call",
					"request-id",
					"gemini-3.5-flash-lite",
					"answer",
				],
				doubles: [expect.any(Number), 1, 0, 10, 0, 2, 3, 15, 1],
			}),
		);
	});

	it("converts old persisted history and usage while keeping delivery results", () => {
		const old = {
			response: "answer",
			updatedHistory: [{ role: "model", text: "answer" }],
			usage: {
				promptTokens: 10,
				candidatesTokens: 5,
				cachedTokens: 0,
				thoughtsTokens: 2,
				totalTokens: 17,
			},
			thinkingSummaryUsage: null,
			thinkingSummaryCallCount: 0,
			thinkingSummarySuccessCount: 0,
			thinkingSummaryDurationMs: 0,
			editCount: 1,
			chunkCount: 1,
			deliveryStatus: "success",
			failedChunks: [],
			retryCount: 0,
			deliveryDurationMs: 3,
		};
		const result = normalizeStreamingOutput(
			old as unknown as import("./types").StreamingLlmOutput,
		);
		expect(result.updatedHistory).toEqual([
			{ role: "assistant", text: "answer" },
		]);
		expect(result.usage?.inputTokens).toBe(10);
		expect(result.usage?.outputTokens).toBe(5);
		expect(result.deliveryStatus).toBe("success");
		expect(result.editCount).toBe(1);
	});
});
