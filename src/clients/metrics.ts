import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

/**
 * Metric event types for categorizing data points
 */
export type MetricEventType =
	| "gemini_api_call"
	| "workflow_complete"
	| "kv_cache_access"
	| "discord_webhook"
	| "sheets_api_call";

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
 * Interface for MetricsClient to enable testing with mocks
 */
export interface IMetricsClient {
	recordGeminiCall(data: GeminiMetricData): void;
	recordWorkflowComplete(data: WorkflowMetricData): void;
	recordKVCacheAccess(data: KVCacheMetricData): void;
	recordDiscordWebhook(data: DiscordWebhookMetricData): void;
	recordSheetsApiCall(data: MetricData): void;
}

/**
 * MetricsClient for recording metrics to Cloudflare Analytics Engine
 *
 * Data point structure:
 * - indexes: [requestId] (max 96 bytes, for efficient queries)
 * - blobs: [eventType, requestId, ...additional context]
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
	 * Record Gemini API call metrics
	 * doubles: [durationMs, success, retryCount]
	 */
	recordGeminiCall(data: GeminiMetricData): void {
		this.writeDataPoint("gemini_api_call", {
			indexes: [data.requestId.substring(0, 96)],
			blobs: [data.requestId],
			doubles: [data.durationMs, data.success ? 1 : 0, data.retryCount ?? 0],
		});
	}

	/**
	 * Record workflow completion metrics
	 * doubles: [durationMs, success, stepCount, fromCache]
	 */
	recordWorkflowComplete(data: WorkflowMetricData): void {
		this.writeDataPoint("workflow_complete", {
			indexes: [data.requestId.substring(0, 96)],
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
			indexes: [data.requestId.substring(0, 96)],
			blobs: [data.requestId, data.operation],
			doubles: [data.durationMs, data.success ? 1 : 0, data.cacheHit ? 1 : 0],
		});
	}

	/**
	 * Record Discord webhook metrics
	 * doubles: [durationMs, success, retryCount, statusCode]
	 */
	recordDiscordWebhook(data: DiscordWebhookMetricData): void {
		this.writeDataPoint("discord_webhook", {
			indexes: [data.requestId.substring(0, 96)],
			blobs: [data.requestId],
			doubles: [
				data.durationMs,
				data.success ? 1 : 0,
				data.retryCount,
				data.statusCode ?? 0,
			],
		});
	}

	/**
	 * Record Google Sheets API metrics
	 * doubles: [durationMs, success]
	 */
	recordSheetsApiCall(data: MetricData): void {
		this.writeDataPoint("sheets_api_call", {
			indexes: [data.requestId.substring(0, 96)],
			blobs: [data.requestId],
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
	recordGeminiCall(_data: GeminiMetricData): void {}
	recordWorkflowComplete(_data: WorkflowMetricData): void {}
	recordKVCacheAccess(_data: KVCacheMetricData): void {}
	recordDiscordWebhook(_data: DiscordWebhookMetricData): void {}
	recordSheetsApiCall(_data: MetricData): void {}
}

/**
 * Factory function following existing patterns (createKV, createGeminiClient)
 */
export function createMetricsClient(
	dataset: AnalyticsEngineDataset,
	log?: Logger,
): MetricsClient {
	return new MetricsClient(dataset, log);
}
