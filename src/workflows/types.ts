// Workflow event payload
export interface WorkflowParams {
	// Discord interaction token for webhook response
	token: string;
	// User's question message
	message: string;
}

// Step outputs (must be JSON serializable)
export interface SheetDataOutput {
	sheetInfo: string;
	description: string;
	fromCache: boolean;
}

export interface HistoryOutput {
	history: { role: string; text: string }[];
}

export interface GeminiOutput {
	response: string;
	updatedHistory: { role: string; text: string }[];
}

export interface SaveHistoryOutput {
	success: boolean;
}

export interface DiscordResponseOutput {
	success: boolean;
	statusCode?: number;
}
