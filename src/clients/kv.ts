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

	constructor(kv: KVNamespace) {
		this.kv = kv;
	}

	async saveHistory(history: { role: string; text: string }[]) {
		const now = Date.now();
		const newHistory: ChatHistory[] = history.map((h) => ({
			...h,
			timestamp: now,
		}));
		await this.kv.put(HISTORY_KEY, JSON.stringify(newHistory));
	}

	async getHistory(): Promise<{ role: string; text: string }[]> {
		const historyStr = await this.kv.get(HISTORY_KEY);
		if (!historyStr) return [];

		const parsedHistory = JSON.parse(historyStr) as ChatHistory[];
		const fiveMinutesAgo = Date.now() - CACHE_DURATION_MS;

		// 5分以内の履歴のみを返す
		return parsedHistory.filter((h) => h.timestamp > fiveMinutesAgo).map(({ role, text }) => ({ role, text }));
	}

	async getCache(): Promise<Omit<SheetInfo, 'time'> | null> {
		const cachedData = await this.kv.get<SheetInfo>(SHEET_INFO);
		if (cachedData) {
			if (Date.now() - cachedData.time < CACHE_DURATION_MS) {
				return cachedData;
			}
		}
		return null;
	}

	async saveSheetInfo(sheetInfo: string, description: string): Promise<void> {
		const newCacheData: SheetInfo = {
			time: Date.now(),
			sheetInfo: sheetInfo,
			description: description,
		};
		await this.kv.put(SHEET_INFO, JSON.stringify(newCacheData));
	}
}

export const createKV = (kv: KVNamespace): KV => {
	return new KV(kv);
};
