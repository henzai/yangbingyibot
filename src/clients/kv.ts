import { Logger, logger as defaultLogger } from '../utils/logger';

// KV用のキー
const SHEET_INFO = 'sheet_info';
const HISTORY_KEY = 'chat_history';

// キャッシュの持続時間
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5分

// キャッシュの型
type SheetInfo = {
	time: number;
	// スプレッドシートの情報
	sheetInfo: string;
	// スプレッドシートの説明
	description: string;
};

type ChatHistory = {
	timestamp: number;
	role: string;
	text: string;
};

export class KV {
	private kv: KVNamespace;
	private log: Logger;

	constructor(kv: KVNamespace, log?: Logger) {
		this.kv = kv;
		this.log = log ?? defaultLogger;
	}

	async saveHistory(history: { role: string; text: string }[]): Promise<void> {
		try {
			const now = Date.now();
			const newHistory: ChatHistory[] = history.map((h) => ({
				...h,
				timestamp: now,
			}));

			await this.kv.put(HISTORY_KEY, JSON.stringify(newHistory));
		} catch (error) {
			this.log.error('Failed to save history to KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			throw new Error('Failed to save conversation history');
		}
	}

	async getHistory(): Promise<{ role: string; text: string }[]> {
		try {
			const historyStr = await this.kv.get(HISTORY_KEY);
			if (!historyStr) return [];

			let parsedHistory: ChatHistory[];
			try {
				parsedHistory = JSON.parse(historyStr);
			} catch (parseError) {
				this.log.warn('Failed to parse history JSON, returning empty array', {
					error: parseError instanceof Error ? parseError.message : 'Unknown error',
				});
				return [];
			}

			// Validate array structure
			if (!Array.isArray(parsedHistory)) {
				this.log.warn('History data is not an array, returning empty array');
				return [];
			}

			const fiveMinutesAgo = Date.now() - CACHE_DURATION_MS;

			// 5分以内の履歴のみを返す (with validation)
			return parsedHistory
				.filter((h) => {
					// Validate each history item
					if (!h || typeof h !== 'object') return false;
					if (typeof h.timestamp !== 'number') return false;
					if (typeof h.role !== 'string' || typeof h.text !== 'string') return false;
					return h.timestamp > fiveMinutesAgo;
				})
				.map(({ role, text }) => ({ role, text }));
		} catch (error) {
			this.log.error('Failed to get history from KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			// Return empty array on error - don't fail the request
			return [];
		}
	}

	async getCache(): Promise<Omit<SheetInfo, 'time'> | null> {
		try {
			const cachedData = await this.kv.get<SheetInfo>(SHEET_INFO, "json");
			if (!cachedData) return null;

			// Validate cache structure
			if (
				typeof cachedData !== 'object' ||
				typeof cachedData.time !== 'number' ||
				typeof cachedData.sheetInfo !== 'string' ||
				typeof cachedData.description !== 'string'
			) {
				this.log.warn('Invalid cache data structure, ignoring cache');
				return null;
			}

			if (Date.now() - cachedData.time < CACHE_DURATION_MS) {
				return cachedData;
			}

			return null;
		} catch (error) {
			this.log.error('Failed to get cache from KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			// Return null on error - will fetch fresh data
			return null;
		}
	}

	async saveCache(sheetInfo: string, description: string): Promise<void> {
		try {
			const newCacheData: SheetInfo = {
				time: Date.now(),
				sheetInfo: sheetInfo,
				description: description,
			};

			await this.kv.put(SHEET_INFO, JSON.stringify(newCacheData));
		} catch (error) {
			this.log.error('Failed to save cache to KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			throw new Error('Failed to save cache data');
		}
	}
}

export const createKV = (kv: KVNamespace, log?: Logger): KV => {
	return new KV(kv, log);
};
