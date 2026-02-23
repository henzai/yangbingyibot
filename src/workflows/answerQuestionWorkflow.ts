import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { GoogleGenAI } from "@google/genai";
import { createDiscordWebhookClient } from "../clients/discord";
import { createGeminiClient } from "../clients/gemini";
import { createGitHubIssueClient, type ErrorReport } from "../clients/github";
import { createKV } from "../clients/kv";
import {
	createMetricsClient,
	type IMetricsClient,
	NoOpMetricsClient,
} from "../clients/metrics";
import { getSheetData } from "../clients/spreadSheet";
import type { Bindings, HistoryEntry } from "../types";
import { getErrorMessage } from "../utils/errors";
import { type Logger, logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import type {
	DiscordResponseOutput,
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
			error: getErrorMessage(error),
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

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	history: HistoryEntry[],
	log: Logger,
): Promise<SaveHistoryOutput> {
	try {
		const kv = createKV(env.sushanshan_bot, log);
		await kv.saveHistory(history);
		log.info("History saved", { historyLength: history.length });
		return { success: true };
	} catch (error) {
		log.warn("Failed to save history (non-fatal)", {
			error: getErrorMessage(error),
		});
		return { success: false };
	}
}

// Buffering constants for Discord PATCH throttling
const DISCORD_EDIT_INTERVAL_MS = 1500;
const MIN_CHUNK_SIZE = 50;

// Thinking phase uses more aggressive intervals since updates are summarized
const THINKING_EDIT_INTERVAL_MS = 1000;
const THINKING_MIN_CHUNK_SIZE = 200;

const SUMMARIZE_MODEL = "gemini-2.0-flash-lite";
const THINKING_FALLBACK = "考え中...";

export async function summarizeThinking(
	client: GoogleGenAI,
	thinkingText: string,
	log: Logger,
): Promise<string> {
	try {
		const result = await client.models.generateContent({
			model: SUMMARIZE_MODEL,
			contents:
				"以下のAIの思考過程を日本語の1文（50文字以内）に要約してください。要約文のみを出力してください。\n\n" +
				thinkingText,
			config: {
				temperature: 0,
				maxOutputTokens: 128,
			},
		});
		const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
		if (text) {
			return text;
		}
		log.warn("Empty summarization result, using fallback");
		return THINKING_FALLBACK;
	} catch (error) {
		log.warn("Thinking summarization failed (non-fatal)", {
			error: getErrorMessage(error),
		});
		return THINKING_FALLBACK;
	}
}

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
	const summarizer = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

	let lastEditTime = 0;
	let lastThinkingEditLength = 0;
	let lastResponseEditLength = 0;
	let editCount = 0;
	let currentPhase: "thinking" | "response" = "thinking";
	let accumulatedThinking = "";

	const formatContent = (text: string) => `> ${question}\n${text}`;
	const formatThinkingContent = (summary: string) =>
		`> ${question}\n:thought_balloon: ${summary}`;

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

		// Accumulate thinking text from individual chunks
		if (phase === "thinking") {
			accumulatedThinking += accumulatedText;
		}

		// Use phase-specific throttling constants
		const editInterval =
			phase === "thinking"
				? THINKING_EDIT_INTERVAL_MS
				: DISCORD_EDIT_INTERVAL_MS;
		const minChunkSize =
			phase === "thinking" ? THINKING_MIN_CHUNK_SIZE : MIN_CHUNK_SIZE;

		const lastLen =
			phase === "thinking" ? lastThinkingEditLength : lastResponseEditLength;
		const textLength =
			phase === "thinking"
				? accumulatedThinking.length
				: accumulatedText.length;
		const newCharsCount = textLength - lastLen;

		if (
			isPhaseTransition ||
			(timeSinceLastEdit >= editInterval && newCharsCount >= minChunkSize)
		) {
			const content =
				phase === "thinking"
					? formatThinkingContent(
							await summarizeThinking(summarizer, accumulatedThinking, log),
						)
					: formatContent(accumulatedText);

			const success = await discord.editOriginalMessage(content);
			if (success) {
				lastEditTime = now;
				if (phase === "thinking") {
					lastThinkingEditLength = accumulatedThinking.length;
				} else {
					lastResponseEditLength = accumulatedText.length;
				}
				editCount++;
				log.debug("Discord message edited", {
					editCount,
					phase,
					contentLength: textLength,
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
	const discord = createDiscordWebhookClient(
		env.DISCORD_APPLICATION_ID,
		token,
		log,
	);

	const content = errorMessage
		? `> ${question}\n:rotating_light: エラーが発生しました: ${errorMessage}`
		: `> ${question}\n${response}`;

	let attemptCount = 0;
	let statusCode: number | undefined;

	try {
		await withRetry(
			async () => {
				attemptCount++;
				await discord.postMessage(content);
				statusCode = 200; // Success status
			},
			{
				maxAttempts: 3, // Initial attempt + 2 retries
				initialDelayMs: 1000,
				backoffMultiplier: 2,
			},
			() => true, // Retry all errors
			log,
		);

		return {
			success: true,
			statusCode: statusCode ?? 200,
			retryCount: attemptCount - 1, // retryCount = attempts - 1
		};
	} catch (error) {
		// Extract status code from error message if available
		const errorMsg = getErrorMessage(error);
		const match = errorMsg.match(/status (\d+)/);
		if (match) {
			statusCode = Number.parseInt(match[1], 10);
		}

		return {
			success: false,
			statusCode,
			retryCount: attemptCount > 0 ? attemptCount - 1 : 2, // Max retries is 2
		};
	}
}

const ERROR_REPORTED_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Report an error to GitHub Issues with KV + GitHub search deduplication.
 * Non-fatal: never throws, all errors are logged as warnings.
 * Must be called OUTSIDE step.do() to avoid Workflow retry.
 */
export async function reportErrorToGitHub(
	env: Bindings,
	report: ErrorReport,
	log: Logger,
): Promise<void> {
	try {
		if (!env.GITHUB_TOKEN) {
			log.debug("GITHUB_TOKEN not set, skipping error report");
			return;
		}

		const github = createGitHubIssueClient(env.GITHUB_TOKEN, log);
		const fingerprint = github.generateFingerprint(report.errorMessage);
		const kvKey = `error_reported:${fingerprint}`;

		// Layer 1: KV deduplication
		const kv = env.sushanshan_bot;
		const existing = await kv.get(kvKey);
		if (existing) {
			log.debug("Error already reported (KV cache hit)", { fingerprint });
			return;
		}

		// Layer 2: GitHub Issues search deduplication
		const isDup = await github.isDuplicate(fingerprint);
		if (isDup) {
			log.debug("Error already reported (GitHub search hit)", {
				fingerprint,
			});
			// Cache in KV to avoid repeated searches
			await kv.put(kvKey, "1", { expirationTtl: ERROR_REPORTED_TTL_SECONDS });
			return;
		}

		// Create the issue
		const created = await github.createIssue(report, fingerprint);
		if (created) {
			await kv.put(kvKey, "1", { expirationTtl: ERROR_REPORTED_TTL_SECONDS });
			log.info("Error reported to GitHub Issues", { fingerprint });
		}
	} catch (error) {
		log.warn("Failed to report error to GitHub (non-fatal)", {
			error: getErrorMessage(error),
		});
	}
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
			const errorMessage = getErrorMessage(error);
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

			// Report error to GitHub Issues (non-fatal, outside step.do)
			await reportErrorToGitHub(
				this.env,
				{
					errorMessage,
					requestId,
					workflowId: event.instanceId,
					durationMs: failureDurationMs,
					stepCount,
					timestamp: new Date().toISOString(),
				},
				log,
			);

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
