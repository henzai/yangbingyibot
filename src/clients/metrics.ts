import type { DeliveryStatus } from "../discord/delivery";
import type { GeminiUsage } from "../gemini/types";
import type { LlmUsage } from "../llm/types";
import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const ANALYTICS_INDEX_MAX_BYTES = 96;

function toAnalyticsIndex(value: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= ANALYTICS_INDEX_MAX_BYTES)
		return value;
	let result = "";
	for (const character of value) {
		if (
			encoder.encode(result + character).byteLength > ANALYTICS_INDEX_MAX_BYTES
		)
			break;
		result += character;
	}
	return result;
}

/**
 * Metric event types for categorizing data points
 */
export type MetricEventType =
	| "gemini_api_call"
	| "llm_api_call_v2"
	| "workflow_complete"
	| "kv_cache_access"
	| "discord_webhook"
	| "sheets_api_call"
	| "health_check";

/**
 * Base interface for all metric data
 */
export interface MetricData {
	requestId: string;
	success: boolean;
	durationMs: number;
}

/**
 * Gemini API specific metrics
 */
export interface GeminiMetricData extends MetricData {
	retryCount?: number;
	usage?: GeminiUsage | null;
	model?: string;
	purpose?: "answer" | "thinking_summary";
	callCount?: number;
}

export interface LlmMetricData
	extends Omit<
		GeminiMetricData,
		"usage" | "purpose" | "retryCount" | "callCount"
	> {
	provider: string;
	purpose: "answer" | "summary";
	usage?: LlmUsage | null;
	/** null means unavailable; it is encoded as -1, never as zero. */
	retryCount?: number | null;
	callCount: number;
	/** Time to the first answer text delta. Not applicable to summary calls. */
	firstTextDurationMs?: number | null;
}

/**
 * KV cache specific metrics
 */
export interface KVCacheMetricData extends MetricData {
	cacheHit: boolean;
	operation: "get" | "put";
}

/**
 * Discord webhook specific metrics
 */
export interface DiscordWebhookMetricData extends MetricData {
	retryCount: number;
	statusCode?: number;
	editCount?: number;
	chunkCount?: number;
	deliveryStatus?: DeliveryStatus;
}

/**
 * Workflow completion metrics
 */
export interface WorkflowMetricData extends MetricData {
	workflowId: string;
	stepCount: number;
	fromCache: boolean;
}

/**
 * Health check specific metrics
 */
export interface HealthCheckMetricData {
	checkName: string;
	success: boolean;
	durationMs: number;
	status?: "healthy" | "unhealthy" | "unverified";
	provider?: string;
	model?: string;
	purposes?: string[];
	errorKind?: string;
	probeScope?: string;
	generationSupport?: string;
}

/**
 * Interface for MetricsClient to enable testing with mocks
 */
export interface IMetricsClient {
	recordLlmCall(data: LlmMetricData): void;
	recordGeminiCall(data: GeminiMetricData): void;
	recordWorkflowComplete(data: WorkflowMetricData): void;
	recordKVCacheAccess(data: KVCacheMetricData): void;
	recordDiscordWebhook(data: DiscordWebhookMetricData): void;
	recordSheetsApiCall(data: MetricData): void;
	recordHealthCheck(data: HealthCheckMetricData): void;
}

/**
 * MetricsClient for recording metrics to Cloudflare Analytics Engine
 *
 * Data point structure:
 * - indexes: [requestId] (max 96 bytes, for efficient queries)
 * - blobs: [eventType, requestId, model, purpose, ...additional context]
 * - doubles: [durationMs, success (1/0), ...additional metrics]
 */
export class MetricsClient implements IMetricsClient {
	private dataset: AnalyticsEngineDataset;
	private log: Logger;

	constructor(dataset: AnalyticsEngineDataset, log?: Logger) {
		this.dataset = dataset;
		this.log = log ?? defaultLogger;
	}

	/**
	 * Common schema v2. Gemini is also dual-written to the legacy event so
	 * existing dashboards keep working during migration.
	 */
	recordLlmCall(data: LlmMetricData): void {
		const usage = data.usage;
		this.writeDataPoint("llm_api_call_v2", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [
				data.requestId,
				data.provider,
				data.model ?? "unknown",
				data.purpose,
			],
			doubles: [
				data.durationMs,
				data.success ? 1 : 0,
				data.callCount,
				data.retryCount ?? -1,
				data.firstTextDurationMs ?? -1,
				usage?.inputTokens ?? -1,
				usage?.cachedInputTokens ?? -1,
				usage?.outputTokens ?? -1,
				usage?.reasoningTokens ?? -1,
				usage?.totalTokens ?? -1,
			],
		});
		if (data.provider === "gemini") {
			this.recordGeminiCall({
				...data,
				purpose: data.purpose === "summary" ? "thinking_summary" : "answer",
				retryCount: data.retryCount ?? undefined,
				usage: usage && {
					promptTokens: usage.inputTokens ?? 0,
					cachedTokens: usage.cachedInputTokens ?? 0,
					thoughtsTokens: usage.reasoningTokens ?? 0,
					candidatesTokens: usage.outputTokens ?? 0,
					totalTokens: usage.totalTokens ?? 0,
				},
			});
		}
	}

	/**
	 * Record Gemini API call metrics
	 * doubles: [durationMs, success, retryCount, promptTokens, cachedTokens,
	 *   thoughtsTokens, candidatesTokens, totalTokens, callCount]
	 */
	recordGeminiCall(data: GeminiMetricData): void {
		const usage = data.usage;
		this.writeDataPoint("gemini_api_call", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [
				data.requestId,
				data.model ?? "unknown",
				data.purpose ?? "answer",
			],
			doubles: [
				data.durationMs,
				data.success ? 1 : 0,
				data.retryCount ?? 0,
				usage?.promptTokens ?? 0,
				usage?.cachedTokens ?? 0,
				usage?.thoughtsTokens ?? 0,
				usage?.candidatesTokens ?? 0,
				usage?.totalTokens ?? 0,
				data.callCount ?? 1,
			],
		});
	}

	/**
	 * Record workflow completion metrics
	 * doubles: [durationMs, success, stepCount, fromCache]
	 */
	recordWorkflowComplete(data: WorkflowMetricData): void {
		this.writeDataPoint("workflow_complete", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [data.requestId, data.workflowId],
			doubles: [
				data.durationMs,
				data.success ? 1 : 0,
				data.stepCount,
				data.fromCache ? 1 : 0,
			],
		});
	}

	/**
	 * Record KV cache access metrics
	 * doubles: [durationMs, success, cacheHit]
	 */
	recordKVCacheAccess(data: KVCacheMetricData): void {
		this.writeDataPoint("kv_cache_access", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [data.requestId, data.operation],
			doubles: [data.durationMs, data.success ? 1 : 0, data.cacheHit ? 1 : 0],
		});
	}

	/**
	 * Record Discord webhook metrics
	 * doubles: [durationMs, success, retryCount, statusCode, editCount, chunkCount]
	 */
	recordDiscordWebhook(data: DiscordWebhookMetricData): void {
		this.writeDataPoint("discord_webhook", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [data.requestId, data.deliveryStatus ?? "unknown"],
			doubles: [
				data.durationMs,
				data.success ? 1 : 0,
				data.retryCount,
				data.statusCode ?? 0,
				data.editCount ?? 0,
				data.chunkCount ?? 0,
			],
		});
	}

	/**
	 * Record Google Sheets API metrics
	 * doubles: [durationMs, success]
	 */
	recordSheetsApiCall(data: MetricData): void {
		this.writeDataPoint("sheets_api_call", {
			indexes: [toAnalyticsIndex(data.requestId)],
			blobs: [data.requestId],
			doubles: [data.durationMs, data.success ? 1 : 0],
		});
	}

	/**
	 * Record health check metrics
	 * doubles: [durationMs, success]
	 */
	recordHealthCheck(data: HealthCheckMetricData): void {
		this.writeDataPoint("health_check", {
			indexes: [toAnalyticsIndex(data.checkName)],
			blobs: [
				data.checkName,
				data.status ?? (data.success ? "healthy" : "unhealthy"),
				data.provider ?? "",
				data.model ?? "",
				data.purposes?.join("+") ?? "",
				data.errorKind ?? "",
				data.probeScope ?? "",
				data.generationSupport ?? "",
			],
			doubles: [data.durationMs, data.success ? 1 : 0],
		});
	}

	/**
	 * Internal method to write data points to Analytics Engine
	 * Prepends eventType to blobs for filtering in SQL queries
	 * Non-blocking - errors are logged but don't affect main flow
	 */
	private writeDataPoint(
		eventType: MetricEventType,
		dataPoint: { indexes?: string[]; blobs?: string[]; doubles?: number[] },
	): void {
		try {
			const blobsWithType = [eventType, ...(dataPoint.blobs ?? [])];

			this.dataset.writeDataPoint({
				indexes: dataPoint.indexes,
				blobs: blobsWithType,
				doubles: dataPoint.doubles,
			});
		} catch (error) {
			// Log but don't throw - metrics should never break the main flow
			this.log.warn("Failed to write metric data point", {
				eventType,
				error: getErrorMessage(error),
			});
		}
	}
}

/**
 * No-op implementation for testing or when metrics are disabled
 */
export class NoOpMetricsClient implements IMetricsClient {
	recordLlmCall(_data: LlmMetricData): void {}
	recordGeminiCall(_data: GeminiMetricData): void {}
	recordWorkflowComplete(_data: WorkflowMetricData): void {}
	recordKVCacheAccess(_data: KVCacheMetricData): void {}
	recordDiscordWebhook(_data: DiscordWebhookMetricData): void {}
	recordSheetsApiCall(_data: MetricData): void {}
	recordHealthCheck(_data: HealthCheckMetricData): void {}
}

/**
 * Factory function following existing client creation patterns
 */
export function createMetricsClient(
	dataset: AnalyticsEngineDataset,
	log?: Logger,
): MetricsClient {
	return new MetricsClient(dataset, log);
}
