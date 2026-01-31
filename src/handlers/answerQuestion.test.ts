import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bindings } from '../types';

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
	getSheetInfo: vi.fn(),
	getSheetDescription: vi.fn(),
}));

import { answerQuestion } from './answerQuestion';
import { createKV } from '../clients/kv';
import { createGeminiClient } from '../clients/gemini';
import { getSheetInfo, getSheetDescription } from '../clients/spreadSheet';

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
};

describe('answerQuestion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockKVInstance.getHistory.mockResolvedValue([]);
		mockGeminiInstance.ask.mockResolvedValue('AI response');
		mockGeminiInstance.getHistory.mockReturnValue([]);
	});

	it('uses cached data when available', async () => {
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'cached sheet',
			description: 'cached desc',
		});

		await answerQuestion('test question', mockEnv);

		expect(getSheetInfo).not.toHaveBeenCalled();
		expect(getSheetDescription).not.toHaveBeenCalled();
	});

	it('fetches sheet data when cache is empty', async () => {
		mockKVInstance.getCache.mockResolvedValue(null);
		vi.mocked(getSheetInfo).mockResolvedValue('new sheet');
		vi.mocked(getSheetDescription).mockResolvedValue('new desc');

		await answerQuestion('test question', mockEnv);

		expect(getSheetInfo).toHaveBeenCalledWith(mockEnv.GOOGLE_SERVICE_ACCOUNT);
		expect(getSheetDescription).toHaveBeenCalledWith(mockEnv.GOOGLE_SERVICE_ACCOUNT);
	});

	it('saves cache when fetching fresh data', async () => {
		mockKVInstance.getCache.mockResolvedValue(null);
		vi.mocked(getSheetInfo).mockResolvedValue('fresh sheet');
		vi.mocked(getSheetDescription).mockResolvedValue('fresh desc');

		await answerQuestion('test question', mockEnv);

		expect(mockKVInstance.saveCache).toHaveBeenCalledWith('fresh sheet', 'fresh desc');
	});

	it('does not save cache when using cached data', async () => {
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'cached sheet',
			description: 'cached desc',
		});

		await answerQuestion('test question', mockEnv);

		expect(mockKVInstance.saveCache).not.toHaveBeenCalled();
	});

	it('saves updated history after getting response', async () => {
		const updatedHistory = [
			{ role: 'user', text: '質問: test' },
			{ role: 'model', text: 'AI response' },
		];
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'sheet',
			description: 'desc',
		});
		mockGeminiInstance.getHistory.mockReturnValue(updatedHistory);

		await answerQuestion('test question', mockEnv);

		expect(mockKVInstance.saveHistory).toHaveBeenCalledWith(updatedHistory);
	});

	it('passes existing history to GeminiClient', async () => {
		const existingHistory = [{ role: 'user', text: 'old question' }];
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'sheet',
			description: 'desc',
		});
		mockKVInstance.getHistory.mockResolvedValue(existingHistory);

		await answerQuestion('test question', mockEnv);

		expect(createGeminiClient).toHaveBeenCalledWith(mockEnv.GEMINI_API_KEY, existingHistory);
	});

	it('returns the response from Gemini', async () => {
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'sheet',
			description: 'desc',
		});
		mockGeminiInstance.ask.mockResolvedValue('Gemini answer');

		const result = await answerQuestion('test question', mockEnv);

		expect(result).toBe('Gemini answer');
	});

	it('calls Gemini ask with correct parameters', async () => {
		mockKVInstance.getCache.mockResolvedValue({
			sheetInfo: 'sheet data',
			description: 'sheet description',
		});

		await answerQuestion('user question', mockEnv);

		expect(mockGeminiInstance.ask).toHaveBeenCalledWith('user question', 'sheet data', 'sheet description');
	});
});
