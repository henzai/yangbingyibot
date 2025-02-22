// KV用のキー
const SHEET_INFO = 'sheet_info';

// キャッシュの持続時間
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5分

// キャッシュの型
type SheetInfo = {
	time: number;
	sheetInfo: string;
};

// キャッシュを取得する関数
export const getCache = async function (kv: KVNamespace): Promise<string | null> {
	const cachedData = await kv.get<SheetInfo>(SHEET_INFO);
	if (cachedData) {
		if (Date.now() - cachedData.time < CACHE_DURATION_MS) {
			return cachedData.sheetInfo;
		}
	}
	return null;
};

// キャッシュを保存する関数
export const saveSheetInfo = async function (sheetInfo: string, kv: KVNamespace): Promise<void> {
	const newCacheData: SheetInfo = {
		time: Date.now(),
		sheetInfo: sheetInfo,
	};
	await kv.put(SHEET_INFO, JSON.stringify(newCacheData));
};
