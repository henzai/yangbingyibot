import { GeminiClient } from '../clients/gemini';
import { getSheetDescription, getSheetInfo } from '../clients/spreadSheet';
import { getCache, saveSheetInfo } from '../clients/kv';
import { Bindings } from '../types';

export async function answerQuestion(message: string, env: Bindings): Promise<string> {
	const cache = await getCache(env.sushanshan_bot);

	const { sheetInfo, description } = cache ?? {
		sheetInfo: await getSheetInfo(env.GOOGLE_SERVICE_ACCOUNT),
		description: await getSheetDescription(env.GOOGLE_SERVICE_ACCOUNT),
	};

	if (!cache) {
		await saveSheetInfo(sheetInfo, description, env.sushanshan_bot);
	}

	const llm = new GeminiClient(env.GEMINI_API_KEY);
	return await llm.ask(message, sheetInfo, description);
}
