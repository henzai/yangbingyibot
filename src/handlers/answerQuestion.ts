import { createGeminiClient } from '../clients/gemini';
import { getSheetDescription, getSheetInfo } from '../clients/spreadSheet';
import { createKV } from '../clients/kv';
import { Bindings } from '../types';
import { withTimeout } from '../utils/timeout';

// Constants
const SHEETS_TIMEOUT_MS = 10000; // 10 seconds
const GEMINI_TIMEOUT_MS = 30000; // 30 seconds (Gemini can be slow)

export async function answerQuestion(message: string, env: Bindings): Promise<string> {
	const kv = createKV(env.sushanshan_bot);

	try {
		// Phase 1: Get cache and history (KV operations)
		let cache;
		let history: { role: string; text: string }[];

		try {
			cache = await kv.getCache();
			history = await kv.getHistory();
		} catch (error) {
			console.error('KV read error (non-fatal, continuing without cache):', error);
			cache = null;
			history = [];
		}

		// Phase 2: Get sheet data (either from cache or fresh)
		let sheetInfo: string;
		let description: string;
		let shouldSaveCache = false;

		if (cache) {
			sheetInfo = cache.sheetInfo;
			description = cache.description;
		} else {
			try {
				[sheetInfo, description] = await withTimeout(
					Promise.all([
						getSheetInfo(env.GOOGLE_SERVICE_ACCOUNT),
						getSheetDescription(env.GOOGLE_SERVICE_ACCOUNT),
					]),
					SHEETS_TIMEOUT_MS,
					'スプレッドシートの取得がタイムアウトしました。'
				);
				shouldSaveCache = true;
			} catch (error) {
				// Sheets API failure is critical - can't answer without context
				console.error('Google Sheets API error:', error);
				throw new Error(
					error instanceof Error && error.message.includes('タイムアウト')
						? error.message
						: 'スプレッドシートからデータを取得できませんでした。しばらく待ってから再度お試しください。'
				);
			}
		}

		// Phase 3: Call Gemini AI
		let result: string;
		try {
			const llm = createGeminiClient(env.GEMINI_API_KEY, history);
			result = await withTimeout(
				llm.ask(message, sheetInfo, description),
				GEMINI_TIMEOUT_MS,
				'AI応答の生成がタイムアウトしました。質問を簡潔にしてお試しください。'
			);

			// Save history (best effort - don't fail if this errors)
			try {
				await kv.saveHistory(llm.getHistory());
			} catch (error) {
				console.error('Failed to save history (non-fatal):', error);
			}
		} catch (error) {
			console.error('Gemini API error:', error);
			throw new Error(
				error instanceof Error && error.message.includes('タイムアウト')
					? error.message
					: 'AI応答の生成中にエラーが発生しました。質問を変更してお試しください。'
			);
		}

		// Phase 4: Save cache if we fetched fresh data (best effort)
		if (shouldSaveCache) {
			try {
				await kv.saveCache(sheetInfo, description);
			} catch (error) {
				console.error('Failed to save cache (non-fatal):', error);
				// Don't fail the request just because caching failed
			}
		}

		return result;
	} catch (error) {
		// Re-throw user-friendly errors as-is
		if (error instanceof Error && (error.message.includes('スプレッドシート') || error.message.includes('AI応答'))) {
			throw error;
		}

		// Wrap unexpected errors
		console.error('Unexpected error in answerQuestion:', error);
		throw new Error('予期しないエラーが発生しました。後でもう一度お試しください。');
	}
}
