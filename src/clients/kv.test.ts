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
		it('saves history with expirationTtl', async () => {
			const history = [{ role: 'user', text: 'hello' }];

			await kv.saveHistory(history);

			expect(mockKV.put).toHaveBeenCalledWith(
				'chat_history',
				JSON.stringify([{ role: 'user', text: 'hello' }]),
				{ expirationTtl: 300 }
			);
		});

		it('strips extra fields from history entries', async () => {
			const history = [{ role: 'user', text: 'hello' }] as any;

			await kv.saveHistory(history);

			const savedData = JSON.parse((mockKV.put as Mock).mock.calls[0][1]);
			expect(savedData[0]).toEqual({ role: 'user', text: 'hello' });
			expect(savedData[0]).not.toHaveProperty('timestamp');
		});
	});

	describe('getHistory', () => {
		it('returns empty array when no history exists', async () => {
			(mockKV.get as Mock).mockResolvedValue(null);

			const result = await kv.getHistory();

			expect(result).toEqual([]);
		});

		it('returns all history entries (TTL handled by KV)', async () => {
			(mockKV.get as Mock).mockResolvedValue(
				JSON.stringify([
					{ role: 'user', text: 'first' },
					{ role: 'model', text: 'response' },
				])
			);

			const result = await kv.getHistory();

			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ role: 'user', text: 'first' });
			expect(result[1]).toEqual({ role: 'model', text: 'response' });
		});

		it('filters out invalid entries', async () => {
			(mockKV.get as Mock).mockResolvedValue(
				JSON.stringify([
					{ role: 'user', text: 'valid' },
					null,
					{ role: 123, text: 'invalid role' },
					{ role: 'user' },
				])
			);

			const result = await kv.getHistory();

			expect(result).toHaveLength(1);
			expect(result[0].text).toBe('valid');
		});

		it('returns empty array on invalid JSON', async () => {
			(mockKV.get as Mock).mockResolvedValue('not-json');

			const result = await kv.getHistory();

			expect(result).toEqual([]);
		});

		it('returns empty array when data is not an array', async () => {
			(mockKV.get as Mock).mockResolvedValue(JSON.stringify({ role: 'user', text: 'not array' }));

			const result = await kv.getHistory();

			expect(result).toEqual([]);
		});
	});

	describe('getCache', () => {
		it('returns null when no cache exists', async () => {
			(mockKV.get as Mock).mockResolvedValue(null);

			const result = await kv.getCache();

			expect(result).toBeNull();
		});

		it('returns cached data (TTL handled by KV)', async () => {
			const validCache = {
				sheetInfo: 'sheet data',
				description: 'description',
			};
			(mockKV.get as Mock).mockResolvedValue(validCache);

			const result = await kv.getCache();

			expect(result).toEqual({
				sheetInfo: 'sheet data',
				description: 'description',
			});
		});

		it('returns null for invalid cache structure', async () => {
			(mockKV.get as Mock).mockResolvedValue({ sheetInfo: 123 });

			const result = await kv.getCache();

			expect(result).toBeNull();
		});
	});

	describe('saveCache', () => {
		it('saves cache with expirationTtl', async () => {
			await kv.saveCache('sheet info', 'description');

			expect(mockKV.put).toHaveBeenCalledWith(
				'sheet_info',
				JSON.stringify({ sheetInfo: 'sheet info', description: 'description' }),
				{ expirationTtl: 300 }
			);
		});
	});

	describe('createKV', () => {
		it('creates a new KV instance', () => {
			const instance = createKV(mockKV);
			expect(instance).toBeInstanceOf(KV);
		});
	});
});
