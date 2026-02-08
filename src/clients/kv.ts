import { Logger, logger as defaultLogger } from '../utils/logger';

// KV用のキー
const SHEET_INFO = 'sheet_info';
const HISTORY_KEY = 'chat_history';

// キャッシュの持続時間（秒）- KVネイティブTTLで使用
const CACHE_TTL_SECONDS = 5 * 60; // 5分

// キャッシュの型
type SheetInfo = {
	sheetInfo: string;
	description: string;
};

type ChatHistory = {
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
			const newHistory: ChatHistory[] = history.map(({ role, text }) => ({
				role,
				text,
			}));

			await this.kv.put(HISTORY_KEY, JSON.stringify(newHistory), {
				expirationTtl: CACHE_TTL_SECONDS,
			});
		} catch (error) {
			this.log.error('Failed to save history to KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			throw new Error('Failed to save conversation history');
		}
	}

	async getHistory(): Promise<{ role: string; text: string }[]> {
		try {
			// KVネイティブTTLにより期限切れデータは自動的にnullになる
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

			if (!Array.isArray(parsedHistory)) {
				this.log.warn('History data is not an array, returning empty array');
				return [];
			}

			return parsedHistory
				.filter((h) => {
					if (!h || typeof h !== 'object') return false;
					if (typeof h.role !== 'string' || typeof h.text !== 'string') return false;
					return true;
				})
				.map(({ role, text }) => ({ role, text }));
		} catch (error) {
			this.log.error('Failed to get history from KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return [];
		}
	}

	async getCache(): Promise<SheetInfo | null> {
		try {
			// KVネイティブTTLにより期限切れデータは自動的にnullになる
			const cachedData = await this.kv.get<SheetInfo>(SHEET_INFO, "json");
			if (!cachedData) return null;

			if (
				typeof cachedData !== 'object' ||
				typeof cachedData.sheetInfo !== 'string' ||
				typeof cachedData.description !== 'string'
			) {
				this.log.warn('Invalid cache data structure, ignoring cache');
				return null;
			}

			return cachedData;
		} catch (error) {
			this.log.error('Failed to get cache from KV', {
				error: error instanceof Error ? error.message : 'Unknown error',
			});
			return null;
		}
	}

	async saveCache(sheetInfo: string, description: string): Promise<void> {
		try {
			const newCacheData: SheetInfo = {
				sheetInfo: sheetInfo,
				description: description,
			};

			await this.kv.put(SHEET_INFO, JSON.stringify(newCacheData), {
				expirationTtl: CACHE_TTL_SECONDS,
			});
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
