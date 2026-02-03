import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createKV } from '../clients/kv';
import { createGeminiClient } from '../clients/gemini';
import { getSheetData } from '../clients/spreadSheet';
import { Bindings } from '../types';
import type {
	WorkflowParams,
	SheetDataOutput,
	HistoryOutput,
	GeminiOutput,
	SaveHistoryOutput,
	DiscordResponseOutput,
} from './types';

// Step 1: Get sheet data from KV cache or Google Sheets
export async function getSheetDataStep(env: Bindings): Promise<SheetDataOutput> {
	const kv = createKV(env.sushanshan_bot);

	const cache = await kv.getCache();
	if (cache) {
		return {
			sheetInfo: cache.sheetInfo,
			description: cache.description,
			fromCache: true,
		};
	}

	const data = await getSheetData(env.GOOGLE_SERVICE_ACCOUNT);

	// Save to cache (best effort)
	try {
		await kv.saveCache(data.sheetInfo, data.description);
	} catch (error) {
		console.error('Failed to save cache (non-fatal):', error);
	}

	return {
		sheetInfo: data.sheetInfo,
		description: data.description,
		fromCache: false,
	};
}

// Step 2: Get conversation history from KV
export async function getHistoryStep(env: Bindings): Promise<HistoryOutput> {
	const kv = createKV(env.sushanshan_bot);
	const history = await kv.getHistory();
	return { history };
}

// Step 3: Call Gemini API
export async function callGeminiStep(
	env: Bindings,
	message: string,
	sheetData: SheetDataOutput,
	historyOutput: HistoryOutput
): Promise<GeminiOutput> {
	const gemini = createGeminiClient(env.GEMINI_API_KEY, historyOutput.history);
	const response = await gemini.ask(message, sheetData.sheetInfo, sheetData.description);
	const updatedHistory = gemini.getHistory();

	return {
		response,
		updatedHistory,
	};
}

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	history: { role: string; text: string }[]
): Promise<SaveHistoryOutput> {
	try {
		const kv = createKV(env.sushanshan_bot);
		await kv.saveHistory(history);
		return { success: true };
	} catch (error) {
		console.error('Failed to save history (non-fatal):', error);
		return { success: false };
	}
}

// Step 5: Send response to Discord webhook
export async function sendDiscordResponseStep(
	env: Bindings,
	token: string,
	question: string,
	response: string | null,
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
				return { success: true, statusCode: res.status };
			}

			if (attempt === maxRetries) {
				return { success: false, statusCode: res.status };
			}

			// Wait before retry (exponential backoff)
			await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
		} catch (error) {
			if (attempt === maxRetries) {
				console.error('Discord webhook failed after retries:', error);
				return { success: false };
			}
			await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
		}
	}

	return { success: false };
}

// Workflow class
export class AnswerQuestionWorkflow extends WorkflowEntrypoint<Bindings, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { token, message } = event.payload;

		try {
			// Step 1: Get sheet data
			const sheetData = await step.do('getSheetData', async () => {
				return getSheetDataStep(this.env);
			});

			// Step 2: Get conversation history
			const historyOutput = await step.do('getHistory', async () => {
				return getHistoryStep(this.env);
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
					return callGeminiStep(this.env, message, sheetData, historyOutput);
				}
			);

			// Step 4: Save history
			await step.do('saveHistory', async () => {
				return saveHistoryStep(this.env, geminiResult.updatedHistory);
			});

			// Step 5: Send Discord response
			await step.do('sendDiscordResponse', async () => {
				return sendDiscordResponseStep(this.env, token, message, geminiResult.response);
			});
		} catch (error) {
			// Send error response to Discord
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			console.error('Workflow error:', error);

			await step.do('sendErrorResponse', async () => {
				return sendDiscordResponseStep(this.env, token, message, null, errorMessage);
			});
		}
	}
}
