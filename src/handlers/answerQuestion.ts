import { createGeminiClient } from '../clients/gemini';
import { getSheetDescription, getSheetInfo } from '../clients/spreadSheet';
import { createKV } from '../clients/kv';
import { Bindings } from '../types';

export async function answerQuestion(message: string, env: Bindings): Promise<string> {
	const kv = createKV(env.sushanshan_bot);
	const cache = await kv.getCache();

	const { sheetInfo, description } = cache ?? {
		sheetInfo: await getSheetInfo(env.GOOGLE_SERVICE_ACCOUNT),
		description: await getSheetDescription(env.GOOGLE_SERVICE_ACCOUNT),
	};

	if (!cache) {
		await kv.saveSheetInfo(sheetInfo, description);
	}

	const history = await kv.getHistory();
	const llm = createGeminiClient(env.GEMINI_API_KEY, history);
	const result = await llm.ask(message, sheetInfo, description);

	// historyをKVに保存
	await kv.saveHistory(llm.getHistory());

	return result;
}
