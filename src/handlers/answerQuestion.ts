import { GeminiClient } from '../clients/gemini';
import { getSheetInfo } from '../clients/spreadSheet';
import { getCache, saveSheetInfo } from '../clients/kv';
import { Bindings } from '../types';

export async function answerQuestion(message: string, env: Bindings): Promise<string> {
	// まずキャッシュを確認
	let sheetInfo = await getCache(env.sushanshan_bot);

	// キャッシュがない場合はスプレッドシートから取得
	if (!sheetInfo) {
		sheetInfo = await getSheetInfo(env.GOOGLE_SERVICE_ACCOUNT);
		// 新しい情報をキャッシュに保存
		await saveSheetInfo(sheetInfo, env.sushanshan_bot);
	}

	const llm = new GeminiClient(env.GEMINI_API_KEY);
	return await llm.ask(message, sheetInfo);
}
