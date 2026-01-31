import { createGeminiClient } from '../clients/gemini';
import { getSheetData } from '../clients/spreadSheet';
import { createKV } from '../clients/kv';
import { Bindings } from '../types';
import { withTimeout } from '../utils/timeout';
import { logger } from '../utils/logger';

// Constants
const SHEETS_TIMEOUT_MS = 10000; // 10 seconds
const GEMINI_TIMEOUT_MS = 30000; // 30 seconds (Gemini can be slow)

export async function answerQuestion(message: string, env: Bindings): Promise<string> {
	return await logger.trackTiming(
		'answerQuestion',
		async () => {
			const kv = createKV(env.sushanshan_bot);

			try {
				// Phase 1: Get cache and history (KV operations)
				const [cache, history] = await logger.trackTiming('kv-read', async () => {
					try {
						const cacheData = await kv.getCache();
						const historyData = await kv.getHistory();
						return [cacheData, historyData];
					} catch (error) {
						console.error('KV read error (non-fatal, continuing without cache):', error);
						return [null, []];
					}
				});

				// Phase 2: Get sheet data (either from cache or fresh)
				let sheetInfo: string;
				let description: string;
				let shouldSaveCache = false;

				if (cache) {
					logger.info('Cache hit');
					sheetInfo = cache.sheetInfo;
					description = cache.description;
				} else {
					logger.info('Cache miss, fetching from Google Sheets');

					try {
						// Use unified sheet fetch with single authentication
						const data = await logger.trackTiming(
							'sheets-fetch',
							async () => {
								return withTimeout(
									getSheetData(env.GOOGLE_SERVICE_ACCOUNT),
									SHEETS_TIMEOUT_MS,
									'スプレッドシートの取得がタイムアウトしました。'
								);
							},
							{ sheetSize: 0 } // Will be updated after fetch
						);
						sheetInfo = data.sheetInfo;
						description = data.description;
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
				let llm: ReturnType<typeof createGeminiClient>;
				try {
					llm = createGeminiClient(env.GEMINI_API_KEY, history);
					result = await logger.trackTiming(
						'gemini-api',
						async () => {
							return withTimeout(
								llm.ask(message, sheetInfo, description),
								GEMINI_TIMEOUT_MS,
								'AI応答の生成がタイムアウトしました。質問を簡潔にしてお試しください。'
							);
						},
						{
							promptSize: sheetInfo.length + description.length,
							historyLength: history.length,
						}
					);

					// Save history (best effort - don't fail if this errors)
					try {
						await logger.trackTiming('kv-write-history', async () => {
							await kv.saveHistory(llm.getHistory());
						});
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
						await logger.trackTiming('kv-write-cache', async () => {
							await kv.saveCache(sheetInfo, description);
						});
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
		},
		{ messageLength: message.length }
	);
}
