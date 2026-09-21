import type { HistoryEntry } from "../contracts";
import type { DeliveryStatus } from "../discord/delivery";
import type { LlmUsage } from "../llm/types";

export type { WorkflowParams } from "../contracts";

// Step outputs (must be JSON serializable)
export interface SheetDataOutput {
	sheetInfo: string;
	description: string;
	fromCache: boolean;
	/** Missing on checkpoints created before Sheets refresh telemetry was added. */
	sheetsApiCall?: {
		success: boolean;
		durationMs: number;
	};
}

export interface HistoryOutput {
	history: HistoryEntry[];
}

export interface StreamingLlmOutput {
	response: string;
	updatedHistory: HistoryEntry[];
	usage: LlmUsage | null;
	thinkingSummaryUsage: LlmUsage | null;
	thinkingSummaryCallCount: number;
	thinkingSummarySuccessCount: number;
	thinkingSummaryDurationMs: number;
	/** Missing on checkpoints created before metrics schema v2. */
	thinkingSummaryRetryCount?: number | null;
	answerDurationMs?: number | null;
	answerFirstTextDurationMs?: number | null;
	answerRetryCount?: number | null;
	editCount: number;
	chunkCount: number;
	deliveryStatus: DeliveryStatus;
	failedChunks: number[];
	retryCount: number;
	statusCode?: number;
	deliveryDurationMs: number;
}

export interface SaveHistoryOutput {
	success: boolean;
}

export interface DiscordResponseOutput {
	success: boolean;
	statusCode?: number;
	retryCount: number;
	editCount: number;
	chunkCount: number;
	deliveryStatus: DeliveryStatus;
	failedChunks: number[];
}
