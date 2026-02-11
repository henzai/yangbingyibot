import type { HistoryEntry } from "../types";

// Workflow event payload
export interface WorkflowParams {
	// Discord interaction token for webhook response
	token: string;
	// User's question message
	message: string;
	// Request ID for distributed tracing
	requestId: string;
}

// Step outputs (must be JSON serializable)
export interface SheetDataOutput {
	sheetInfo: string;
	description: string;
	fromCache: boolean;
}

export interface HistoryOutput {
	history: HistoryEntry[];
}

export interface StreamingGeminiOutput {
	response: string;
	updatedHistory: HistoryEntry[];
	editCount: number;
}

export interface SaveHistoryOutput {
	success: boolean;
}

export interface DiscordResponseOutput {
	success: boolean;
	statusCode?: number;
	retryCount: number;
}
