import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDiscordWebhookClient } from "../clients/discord";
import { createGeminiClient } from "../clients/gemini";
import { createKV } from "../clients/kv";
import {
	createMetricsClient,
	type IMetricsClient,
	NoOpMetricsClient,
} from "../clients/metrics";
import { getSheetData } from "../clients/spreadSheet";
import type { Bindings } from "../types";
import { type Logger, logger } from "../utils/logger";
import type {
	DiscordResponseOutput,
	GeminiOutput,
	HistoryOutput,
	SaveHistoryOutput,
	SheetDataOutput,
	StreamingGeminiOutput,
	WorkflowParams,
} from "./types";

/**
 * Get MetricsClient from env, falling back to NoOp if binding is unavailable
 */
function getMetricsClient(env: Bindings, log: Logger): IMetricsClient {
	if (env.METRICS) {
		return createMetricsClient(env.METRICS, log);
	}
	return new NoOpMetricsClient();
}

// Step 1: Get sheet data from KV cache or Google Sheets
export async function getSheetDataStep(
	env: Bindings,
	log: Logger,
): Promise<SheetDataOutput> {
	const kv = createKV(env.sushanshan_bot, log);

	const cache = await kv.getCache();
	if (cache) {
		log.info("Sheet data loaded from cache");
		return {
			sheetInfo: cache.sheetInfo,
			description: cache.description,
			fromCache: true,
		};
	}

	log.info("Fetching sheet data from Google Sheets");
	const data = await getSheetData(env.GOOGLE_SERVICE_ACCOUNT, log);

	// Save to cache (best effort)
	try {
		await kv.saveCache(data.sheetInfo, data.description);
		log.info("Sheet data cached");
	} catch (error) {
		log.warn("Failed to save cache (non-fatal)", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	return {
		sheetInfo: data.sheetInfo,
		description: data.description,
		fromCache: false,
	};
}

// Step 2: Get conversation history from KV
export async function getHistoryStep(
	env: Bindings,
	log: Logger,
): Promise<HistoryOutput> {
	const kv = createKV(env.sushanshan_bot, log);
	const history = await kv.getHistory();
	log.info("History loaded", { historyLength: history.length });
	return { history };
}

// Step 3: Call Gemini API
export async function callGeminiStep(
	env: Bindings,
	message: string,
	sheetData: SheetDataOutput,
	historyOutput: HistoryOutput,
	log: Logger,
): Promise<GeminiOutput> {
	log.info("Calling Gemini API", { messageLength: message.length });
	const gemini = createGeminiClient(
		env.GEMINI_API_KEY,
		historyOutput.history,
		log,
	);
	const response = await gemini.ask(
		message,
		sheetData.sheetInfo,
		sheetData.description,
	);
	const updatedHistory = gemini.getHistory();
	log.info("Gemini response received", { responseLength: response.length });

	return {
		response,
		updatedHistory,
	};
}

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	history: { role: string; text: string }[],
	log: Logger,
): Promise<SaveHistoryOutput> {
	try {
		const kv = createKV(env.sushanshan_bot, log);
		await kv.saveHistory(history);
		log.info("History saved", { historyLength: history.length });
		return { success: true };
	} catch (error) {
		log.warn("Failed to save history (non-fatal)", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return { success: false };
	}
}

// Buffering constants for Discord PATCH throttling
const DISCORD_EDIT_INTERVAL_MS = 1500;
const MIN_CHUNK_SIZE = 50;

// Step 3+5 combined: Stream Gemini response + progressively edit Discord message
export async function streamGeminiWithDiscordEditsStep(
	env: Bindings,
	token: string,
	question: string,
	message: string,
	sheetData: SheetDataOutput,
	historyOutput: HistoryOutput,
	log: Logger,
): Promise<StreamingGeminiOutput> {
	const discord = createDiscordWebhookClient(
		env.DISCORD_APPLICATION_ID,
		token,
		log,
	);
	const gemini = createGeminiClient(
		env.GEMINI_API_KEY,
		historyOutput.history,
		log,
	);

	let lastEditTime = 0;
	let lastThinkingEditLength = 0;
	let lastResponseEditLength = 0;
	let editCount = 0;
	let currentPhase: "thinking" | "response" = "thinking";

	const formatContent = (text: string) => `> ${question}\n${text}`;
	const formatThinkingContent = (thinkingText: string) => {
		const prefix = ":thought_balloon: **考え中...**\n";
		const overhead =
			`> ${question}\n`.length + prefix.length + "```\n\n```".length;
		const maxThinkingLength = 2000 - overhead;
		const truncated =
			thinkingText.length > maxThinkingLength
				? `...${thinkingText.slice(-(maxThinkingLength - 3))}`
				: thinkingText;
		return `> ${question}\n${prefix}\`\`\`\n${truncated}\n\`\`\``;
	};

	const onChunk = async (
		accumulatedText: string,
		phase: "thinking" | "response",
	) => {
		const now = Date.now();
		const timeSinceLastEdit = now - lastEditTime;

		// Force an immediate edit on phase transition from thinking to response
		const isPhaseTransition =
			phase === "response" && currentPhase === "thinking";
		currentPhase = phase;

		const content =
			phase === "thinking"
				? formatThinkingContent(accumulatedText)
				: formatContent(accumulatedText);

		const lastLen =
			phase === "thinking" ? lastThinkingEditLength : lastResponseEditLength;
		const newCharsCount = accumulatedText.length - lastLen;

		if (
			isPhaseTransition ||
			(timeSinceLastEdit >= DISCORD_EDIT_INTERVAL_MS &&
				newCharsCount >= MIN_CHUNK_SIZE)
		) {
			const success = await discord.editOriginalMessage(content);
			if (success) {
				lastEditTime = now;
				if (phase === "thinking") {
					lastThinkingEditLength = accumulatedText.length;
				} else {
					lastResponseEditLength = accumulatedText.length;
				}
				editCount++;
				log.debug("Discord message edited", {
					editCount,
					phase,
					contentLength: accumulatedText.length,
				});
			}
		}
	};

	log.info("Starting Gemini streaming with Discord edits");
	const response = await gemini.askStream(
		message,
		sheetData.sheetInfo,
		sheetData.description,
		onChunk,
	);

	// Final edit to ensure complete response is shown (response only, no thinking)
	await discord.editOriginalMessage(formatContent(response));
	editCount++;
	log.info("Final Discord edit sent", {
		editCount,
		responseLength: response.length,
	});

	return {
		response,
		updatedHistory: gemini.getHistory(),
		editCount,
	};
}

// Step 5: Send response to Discord webhook (used for error messages)
export async function sendDiscordResponseStep(
	env: Bindings,
	token: string,
	question: string,
	response: string | null,
	log: Logger,
	errorMessage?: string,
): Promise<DiscordResponseOutput> {
	const endpoint = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${token}`;

	const content = errorMessage
		? `> ${question}\n:rotating_light: エラーが発生しました: ${errorMessage}`
		: `> ${question}\n${response}`;

	const maxRetries = 2;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				body: JSON.stringify({ content }),
				headers: { "Content-Type": "application/json" },
			});

			if (res.ok) {
				log.info("Discord webhook sent successfully", {
					statusCode: res.status,
					attempt,
				});
				return { success: true, statusCode: res.status, retryCount: attempt };
			}

			if (attempt === maxRetries) {
				log.error("Discord webhook failed", {
					statusCode: res.status,
					attempt,
				});
				return { success: false, statusCode: res.status, retryCount: attempt };
			}

			log.warn("Discord webhook retry", { statusCode: res.status, attempt });
			// Wait before retry (exponential backoff)
			await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
		} catch (error) {
			if (attempt === maxRetries) {
				log.error("Discord webhook failed after retries", {
					error: error instanceof Error ? error.message : "Unknown error",
					attempt,
				});
				return { success: false, retryCount: attempt };
			}
			log.warn("Discord webhook error, retrying", {
				error: error instanceof Error ? error.message : "Unknown error",
				attempt,
			});
			await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
		}
	}

	return { success: false, retryCount: maxRetries };
}

// Workflow class
export class AnswerQuestionWorkflow extends WorkflowEntrypoint<
	Bindings,
	WorkflowParams
> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { token, message, requestId } = event.payload;
		const log = logger.withContext({ requestId, workflowId: event.instanceId });
		const metrics = getMetricsClient(this.env, log);

		log.info("Workflow started", { messageLength: message.length });
		const workflowStartTime = Date.now();
		let stepCount = 0;
		let fromCache = false;

		try {
			// Step 1: Get sheet data
			const sheetDataStartTime = Date.now();
			const sheetData = await step.do("getSheetData", async () => {
				return getSheetDataStep(
					this.env,
					log.withContext({ step: "getSheetData" }),
				);
			});
			stepCount++;
			fromCache = sheetData.fromCache;

			const sheetDataDurationMs = Date.now() - sheetDataStartTime;

			// Record cache access metric
			metrics.recordKVCacheAccess({
				requestId,
				success: true,
				durationMs: sheetDataDurationMs,
				cacheHit: sheetData.fromCache,
				operation: "get",
			});

			// Record sheets API metric if cache was missed
			if (!sheetData.fromCache) {
				metrics.recordSheetsApiCall({
					requestId,
					success: true,
					durationMs: sheetDataDurationMs,
				});
			}

			// Step 2: Get conversation history
			const historyOutput = await step.do("getHistory", async () => {
				return getHistoryStep(
					this.env,
					log.withContext({ step: "getHistory" }),
				);
			});
			stepCount++;

			// Step 3: Stream Gemini response + progressively edit Discord message
			const geminiStartTime = Date.now();
			let geminiSuccess = false;
			let streamResult: StreamingGeminiOutput;
			try {
				streamResult = await step.do(
					"streamGeminiAndEditDiscord",
					{
						retries: {
							limit: 2,
							delay: "1 second",
							backoff: "exponential",
						},
						timeout: "120 seconds",
					},
					async () => {
						return streamGeminiWithDiscordEditsStep(
							this.env,
							token,
							message,
							message,
							sheetData,
							historyOutput,
							log.withContext({ step: "streamGeminiAndEditDiscord" }),
						);
					},
				);
				geminiSuccess = true;
				stepCount++;
			} finally {
				metrics.recordGeminiCall({
					requestId,
					success: geminiSuccess,
					durationMs: Date.now() - geminiStartTime,
				});
			}

			// Step 4: Save history
			await step.do("saveHistory", async () => {
				return saveHistoryStep(
					this.env,
					streamResult.updatedHistory,
					log.withContext({ step: "saveHistory" }),
				);
			});
			stepCount++;

			// Record workflow completion (success)
			metrics.recordWorkflowComplete({
				requestId,
				workflowId: event.instanceId,
				success: true,
				durationMs: Date.now() - workflowStartTime,
				stepCount,
				fromCache,
			});

			log.info("Workflow completed successfully", {
				durationMs: Date.now() - workflowStartTime,
			});
		} catch (error) {
			// Send error response to Discord
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error occurred";
			const failureDurationMs = Date.now() - workflowStartTime;
			log.error("Workflow error", {
				error: errorMessage,
				durationMs: failureDurationMs,
			});

			// Record workflow completion (failure)
			metrics.recordWorkflowComplete({
				requestId,
				workflowId: event.instanceId,
				success: false,
				durationMs: failureDurationMs,
				stepCount,
				fromCache,
			});

			const discordErrorStartTime = Date.now();
			const discordErrorResult = await step.do(
				"sendErrorResponse",
				async () => {
					return sendDiscordResponseStep(
						this.env,
						token,
						message,
						null,
						log.withContext({ step: "sendErrorResponse" }),
						errorMessage,
					);
				},
			);

			metrics.recordDiscordWebhook({
				requestId,
				success: discordErrorResult.success,
				durationMs: Date.now() - discordErrorStartTime,
				retryCount: discordErrorResult.retryCount,
				statusCode: discordErrorResult.statusCode,
			});
		}
	}
}
