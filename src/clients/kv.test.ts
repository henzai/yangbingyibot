import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { KV, createKV } from './kv';

const createMockKVNamespace = () =>
	({
		get: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	}) as unknown as KVNamespace;

describe('KV class', () => {
	let mockKV: KVNamespace;
	let kv: KV;

	beforeEach(() => {
		vi.clearAllMocks();
		mockKV = createMockKVNamespace();
		kv = new KV(mockKV);
	});

	describe('saveHistory', () => {
		it('saves history with current timestamp', async () => {
			const history = [{ role: 'user', text: 'hello' }];

			await kv.saveHistory(history);

			expect(mockKV.put).toHaveBeenCalledWith('chat_history', expect.stringContaining('"role":"user"'));
			expect(mockKV.put).toHaveBeenCalledWith('chat_history', expect.stringContaining('"text":"hello"'));
			expect(mockKV.put).toHaveBeenCalledWith('chat_history', expect.stringContaining('"timestamp":'));
		});
	});

	describe('getHistory', () => {
		it('returns empty array when no history exists', async () => {
			(mockKV.get as Mock).mockResolvedValue(null);

			const result = await kv.getHistory();

			expect(result).toEqual([]);
		});

		it('filters out history older than 5 minutes', async () => {
			const oldTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago
			const recentTimestamp = Date.now() - 2 * 60 * 1000; // 2 minutes ago

			(mockKV.get as Mock).mockResolvedValue(
				JSON.stringify([
					{ role: 'user', text: 'old', timestamp: oldTimestamp },
					{ role: 'user', text: 'recent', timestamp: recentTimestamp },
				])
			);

			const result = await kv.getHistory();

			expect(result).toHaveLength(1);
			expect(result[0].text).toBe('recent');
		});

		it('returns history within 5-minute window', async () => {
			const recentTimestamp = Date.now() - 2 * 60 * 1000; // 2 minutes ago

			(mockKV.get as Mock).mockResolvedValue(
				JSON.stringify([{ role: 'model', text: 'response', timestamp: recentTimestamp }])
			);

			const result = await kv.getHistory();

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ role: 'model', text: 'response' });
		});
	});

	describe('getCache', () => {
		it('returns null when no cache exists', async () => {
			(mockKV.get as Mock).mockResolvedValue(null);

			const result = await kv.getCache();

			expect(result).toBeNull();
		});

		it('returns null when cache is expired (older than 5 minutes)', async () => {
			const expiredCache = {
				time: Date.now() - 6 * 60 * 1000,
				sheetInfo: 'data',
				description: 'desc',
			};
			(mockKV.get as Mock).mockResolvedValue(expiredCache);

			const result = await kv.getCache();

			expect(result).toBeNull();
		});

		it('returns cached data when within 5 minutes', async () => {
			const validCache = {
				time: Date.now() - 2 * 60 * 1000,
				sheetInfo: 'sheet data',
				description: 'description',
			};
			(mockKV.get as Mock).mockResolvedValue(validCache);

			const result = await kv.getCache();

			expect(result).toEqual({
				sheetInfo: 'sheet data',
				description: 'description',
				time: validCache.time,
			});
		});
	});

	describe('saveCache', () => {
		it('saves cache with current timestamp', async () => {
			await kv.saveCache('sheet info', 'description');

			expect(mockKV.put).toHaveBeenCalledWith('sheet_info', expect.stringContaining('"sheetInfo":"sheet info"'));
			expect(mockKV.put).toHaveBeenCalledWith('sheet_info', expect.stringContaining('"description":"description"'));
			expect(mockKV.put).toHaveBeenCalledWith('sheet_info', expect.stringContaining('"time":'));
		});
	});

	describe('createKV', () => {
		it('creates a new KV instance', () => {
			const instance = createKV(mockKV);
			expect(instance).toBeInstanceOf(KV);
		});
	});
});
