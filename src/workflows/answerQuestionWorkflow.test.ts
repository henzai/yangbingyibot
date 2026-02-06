import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowParams, SheetDataOutput, HistoryOutput, GeminiOutput } from './types';
import { Bindings } from '../types';
import { Logger } from '../utils/logger';

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
	getHistory: vi.fn(),
};

vi.mock('../clients/kv', () => ({
	createKV: vi.fn(() => mockKVInstance),
}));

vi.mock('../clients/gemini', () => ({
	createGeminiClient: vi.fn(() => mockGeminiInstance),
}));

vi.mock('../clients/spreadSheet', () => ({
	getSheetData: vi.fn(),
}));

// Import after mocks
import { createKV } from '../clients/kv';
import { createGeminiClient } from '../clients/gemini';
import { getSheetData } from '../clients/spreadSheet';
import {
	getSheetDataStep,
	getHistoryStep,
	callGeminiStep,
	saveHistoryStep,
	sendDiscordResponseStep,
} from './answerQuestionWorkflow';

// Mock Analytics Engine Dataset
const mockAnalyticsDataset = {
	writeDataPoint: vi.fn(),
};

const mockEnv: Bindings = {
	DISCORD_TOKEN: 'test-token',
	DISCORD_PUBLIC_KEY: 'test-public-key',
	DISCORD_APPLICATION_ID: 'test-app-id',
	DISCORD_TEST_GUILD_ID: 'test-guild-id',
	GEMINI_API_KEY: 'test-gemini-key',
	GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@example.com',
	GOOGLE_PRIVATE_KEY: 'test-key',
	GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
	sushanshan_bot: {} as KVNamespace,
	ANSWER_QUESTION_WORKFLOW: {} as Workflow<any>,
	METRICS: mockAnalyticsDataset as unknown as AnalyticsEngineDataset,
};

describe('AnswerQuestionWorkflow Steps', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset fetch mock
		globalThis.fetch = vi.fn();
	});

	describe('getSheetDataStep', () => {
		it('returns cached data when cache is available', async () => {
			mockKVInstance.getCache.mockResolvedValue({
				sheetInfo: 'cached sheet',
				description: 'cached desc',
			});

			const result = await getSheetDataStep(mockEnv, mockLogger);

			expect(result).toEqual({
				sheetInfo: 'cached sheet',
				description: 'cached desc',
				fromCache: true,
			});
			expect(getSheetData).not.toHaveBeenCalled();
		});

		it('fetches from Google Sheets when cache is empty', async () => {
			mockKVInstance.getCache.mockResolvedValue(null);
			vi.mocked(getSheetData).mockResolvedValue({
				sheetInfo: 'fresh sheet',
				description: 'fresh desc',
			});

			const result = await getSheetDataStep(mockEnv, mockLogger);

			expect(result).toEqual({
				sheetInfo: 'fresh sheet',
				description: 'fresh desc',
				fromCache: false,
			});
			expect(getSheetData).toHaveBeenCalledWith(mockEnv.GOOGLE_SERVICE_ACCOUNT, mockLogger);
		});

		it('saves cache after fetching fresh data', async () => {
			mockKVInstance.getCache.mockResolvedValue(null);
			vi.mocked(getSheetData).mockResolvedValue({
				sheetInfo: 'fresh sheet',
				description: 'fresh desc',
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockKVInstance.saveCache).toHaveBeenCalledWith('fresh sheet', 'fresh desc');
		});

		it('does not save cache when using cached data', async () => {
			mockKVInstance.getCache.mockResolvedValue({
				sheetInfo: 'cached sheet',
				description: 'cached desc',
			});

			await getSheetDataStep(mockEnv, mockLogger);

			expect(mockKVInstance.saveCache).not.toHaveBeenCalled();
		});
	});

	describe('getHistoryStep', () => {
		it('returns history from KV', async () => {
			const existingHistory = [
				{ role: 'user', text: 'old question' },
				{ role: 'model', text: 'old answer' },
			];
			mockKVInstance.getHistory.mockResolvedValue(existingHistory);

			const result = await getHistoryStep(mockEnv, mockLogger);

			expect(result).toEqual({ history: existingHistory });
		});

		it('returns empty array when no history exists', async () => {
			mockKVInstance.getHistory.mockResolvedValue([]);

			const result = await getHistoryStep(mockEnv, mockLogger);

			expect(result).toEqual({ history: [] });
		});
	});

	describe('callGeminiStep', () => {
		it('calls Gemini with correct parameters', async () => {
			const sheetData: SheetDataOutput = {
				sheetInfo: 'sheet data',
				description: 'sheet description',
				fromCache: true,
			};
			const history: HistoryOutput = { history: [] };
			mockGeminiInstance.ask.mockResolvedValue('AI response');
			mockGeminiInstance.getHistory.mockReturnValue([
				{ role: 'user', text: '質問: test message' },
				{ role: 'model', text: 'AI response' },
			]);

			const result = await callGeminiStep(mockEnv, 'test message', sheetData, history, mockLogger);

			expect(createGeminiClient).toHaveBeenCalledWith(mockEnv.GEMINI_API_KEY, [], mockLogger);
			expect(mockGeminiInstance.ask).toHaveBeenCalledWith('test message', 'sheet data', 'sheet description');
			expect(result.response).toBe('AI response');
			expect(result.updatedHistory).toHaveLength(2);
		});

		it('passes existing history to GeminiClient', async () => {
			const existingHistory = [{ role: 'user', text: 'previous question' }];
			const sheetData: SheetDataOutput = {
				sheetInfo: 'sheet',
				description: 'desc',
				fromCache: true,
			};
			const history: HistoryOutput = { history: existingHistory };
			mockGeminiInstance.ask.mockResolvedValue('response');
			mockGeminiInstance.getHistory.mockReturnValue([]);

			await callGeminiStep(mockEnv, 'new message', sheetData, history, mockLogger);

			expect(createGeminiClient).toHaveBeenCalledWith(mockEnv.GEMINI_API_KEY, existingHistory, mockLogger);
		});
	});

	describe('saveHistoryStep', () => {
		it('saves history to KV', async () => {
			const updatedHistory = [
				{ role: 'user', text: 'question' },
				{ role: 'model', text: 'answer' },
			];

			const result = await saveHistoryStep(mockEnv, updatedHistory, mockLogger);

			expect(mockKVInstance.saveHistory).toHaveBeenCalledWith(updatedHistory);
			expect(result).toEqual({ success: true });
		});

		it('returns success false on error', async () => {
			mockKVInstance.saveHistory.mockRejectedValue(new Error('KV error'));

			const result = await saveHistoryStep(mockEnv, [], mockLogger);

			expect(result).toEqual({ success: false });
		});
	});

	describe('sendDiscordResponseStep', () => {
		it('sends successful response to Discord webhook', async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(mockEnv, 'test-token-123', 'user question', 'AI answer', mockLogger);

			expect(mockFetch).toHaveBeenCalledWith(
				`https://discord.com/api/v10/webhooks/${mockEnv.DISCORD_APPLICATION_ID}/test-token-123`,
				{
					method: 'POST',
					body: JSON.stringify({ content: '> user question\nAI answer' }),
					headers: { 'Content-Type': 'application/json' },
				}
			);
			expect(result).toEqual({ success: true, statusCode: 200 });
		});

		it('sends error response when AI fails', async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(mockEnv, 'token', 'question', null, mockLogger, 'Some error occurred');

			expect(mockFetch).toHaveBeenCalledWith(expect.any(String), {
				method: 'POST',
				body: JSON.stringify({ content: '> question\n:rotating_light: エラーが発生しました: Some error occurred' }),
				headers: { 'Content-Type': 'application/json' },
			});
			expect(result).toEqual({ success: true, statusCode: 200 });
		});

		it('retries on failure', async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValueOnce({ ok: false, status: 500, text: () => 'Server error' })
				.mockResolvedValueOnce({ ok: true, status: 200 });
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(mockEnv, 'token', 'question', 'answer', mockLogger);

			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(result).toEqual({ success: true, statusCode: 200 });
		});

		it('returns failure after all retries exhausted', async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve('Server error'),
			});
			globalThis.fetch = mockFetch;

			const result = await sendDiscordResponseStep(mockEnv, 'token', 'question', 'answer', mockLogger);

			expect(mockFetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
			expect(result).toEqual({ success: false, statusCode: 500 });
		});
	});
});
