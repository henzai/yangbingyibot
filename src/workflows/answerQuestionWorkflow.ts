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
import type { LlmFinish, LlmUsage } from "../llm/types";
import { addLlmUsage, normalizeSavedUsage, zeroUsage } from "../llm/usage";
import {
	createConversationHistoryRepository,
	normalizeHistory,
} from "../repositories/conversationHistory";
import { createDeduplicationStore } from "../repositories/deduplicationStore";
import {
	createDeliveredIdRepository,
	mergeDeliveredIds,
} from "../repositories/deliveredIds";
import { createSheetCacheRepository } from "../repositories/sheetCache";
import { SheetSearchEngine } from "../sheets/search/engine";
import {
	type SheetSnapshotRef,
	SheetSnapshotRepository,
} from "../sheets/snapshot";
import { createUnavailableSheetStructure } from "../sheets/structuredSheet";
import {
	ExternalServiceError,
	getErrorMessage,
	getExternalErrorLogContext,
	getUserMessage,
} from "../utils/errors";
import { type Logger, logger } from "../utils/logger";
import {
	SHEET_TOOL_LIMITS,
	SHEET_TOOL_STEP_TIMEOUTS,
} from "./sheetTools/limits";
import {
	captureStepFailure,
	deliverSheetToolAnswerStep,
	prepareSheetToolsStep,
	rethrowStepFailure,
	runSheetToolRound,
	SheetToolBudgetError,
	type SheetToolDeliveryOutput,
	type SheetToolDeps,
	type SheetToolPrepareOutput,
	type SheetToolRoundMetrics,
	type SheetToolRoundOutput,
	type SheetToolStepFailure,
} from "./sheetTools/loop";
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
		thinkingSummaryRetryCount:
			typeof result.thinkingSummaryRetryCount === "number"
				? result.thinkingSummaryRetryCount
				: null,
		answerDurationMs:
			typeof result.answerDurationMs === "number"
				? result.answerDurationMs
				: null,
		answerFirstTextDurationMs:
			typeof result.answerFirstTextDurationMs === "number"
				? result.answerFirstTextDurationMs
				: null,
		answerRetryCount:
			typeof result.answerRetryCount === "number"
				? result.answerRetryCount
				: null,
	};
}

type LlmStepMetricState = {
	answerDurationMs: number | null;
	answerFirstTextDurationMs: number | null;
	answerRetryCount: number | null;
	summaryUsage: LlmUsage | null;
	summaryCallCount: number;
	summarySuccessCount: number;
	summaryDurationMs: number;
	summaryRetryCount: number | null;
};

function createLlmStepMetricState(): LlmStepMetricState {
	return {
		answerDurationMs: null,
		answerFirstTextDurationMs: null,
		answerRetryCount: null,
		summaryUsage: null,
		summaryCallCount: 0,
		summarySuccessCount: 0,
		summaryDurationMs: 0,
		summaryRetryCount: null,
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
	if (cachedData?.structuredSheet !== undefined) {
		log.info("Sheet data loaded from cache");
		return {
			sheetInfo: cachedData.sheetInfo,
			description: cachedData.description,
			fromCache: true,
			...(cachedData.snapshotRef
				? { snapshotRef: cachedData.snapshotRef }
				: {}),
		};
	}

	if (cachedData) {
		log.info("Legacy sheet cache found; refreshing structured snapshot");
		const sheetsApiStartTime = Date.now();
		try {
			const refreshedData = await getSheetData(
				config.googleServiceAccount,
				log,
				config.spreadsheet,
			);
			const sheetsApiDurationMs = Date.now() - sheetsApiStartTime;
			let snapshotRef: SheetSnapshotRef | undefined;
			try {
				snapshotRef = await cache.save(
					config.spreadsheet,
					refreshedData.sheetInfo,
					refreshedData.description,
					refreshedData.structuredSheet,
				);
				log.info("Structured sheet cache refreshed");
			} catch (error) {
				log.warn("Failed to save refreshed cache (non-fatal)", {
					error: getErrorMessage(error),
				});
			}
			return {
				sheetInfo: refreshedData.sheetInfo,
				description: refreshedData.description,
				fromCache: false,
				...(snapshotRef ? { snapshotRef } : {}),
				sheetsApiCall: {
					success: true,
					durationMs: sheetsApiDurationMs,
				},
			};
		} catch (error) {
			const sheetsApiDurationMs = Date.now() - sheetsApiStartTime;
			log.warn("Failed to refresh legacy sheet cache; using legacy TSV", {
				error: getErrorMessage(error),
			});
			try {
				await cache.save(
					config.spreadsheet,
					cachedData.sheetInfo,
					cachedData.description,
					createUnavailableSheetStructure("invalid_snapshot"),
				);
				log.info("Legacy sheet fallback cached after refresh failure");
			} catch (cacheError) {
				log.warn("Failed to cache legacy sheet fallback (non-fatal)", {
					error: getErrorMessage(cacheError),
				});
			}
			return {
				sheetInfo: cachedData.sheetInfo,
				description: cachedData.description,
				fromCache: true,
				sheetsApiCall: {
					success: false,
					durationMs: sheetsApiDurationMs,
				},
			};
		}
	}

	log.info("Fetching sheet data from Google Sheets");
	const sheetsApiStartTime = Date.now();
	const data = await getSheetData(
		config.googleServiceAccount,
		log,
		config.spreadsheet,
	);
	const sheetsApiDurationMs = Date.now() - sheetsApiStartTime;

	// Save to cache (best effort)
	let snapshotRef: SheetSnapshotRef | undefined;
	try {
		snapshotRef = await cache.save(
			config.spreadsheet,
			data.sheetInfo,
			data.description,
			data.structuredSheet,
		);
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
		...(snapshotRef ? { snapshotRef } : {}),
		sheetsApiCall: {
			success: true,
			durationMs: sheetsApiDurationMs,
		},
	};
}

export function recordSheetDataAccessMetrics(
	metrics: IMetricsClient,
	requestId: string,
	sheetData: SheetDataOutput,
	stepDurationMs: number,
): void {
	metrics.recordKVCacheAccess({
		requestId,
		success: true,
		durationMs: stepDurationMs,
		cacheHit: sheetData.fromCache,
		operation: "get",
	});

	// New checkpoints report an attempted refresh separately from the data
	// source. Fall back to the old fromCache behavior for older checkpoints.
	if (sheetData.sheetsApiCall || !sheetData.fromCache) {
		metrics.recordSheetsApiCall({
			requestId,
			success: sheetData.sheetsApiCall?.success ?? true,
			durationMs: sheetData.sheetsApiCall?.durationMs ?? stepDurationMs,
		});
	}
}

// Step 2: Get conversation history from KV
export async function getHistoryStep(
	env: Bindings,
	conversationKey: string | undefined,
	log: Logger,
	includeDeliveredIds = false,
): Promise<HistoryOutput> {
	if (!conversationKey) {
		log.warn("Conversation key missing, skipping history read");
		return includeDeliveredIds
			? { history: [], deliveredIds: [] }
			: { history: [] };
	}

	const config = loadConfig(env);
	const historyRepository = createConversationHistoryRepository(
		env.sushanshan_bot,
		config.historyTtlSeconds,
		log,
	);
	const history = await historyRepository.get(conversationKey);
	log.info("History loaded", { historyLength: history.length });
	if (!includeDeliveredIds) return { history };
	const deliveredIds = await createDeliveredIdRepository(
		env.sushanshan_bot,
		config.historyTtlSeconds,
		log,
	).get(conversationKey);
	return { history, deliveredIds };
}

// Step 4: Save conversation history to KV
export async function saveHistoryStep(
	env: Bindings,
	conversationKey: string | undefined,
	history: HistoryEntry[],
	log: Logger,
	/** Tool path only: the merged set of confirmed delivered member IDs. */
	deliveredIds?: readonly string[],
): Promise<SaveHistoryOutput> {
	if (!conversationKey) {
		log.warn("Conversation key missing, skipping history save");
		return { success: false };
	}

	let success: boolean;
	try {
		const config = loadConfig(env);
		const historyRepository = createConversationHistoryRepository(
			env.sushanshan_bot,
			config.historyTtlSeconds,
			log,
		);
		await historyRepository.save(conversationKey, history);
		log.info("History saved", { historyLength: history.length });
		success = true;
	} catch (error) {
		log.warn("Failed to save history (non-fatal)", {
			error: getErrorMessage(error),
		});
		success = false;
	}
	if (deliveredIds === undefined) return { success };
	try {
		const config = loadConfig(env);
		await createDeliveredIdRepository(
			env.sushanshan_bot,
			config.historyTtlSeconds,
			log,
		).save(conversationKey, deliveredIds);
		log.info("Delivered IDs saved", { deliveredIdCount: deliveredIds.length });
	} catch (error) {
		log.warn("Failed to save delivered IDs (non-fatal)", {
			error: getErrorMessage(error),
		});
	}
	return { success };
}

/** Request-local dependencies for the sheet tool path (LLM_ANSWER_MODE=tools). */
export function createSheetToolDeps(
	env: Bindings,
	config: AppConfig,
	token: string,
	log: Logger,
): SheetToolDeps {
	const repository = new SheetSnapshotRepository(env.sushanshan_bot);
	const gateway = createLlmGateway(config.llm.answer, log);
	if (!gateway.capabilities.tools)
		throw new ExternalServiceError({
			service: "llm",
			provider: config.llm.answer.provider,
			operation: "select sheet tool provider",
			retryable: false,
			userMessage: "回答モデルがシート検索ツールに対応していません。",
		});
	return {
		gateway,
		model: config.llm.answer.model,
		openEngine: async (prepared, { deliveredIds, signal }) => {
			const opened = await SheetSearchEngine.open(
				repository,
				config.spreadsheet,
				prepared.snapshotRef,
				{ questionDate: prepared.questionDate, deliveredIds, signal },
			);
			if (opened.status === "ready") return opened.engine;
			// Never substitute the current mutable cache for the pinned snapshot.
			throw new ExternalServiceError({
				service: "sheets",
				operation: `open pinned sheet snapshot ${opened.reason}`,
				retryable: false,
				userMessage:
					"シートの検索用データを読み込めなかったため、回答を作成できませんでした。",
			});
		},
		delivery: (signal, retryConfig) =>
			createDiscordDeliveryService(
				createDiscordWebhookClient(config.discordApplicationId, token, log, {
					inert: true,
					signal,
				}),
				log,
				retryConfig,
				signal,
			),
		log,
	};
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
	metricState?: LlmStepMetricState,
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
	let thinkingSummaryRetryCount = 0;
	let answerAttemptCount = 0;
	let answerFirstTextDurationMs: number | null = null;

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
	const answerStartTime = Date.now();
	for await (const event of gateway.generateStream({
		model: config.llm.answer.model,
		prompt,
		includeReasoningSummary: summarizer !== null,
		telemetry: {
			onAttempt: () => {
				answerAttemptCount++;
				if (metricState)
					metricState.answerRetryCount = Math.max(0, answerAttemptCount - 1);
			},
			onFirstText: () => {
				answerFirstTextDurationMs ??= Date.now() - answerStartTime;
				if (metricState)
					metricState.answerFirstTextDurationMs = answerFirstTextDurationMs;
			},
		},
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
			thinkingSummaryRetryCount += summaryResult.retryCount ?? 0;
			thinkingSummaryUsage = addLlmUsage(
				thinkingSummaryUsage,
				summaryResult.usage,
			);
			if (metricState) {
				metricState.summaryUsage = thinkingSummaryUsage;
				metricState.summaryCallCount = thinkingSummaryCallCount;
				metricState.summarySuccessCount = thinkingSummarySuccessCount;
				metricState.summaryDurationMs = thinkingSummaryDurationMs;
				metricState.summaryRetryCount = thinkingSummaryRetryCount;
			}
			if (summaryResult.success) {
				thinkingSummary = summaryResult.text;
				summarizedThinkingLength = decision.textLength;
				thinkingSummarySuccessCount++;
				if (metricState)
					metricState.summarySuccessCount = thinkingSummarySuccessCount;
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
	const answerDurationMs = Date.now() - answerStartTime;
	if (metricState) metricState.answerDurationMs = answerDurationMs;
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
		streamResult.finish.reason === "error" ||
		// This path passes no tools; interim tool-round text is never an answer.
		streamResult.finish.reason === "tool_calls"
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
		thinkingSummaryRetryCount,
		answerDurationMs,
		answerFirstTextDurationMs,
		answerRetryCount: Math.max(0, answerAttemptCount - 1),
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

type SheetToolRunContext = {
	token: string;
	message: string;
	requestId: string;
	sheetData: SheetDataOutput;
	historyOutput: HistoryOutput;
	config: AppConfig;
	log: Logger;
	metrics: IMetricsClient;
};

/**
 * Tool path: prepareSheetTools → sheetToolRound1..N → deliverSheetToolAnswer.
 * Each round checkpoints its opaque state and tool results; only the final
 * text is delivered, from its own step, so a retry never regenerates it.
 */
export async function answerWithSheetTools(
	env: Bindings,
	step: WorkflowStep,
	context: SheetToolRunContext,
	onStep: () => void,
): Promise<{ updatedHistory: HistoryEntry[]; deliveredIds: string[] }> {
	const { token, message, requestId, sheetData, config, metrics } = context;
	const log = context.log.withContext({ answerMode: "tools" });
	const history = normalizeHistory(context.historyOutput.history);
	const previousIds = mergeDeliveredIds(
		[],
		context.historyOutput.deliveredIds ?? [],
	);
	const deps = createSheetToolDeps(env, config, token, log);
	const noRetry = {
		limit: 0,
		delay: "1 second",
		backoff: "exponential",
	} as const;
	const questionStart = Date.now();
	let last: SheetToolRoundOutput | null = null;
	// Assigned from callbacks, so keep the declared union for narrowing.
	let failedRound = null as SheetToolRoundMetrics | null;
	let delivery: SheetToolDeliveryOutput | null = null;
	let outcome: "answered" | "budget_exceeded" | "technical_failure" =
		"technical_failure";
	let budgetReason = "";
	const recordRound = (round: SheetToolRoundMetrics, success: boolean) =>
		metrics.recordLlmCall({
			requestId,
			success,
			durationMs: round.durationMs,
			usage: round.usage,
			provider: config.llm.answer.provider,
			model: config.llm.answer.model,
			purpose: "answer_round",
			callCount: 1,
			retryCount: Math.max(0, round.attempts - 1),
			firstTextDurationMs: round.firstTextDurationMs,
		});
	try {
		const prepared = rethrowStepFailure<SheetToolPrepareOutput>(
			await step.do(
				"prepareSheetTools",
				{ retries: noRetry, timeout: SHEET_TOOL_STEP_TIMEOUTS.prepare },
				async () =>
					captureStepFailure(() =>
						prepareSheetToolsStep(deps, sheetData.snapshotRef),
					),
			),
		);
		onStep();
		for (let round = 1; round <= SHEET_TOOL_LIMITS.maxModelRounds; round++) {
			let attempted = null as SheetToolRoundMetrics | null;
			const previous: SheetToolRoundOutput | null = last;
			let output: SheetToolRoundOutput;
			try {
				// LlmToolState.items is opaque JSON (unknown[]), which
				// Rpc.Serializable cannot express; the contract keeps it serializable.
				output = rethrowStepFailure(
					(await step.do(
						`sheetToolRound${round}`,
						{ retries: noRetry, timeout: SHEET_TOOL_STEP_TIMEOUTS.round },
						async (): Promise<never> =>
							(await captureStepFailure(() =>
								runSheetToolRound(
									deps,
									{
										round,
										question: message,
										prepared,
										history,
										deliveredIds: previousIds,
										previous,
									},
									(metrics) => {
										attempted = metrics;
									},
								),
							)) as never,
					)) as SheetToolRoundOutput | SheetToolStepFailure,
				);
				last = output;
			} catch (error) {
				failedRound = attempted;
				if (attempted) recordRound(attempted, false);
				throw error;
			}
			recordRound(output.metrics, true);
			onStep();
			if (output.kind === "final") break;
		}
		const final = last;
		if (final?.kind !== "final") throw new SheetToolBudgetError("model_rounds");
		delivery = rethrowStepFailure<SheetToolDeliveryOutput>(
			await step.do(
				"deliverSheetToolAnswer",
				{ retries: noRetry, timeout: SHEET_TOOL_STEP_TIMEOUTS.deliver },
				async () =>
					captureStepFailure(() =>
						deliverSheetToolAnswerStep(deps, {
							question: message,
							prepared,
							final,
							deliveredIds: previousIds,
						}),
					),
			),
		);
		onStep();
		outcome = "answered";
		return {
			updatedHistory: [
				...history,
				{ role: "user", text: `質問: ${message}` },
				{ role: "assistant", text: delivery.historyText },
			],
			deliveredIds: mergeDeliveredIds(previousIds, delivery.deliveredIds),
		};
	} catch (error) {
		if (error instanceof SheetToolBudgetError) {
			outcome = "budget_exceeded";
			budgetReason = error.reason;
		}
		throw error;
	} finally {
		const totals = last?.totals;
		const rounds = (totals?.rounds ?? 0) + (failedRound ? 1 : 0);
		const attempts = (totals?.attempts ?? 0) + (failedRound?.attempts ?? 0);
		const usage =
			failedRound && totals
				? addLlmUsage(totals.usage, failedRound.usage)
				: (totals?.usage ?? failedRound?.usage ?? null);
		const finalFirstTextMs =
			last?.kind === "final" ? last.finalFirstTextMs : null;
		if (rounds > 0)
			metrics.recordLlmCall({
				requestId,
				success: outcome === "answered",
				durationMs:
					(totals?.modelDurationMs ?? 0) + (failedRound?.durationMs ?? 0),
				usage,
				provider: config.llm.answer.provider,
				model: config.llm.answer.model,
				purpose: "answer",
				callCount: rounds,
				retryCount: Math.max(0, attempts - rounds),
				firstTextDurationMs: finalFirstTextMs,
			});
		const summary = {
			requestId,
			success: outcome === "answered",
			durationMs: Date.now() - questionStart,
			outcome,
			budgetReason,
			rounds,
			toolCalls: totals?.toolCalls ?? 0,
			attempts,
			toolResultBytes: totals?.toolResultBytes ?? 0,
			// Include a failed round: it may have spent tokens before stopping.
			totalTokens:
				(totals?.totalTokens ?? 0) + (failedRound?.usage?.totalTokens ?? 0),
			modelDurationMs:
				(totals?.modelDurationMs ?? 0) + (failedRound?.durationMs ?? 0),
			searchDurationMs: totals?.searchDurationMs ?? 0,
			finalFirstTextMs,
			zeroResults: totals?.outcomes.zero ?? 0,
			ambiguousResults: totals?.outcomes.ambiguous ?? 0,
			missingResults: totals?.outcomes.missing ?? 0,
			toolErrors: totals?.outcomes.error ?? 0,
			attachmentChunks: last?.attachment?.chunkCount ?? 0,
			deliveredIds: delivery?.deliveredIds.length ?? 0,
		};
		metrics.recordSheetTools(summary);
		// Totals only: no question text, rows, arguments or provider state.
		log.info("Sheet tool answer summary", { ...summary, usage });
		if (delivery)
			metrics.recordDiscordWebhook({
				requestId,
				success: delivery.deliveryStatus === "success",
				durationMs: delivery.deliveryDurationMs,
				retryCount: delivery.retryCount,
				statusCode: delivery.statusCode,
				editCount: delivery.editCount,
				chunkCount: delivery.chunkCount,
				deliveryStatus: delivery.deliveryStatus,
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

		const toolMode = event.payload.answerMode === "tools";
		log.info("Workflow started", {
			messageLength: message.length,
			...(toolMode ? { answerMode: "tools" } : {}),
		});
		const workflowStartTime = Date.now();
		let stepCount = 0;
		let fromCache = false;
		const completeSuccessfully = () => {
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
		};

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

			recordSheetDataAccessMetrics(
				metrics,
				requestId,
				sheetData,
				sheetDataDurationMs,
			);

			// Step 2: Get conversation history
			const historyOutput = await step.do("getHistory", async () => {
				return getHistoryStep(
					this.env,
					conversationKey,
					log.withContext({ step: "getHistory" }),
					toolMode,
				);
			});
			stepCount++;

			if (toolMode) {
				const answer = await answerWithSheetTools(
					this.env,
					step,
					{
						token,
						message,
						requestId,
						sheetData,
						historyOutput,
						config,
						log,
						metrics,
					},
					() => {
						stepCount++;
					},
				);
				await step.do("saveHistory", async () => {
					return saveHistoryStep(
						this.env,
						conversationKey,
						answer.updatedHistory,
						log.withContext({ step: "saveHistory" }),
						answer.deliveredIds,
					);
				});
				stepCount++;
				completeSuccessfully();
				return;
			}

			// Step 3: Stream the selected LLM and progressively edit Discord.
			// Keep the persisted Gemini-era step ID to avoid replaying completed calls.
			const llmStartTime = Date.now();
			let llmSuccess = false;
			let llmUsage: StreamingLlmOutput["usage"] = null;
			const llmMetrics = createLlmStepMetricState();
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
							llmMetrics,
						);
					},
				);
				streamResult = normalizeStreamingOutput(streamResult);
				llmUsage = streamResult.usage;
				llmMetrics.answerDurationMs = streamResult.answerDurationMs ?? null;
				llmMetrics.answerFirstTextDurationMs =
					streamResult.answerFirstTextDurationMs ?? null;
				llmMetrics.answerRetryCount = streamResult.answerRetryCount ?? null;
				llmMetrics.summaryUsage = streamResult.thinkingSummaryUsage;
				llmMetrics.summaryCallCount = streamResult.thinkingSummaryCallCount;
				llmMetrics.summarySuccessCount =
					streamResult.thinkingSummarySuccessCount;
				llmMetrics.summaryDurationMs = streamResult.thinkingSummaryDurationMs;
				llmMetrics.summaryRetryCount =
					streamResult.thinkingSummaryRetryCount ?? null;
				llmSuccess = true;
				stepCount++;
			} finally {
				metrics.recordLlmCall({
					requestId,
					success: llmSuccess,
					durationMs: llmMetrics.answerDurationMs ?? Date.now() - llmStartTime,
					usage: llmUsage,
					provider: config.llm.answer.provider,
					model: config.llm.answer.model,
					purpose: "answer",
					callCount: 1,
					retryCount: llmMetrics.answerRetryCount,
					firstTextDurationMs: llmMetrics.answerFirstTextDurationMs,
				});
				if (llmMetrics.summaryCallCount > 0 && config.llm.summary) {
					metrics.recordLlmCall({
						requestId,
						success:
							llmMetrics.summarySuccessCount === llmMetrics.summaryCallCount,
						durationMs: llmMetrics.summaryDurationMs,
						usage: llmMetrics.summaryUsage,
						provider: config.llm.summary.provider,
						model: config.llm.summary.model,
						purpose: "summary",
						callCount: llmMetrics.summaryCallCount,
						retryCount: llmMetrics.summaryRetryCount,
					});
				}
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

			completeSuccessfully();
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
