import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createKV } from '../clients/kv';
import { createGeminiClient } from '../clients/gemini';
import { getSheetData } from '../clients/spreadSheet';
import { Bindings } from '../types';
import { Logger, logger } from '../utils/logger';
import type {
	WorkflowParams,
	SheetDataOutput,
	HistoryOutput,
	GeminiOutput,
	SaveHistoryOutput,
	DiscordResponseOutput,
} from './types';

// Step 1: Get sheet data from KV cache or Google Sheets
export async function getSheetDataStep(env: Bindings, log: Logger): Promise<SheetDataOutput> {
	const kv = createKV(env.sushanshan_bot, log);

	const cache = await kv.getCache();
	if (cache) {
		log.info('Sheet data loaded from cache');
		return {
			sheetInfo: cache.sheetInfo,
			description: cache.description,
			fromCache: true,
		};
	}

	log.info('Fetching sheet data from Google Sheets');
	const data = await getSheetData(env.GOOGLE_SERVICE_ACCOUNT, log);

	// Save to cache (best effort)
	try {
		await kv.saveCache(data.sheetInfo, data.description);
		log.info('Sheet data cached');
	} catch (error) {
		log.warn('Failed to save cache (non-fatal)', {
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}

	return {
		sheetInfo: data.sheetInfo,
		description: data.description,
		fromCache: false,
	};
}

// Step 2: Get conversation history from KV
export async function getHistoryStep(env: Bindings, log: Logger): Promise<HistoryOutput> {
	const kv = createKV(env.sushanshan_bot, log);
	const history = await kv.getHistory();
	log.info('History loaded', { historyLength: history.length });
	return { history };
}

// Step 3: Call Gemini API
export async function callGeminiStep(
	env: Bindings,
	message: string,
	sheetData: SheetDataOutput,
	historyOutput: HistoryOutput,
	log: Logger
): Promise<GeminiOutput> {
	log.info('Calling Gemini API', { messageLength: message.length });
	const gemini = createGeminiClient(env.GEMINI_API_KEY, historyOutput.history, log);
	const response = await gemini.ask(message, sheetData.sheetInfo, sheetData.description);
	const updatedHistory = gemini.getHistory();
	log.info('Gemini response received', { responseLength: response.length });

	return {
		response,
		updatedHistory,
	};
}

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	history: { role: string; text: string }[],
	log: Logger
): Promise<SaveHistoryOutput> {
	try {
		const kv = createKV(env.sushanshan_bot, log);
		await kv.saveHistory(history);
		log.info('History saved', { historyLength: history.length });
		return { success: true };
	} catch (error) {
		log.warn('Failed to save history (non-fatal)', {
			error: error instanceof Error ? error.message : 'Unknown error',
		});
		return { success: false };
	}
}

// Step 5: Send response to Discord webhook
export async function sendDiscordResponseStep(
	env: Bindings,
	token: string,
	question: string,
	response: string | null,
	log: Logger,
	errorMessage?: string
): Promise<DiscordResponseOutput> {
	const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;

	const content = errorMessage
		? `> ${question}\n:rotating_light: エラーが発生しました: ${errorMessage}`
		: `> ${question}\n${response}`;

	const maxRetries = 2;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				body: JSON.stringify({ content }),
				headers: { 'Content-Type': 'application/json' },
			});

			if (res.ok) {
				log.info('Discord webhook sent successfully', { statusCode: res.status, attempt });
				return { success: true, statusCode: res.status };
			}

			if (attempt === maxRetries) {
				log.error('Discord webhook failed', { statusCode: res.status, attempt });
				return { success: false, statusCode: res.status };
			}

			log.warn('Discord webhook retry', { statusCode: res.status, attempt });
			// Wait before retry (exponential backoff)
			await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
		} catch (error) {
			if (attempt === maxRetries) {
				log.error('Discord webhook failed after retries', {
					error: error instanceof Error ? error.message : 'Unknown error',
					attempt,
				});
				return { success: false };
			}
			log.warn('Discord webhook error, retrying', {
				error: error instanceof Error ? error.message : 'Unknown error',
				attempt,
			});
			await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
		}
	}

	return { success: false };
}

// Workflow class
export class AnswerQuestionWorkflow extends WorkflowEntrypoint<Bindings, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { token, message, requestId } = event.payload;
		const log = logger.withContext({ requestId, workflowId: event.instanceId });

		log.info('Workflow started', { messageLength: message.length });
		const startTime = Date.now();

		try {
			// Step 1: Get sheet data
			const sheetData = await step.do('getSheetData', async () => {
				return getSheetDataStep(this.env, log.withContext({ step: 'getSheetData' }));
			});

			// Step 2: Get conversation history
			const historyOutput = await step.do('getHistory', async () => {
				return getHistoryStep(this.env, log.withContext({ step: 'getHistory' }));
			});

			// Step 3: Call Gemini AI
			const geminiResult = await step.do(
				'callGemini',
				{
					retries: {
						limit: 2,
						delay: '1 second',
						backoff: 'exponential',
					},
					timeout: '60 seconds',
				},
				async () => {
					return callGeminiStep(
						this.env,
						message,
						sheetData,
						historyOutput,
						log.withContext({ step: 'callGemini' })
					);
				}
			);

			// Step 4: Save history
			await step.do('saveHistory', async () => {
				return saveHistoryStep(
					this.env,
					geminiResult.updatedHistory,
					log.withContext({ step: 'saveHistory' })
				);
			});

			// Step 5: Send Discord response
			await step.do('sendDiscordResponse', async () => {
				return sendDiscordResponseStep(
					this.env,
					token,
					message,
					geminiResult.response,
					log.withContext({ step: 'sendDiscordResponse' })
				);
			});

			log.info('Workflow completed successfully', { durationMs: Date.now() - startTime });
		} catch (error) {
			// Send error response to Discord
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			log.error('Workflow error', {
				error: errorMessage,
				durationMs: Date.now() - startTime,
			});

			await step.do('sendErrorResponse', async () => {
				return sendDiscordResponseStep(
					this.env,
					token,
					message,
					null,
					log.withContext({ step: 'sendErrorResponse' }),
					errorMessage
				);
			});
		}
	}
}
