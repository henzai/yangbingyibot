import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDiscordWebhookClient } from "../clients/discord";
import { createGitHubIssueClient, type ErrorReport } from "../clients/github";
import {
	createMetricsClient,
	type IMetricsClient,
	NoOpMetricsClient,
} from "../clients/metrics";
import { getSheetData } from "../clients/spreadSheet";
import { type AppConfig, loadConfig } from "../config";
import type { Bindings, HistoryEntry } from "../contracts";
import { createDiscordDeliveryService } from "../discord/delivery";
import {
	formatAnswer,
	formatError,
	formatThinking,
	normalizeDiscordText,
} from "../discord/formatter";
import { createLlmGateway } from "../llm/factory";
import { buildAnswerPrompt } from "../llm/promptBuilder";
import { StreamCoordinator } from "../llm/streamCoordinator";
import {
	createThinkingSummarizer,
	THINKING_FALLBACK,
} from "../llm/thinkingSummarizer";
import type { LlmFinish } from "../llm/types";
import { addLlmUsage, normalizeSavedUsage, zeroUsage } from "../llm/usage";
import {
	createConversationHistoryRepository,
	normalizeHistory,
} from "../repositories/conversationHistory";
import { createDeduplicationStore } from "../repositories/deduplicationStore";
import { createSheetCacheRepository } from "../repositories/sheetCache";
import {
	ExternalServiceError,
	getErrorMessage,
	getExternalErrorLogContext,
	getUserMessage,
} from "../utils/errors";
import { type Logger, logger } from "../utils/logger";
import type {
	DiscordResponseOutput,
	HistoryOutput,
	SaveHistoryOutput,
	SheetDataOutput,
	StreamingLlmOutput,
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

/** Provider-independent empty-answer explanation; keep existing Japanese messages. */
function emptyResponseUserMessage(finish: LlmFinish): string {
	if (finish.reason === "length")
		return "思考が長くなりすぎて回答を生成できませんでした。質問を短く区切って再度お試しください。";
	if (finish.reason === "blocked")
		return "安全性フィルタにより回答できませんでした。";
	return "AIから有効な応答が得られませんでした。";
}

/** Decode completed steps written by the previous deployment on Workflow replay. */
export function normalizeStreamingOutput(
	result: StreamingLlmOutput,
): StreamingLlmOutput {
	return {
		...result,
		updatedHistory: normalizeHistory(result.updatedHistory),
		usage: normalizeSavedUsage(result.usage),
		thinkingSummaryUsage: normalizeSavedUsage(result.thinkingSummaryUsage),
	};
}

// Step 1: Get sheet data from KV cache or Google Sheets
export async function getSheetDataStep(
	env: Bindings,
	log: Logger,
): Promise<SheetDataOutput> {
	const config = loadConfig(env);
	const cache = createSheetCacheRepository(env.sushanshan_bot, log);

	const cachedData = await cache.get(config.spreadsheet);
	if (cachedData) {
		log.info("Sheet data loaded from cache");
		return {
			sheetInfo: cachedData.sheetInfo,
			description: cachedData.description,
			fromCache: true,
		};
	}

	log.info("Fetching sheet data from Google Sheets");
	const data = await getSheetData(
		config.googleServiceAccount,
		log,
		config.spreadsheet,
	);

	// Save to cache (best effort)
	try {
		await cache.save(config.spreadsheet, data.sheetInfo, data.description);
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
	conversationKey: string | undefined,
	log: Logger,
): Promise<HistoryOutput> {
	if (!conversationKey) {
		log.warn("Conversation key missing, skipping history read");
		return { history: [] };
	}

	const config = loadConfig(env);
	const historyRepository = createConversationHistoryRepository(
		env.sushanshan_bot,
		config.historyTtlSeconds,
		log,
	);
	const history = await historyRepository.get(conversationKey);
	log.info("History loaded", { historyLength: history.length });
	return { history };
}

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	conversationKey: string | undefined,
	history: HistoryEntry[],
	log: Logger,
): Promise<SaveHistoryOutput> {
	if (!conversationKey) {
		log.warn("Conversation key missing, skipping history save");
		return { success: false };
	}

	try {
		const config = loadConfig(env);
		const historyRepository = createConversationHistoryRepository(
			env.sushanshan_bot,
			config.historyTtlSeconds,
			log,
		);
		await historyRepository.save(conversationKey, history);
		log.info("History saved", { historyLength: history.length });
		return { success: true };
	} catch (error) {
		log.warn("Failed to save history (non-fatal)", {
			error: getErrorMessage(error),
		});
		return { success: false };
	}
}

// Step 3+5 combined: Stream LLM response + progressively edit Discord message
export async function streamLlmWithDiscordEditsStep(
	env: Bindings,
	token: string,
	question: string,
	message: string,
	sheetData: SheetDataOutput,
	historyOutput: HistoryOutput,
	log: Logger,
	config: AppConfig = loadConfig(env),
): Promise<StreamingLlmOutput> {
	const discord = createDiscordWebhookClient(
		config.discordApplicationId,
		token,
		log,
	);
	const delivery = createDiscordDeliveryService(discord, log);
	const gateway = createLlmGateway(config.llm.answer, log);
	const summarySelection = gateway.capabilities.reasoningSummary
		? config.llm.summary
		: null;
	const summaryGateway = summarySelection
		? summarySelection.provider === config.llm.answer.provider
			? gateway
			: createLlmGateway(summarySelection, log)
		: null;
	const summarizer =
		summarySelection && summaryGateway
			? createThinkingSummarizer(summaryGateway, summarySelection.model, log)
			: null;
	const coordinator = new StreamCoordinator();
	const prompt = buildAnswerPrompt({
		description: sheetData.description,
		knowledge: sheetData.sheetInfo,
		history: normalizeHistory(historyOutput.history),
		question: message,
	});

	let editCount = 0;
	let retryCount = 0;
	let deliveryDurationMs = 0;
	let thinkingSummary = "";
	let summarizedThinkingLength = 0;
	let thinkingSummaryUsage = zeroUsage();
	let thinkingSummaryCallCount = 0;
	let thinkingSummarySuccessCount = 0;
	let thinkingSummaryDurationMs = 0;

	if (!summarizer) {
		const started = Date.now();
		const preview = await delivery.deliverPreview(
			formatThinking(question, THINKING_FALLBACK),
		);
		deliveryDurationMs += Date.now() - started;
		editCount += preview.editCount;
		retryCount += preview.retryCount;
	}
	log.info("Starting LLM streaming with Discord edits", {
		provider: config.llm.answer.provider,
		model: config.llm.answer.model,
	});
	for await (const event of gateway.generateStream({
		model: config.llm.answer.model,
		prompt,
		includeReasoningSummary: summarizer !== null,
	})) {
		if (event.type === "reasoning_summary" && !summarizer) continue;
		const decision = coordinator.handle(event, Date.now());
		if (!decision) {
			continue;
		}

		let content: string;
		if (decision.phase === "thinking") {
			if (!summarizer) continue;
			const summaryStartTime = Date.now();
			const summaryResult = await summarizer.summarize(
				thinkingSummary,
				decision.text.slice(summarizedThinkingLength),
			);
			thinkingSummaryDurationMs += Date.now() - summaryStartTime;
			thinkingSummaryCallCount++;
			thinkingSummaryUsage = addLlmUsage(
				thinkingSummaryUsage,
				summaryResult.usage,
			);
			if (summaryResult.success) {
				thinkingSummary = summaryResult.text;
				summarizedThinkingLength = decision.textLength;
				thinkingSummarySuccessCount++;
			}
			content = formatThinking(question, summaryResult.text);
		} else {
			content = formatAnswer(question, decision.text);
		}
		const deliveryStartTime = Date.now();
		const result = await delivery.deliverPreview(content);
		deliveryDurationMs += Date.now() - deliveryStartTime;
		editCount += result.editCount;
		retryCount += result.retryCount;

		if (result.success) {
			coordinator.markDelivered(decision);
			log.debug("Discord message edited", {
				editCount,
				phase: decision.phase,
				contentLength: decision.textLength,
			});
		} else {
			log.warn("Intermediate Discord edit failed (non-fatal)", {
				deliveryStatus: result.status,
				failedChunks: result.failedChunks,
				statusCode: result.statusCode,
			});
		}
	}

	const streamResult = coordinator.getResult();
	const rawResponse = streamResult.response;
	if (!rawResponse.trim()) {
		const { finish } = streamResult;
		log.error("LLM returned an empty answer", {
			provider: config.llm.answer.provider,
			finish,
			thinkingLength: streamResult.thinking.length,
			reasoningTokens: streamResult.usage?.reasoningTokens,
		});
		throw new ExternalServiceError({
			service: "llm",
			provider: config.llm.answer.provider,
			operation: "validate streamed response",
			retryable: false,
			userMessage: emptyResponseUserMessage(finish),
		});
	}
	if (
		streamResult.finish.reason === "blocked" ||
		streamResult.finish.reason === "error"
	) {
		throw new ExternalServiceError({
			service: "llm",
			provider: config.llm.answer.provider,
			operation: "validate streamed response",
			retryable: false,
			userMessage: emptyResponseUserMessage(streamResult.finish),
		});
	}
	const response = normalizeDiscordText(rawResponse);
	const finalResponse =
		streamResult.finish.reason === "length"
			? `${response}\n\n（回答が出力上限に達しました。続きが必要な場合は質問を分けてください。）`
			: response;

	const finalDeliveryStartTime = Date.now();
	const finalDelivery = await delivery.deliverFinal(
		response.length === 0 ? "" : formatAnswer(question, finalResponse),
	);
	deliveryDurationMs += Date.now() - finalDeliveryStartTime;
	editCount += finalDelivery.editCount;
	retryCount += finalDelivery.retryCount;

	log.info("Final Discord delivery completed", {
		editCount,
		chunkCount: finalDelivery.chunkCount,
		deliveryStatus: finalDelivery.status,
		failedChunks: finalDelivery.failedChunks,
		responseLength: response.length,
	});

	return {
		response,
		updatedHistory: [
			...normalizeHistory(historyOutput.history),
			{ role: "user", text: `質問: ${message}` },
			{ role: "assistant", text: response },
		],
		usage: streamResult.usage,
		thinkingSummaryUsage:
			thinkingSummaryCallCount > 0 ? thinkingSummaryUsage : null,
		thinkingSummaryCallCount,
		thinkingSummarySuccessCount,
		thinkingSummaryDurationMs,
		editCount,
		chunkCount: finalDelivery.chunkCount,
		deliveryStatus: finalDelivery.status,
		failedChunks: finalDelivery.failedChunks,
		retryCount,
		statusCode: finalDelivery.statusCode,
		deliveryDurationMs,
	};
}

/** Compatibility export; persisted step names also remain unchanged. */
export const streamGeminiWithDiscordEditsStep = streamLlmWithDiscordEditsStep;

// Step 5: Send response to Discord webhook (used for error messages)
export async function sendDiscordResponseStep(
	env: Bindings,
	token: string,
	question: string,
	response: string | null,
	log: Logger,
	errorMessage?: string,
): Promise<DiscordResponseOutput> {
	const config = loadConfig(env);
	const discord = createDiscordWebhookClient(
		config.discordApplicationId,
		token,
		log,
	);
	const delivery = createDiscordDeliveryService(discord, log);

	const content = errorMessage
		? formatError(question, errorMessage)
		: formatAnswer(question, response ?? "");

	const result = await delivery.deliverFollowup(content);
	return {
		success: result.success,
		statusCode: result.statusCode,
		retryCount: result.retryCount,
		editCount: result.editCount,
		chunkCount: result.chunkCount,
		deliveryStatus: result.status,
		failedChunks: result.failedChunks,
	};
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
		const config = loadConfig(env);
		if (!config.githubToken) {
			log.debug("GITHUB_TOKEN not set, skipping error report");
			return;
		}

		const github = createGitHubIssueClient(
			config.githubToken,
			log,
			config.githubRepository,
		);
		const fingerprint = github.generateFingerprint(report.errorMessage);
		const kvKey = `error_reported:${fingerprint}`;
		const deduplicationStore = createDeduplicationStore(env.sushanshan_bot);

		// Layer 1: KV deduplication
		if (await deduplicationStore.isMarked(kvKey)) {
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
			await deduplicationStore.mark(kvKey, ERROR_REPORTED_TTL_SECONDS);
			return;
		}

		// Create the issue
		await github.createIssue(report, fingerprint);
		await deduplicationStore.mark(kvKey, ERROR_REPORTED_TTL_SECONDS);
		log.info("Error reported to GitHub Issues", { fingerprint });
	} catch (error) {
		log.warn("Failed to report error to GitHub (non-fatal)", {
			...getExternalErrorLogContext(error),
		});
	}
}

// Workflow class
export class AnswerQuestionWorkflow extends WorkflowEntrypoint<
	Bindings,
	WorkflowParams
> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { token, message, requestId, conversationKey } = event.payload;
		const log = logger.withContext({ requestId, workflowId: event.instanceId });
		const metrics = getMetricsClient(this.env, log);
		const config = loadConfig(this.env);

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
					conversationKey,
					log.withContext({ step: "getHistory" }),
				);
			});
			stepCount++;

			// Step 3: Stream the selected LLM and progressively edit Discord.
			// Keep the persisted Gemini-era step ID to avoid replaying completed calls.
			const llmStartTime = Date.now();
			let llmSuccess = false;
			let llmUsage: StreamingLlmOutput["usage"] = null;
			let streamResult: StreamingLlmOutput;
			try {
				streamResult = await step.do(
					"streamGeminiAndEditDiscord",
					{
						retries: {
							limit: 0,
							delay: "1 second",
							backoff: "exponential",
						},
						timeout: "120 seconds",
					},
					async () => {
						return streamLlmWithDiscordEditsStep(
							this.env,
							token,
							message,
							message,
							sheetData,
							historyOutput,
							log.withContext({ step: "streamGeminiAndEditDiscord" }),
							config,
						);
					},
				);
				streamResult = normalizeStreamingOutput(streamResult);
				llmUsage = streamResult.usage;
				llmSuccess = true;
				stepCount++;
			} finally {
				metrics.recordLlmCall({
					requestId,
					success: llmSuccess,
					durationMs: Date.now() - llmStartTime,
					usage: llmUsage,
					provider: config.llm.answer.provider,
					model: config.llm.answer.model,
					purpose: "answer",
					callCount: 1,
				});
			}

			if (streamResult.thinkingSummaryCallCount > 0 && config.llm.summary) {
				metrics.recordLlmCall({
					requestId,
					success:
						streamResult.thinkingSummarySuccessCount ===
						streamResult.thinkingSummaryCallCount,
					durationMs: streamResult.thinkingSummaryDurationMs,
					usage: streamResult.thinkingSummaryUsage,
					provider: config.llm.summary.provider,
					model: config.llm.summary.model,
					purpose: "thinking_summary",
					callCount: streamResult.thinkingSummaryCallCount,
				});
			}

			metrics.recordDiscordWebhook({
				requestId,
				success: streamResult.deliveryStatus === "success",
				durationMs: streamResult.deliveryDurationMs,
				retryCount: streamResult.retryCount,
				statusCode: streamResult.statusCode,
				editCount: streamResult.editCount,
				chunkCount: streamResult.chunkCount,
				deliveryStatus: streamResult.deliveryStatus,
			});

			// Step 4: Save history
			await step.do("saveHistory", async () => {
				return saveHistoryStep(
					this.env,
					conversationKey,
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
			const userMessage = getUserMessage(error);
			const failureDurationMs = Date.now() - workflowStartTime;
			log.error("Workflow error", {
				...getExternalErrorLogContext(error),
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
						userMessage,
					);
				},
			);

			metrics.recordDiscordWebhook({
				requestId,
				success: discordErrorResult.success,
				durationMs: Date.now() - discordErrorStartTime,
				retryCount: discordErrorResult.retryCount,
				statusCode: discordErrorResult.statusCode,
				editCount: discordErrorResult.editCount,
				chunkCount: discordErrorResult.chunkCount,
				deliveryStatus: discordErrorResult.deliveryStatus,
			});
		}
	}
}
