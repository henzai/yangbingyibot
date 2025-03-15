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

export class KV {
	private kv: KVNamespace;

	constructor(kv: KVNamespace) {
		this.kv = kv;
	}

	async saveHistory(history: { role: string; text: string }[]) {
		await this.kv.put(HISTORY_KEY, JSON.stringify(history));
	}

	async getHistory(): Promise<{ role: string; text: string }[]> {
		const history = await this.kv.get(HISTORY_KEY);
		return history ? JSON.parse(history) : [];
	}
}

export const createKV = (kv: KVNamespace): KV => {
	return new KV(kv);
};

// キャッシュを取得する関数
export const getCache = async function (kv: KVNamespace): Promise<Omit<SheetInfo, 'time'> | null> {
	const cachedData = await kv.get<SheetInfo>(SHEET_INFO);
	if (cachedData) {
		if (Date.now() - cachedData.time < CACHE_DURATION_MS) {
			return cachedData;
		}
	}
	return null;
};

// キャッシュを保存する関数
export const saveSheetInfo = async function (sheetInfo: string, description: string, kv: KVNamespace): Promise<void> {
	const newCacheData: SheetInfo = {
		time: Date.now(),
		sheetInfo: sheetInfo,
		description: description,
	};
	await kv.put(SHEET_INFO, JSON.stringify(newCacheData));
};
