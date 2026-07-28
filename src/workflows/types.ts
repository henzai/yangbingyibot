import type { HistoryEntry } from "../contracts";

export type { WorkflowParams } from "../contracts";

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
