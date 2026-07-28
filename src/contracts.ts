export type HistoryEntry = {
	role: "user" | "model";
	text: string;
};

export type ParsedDiscordAskCommand = {
	token: string;
	question: string;
	conversationKey: string;
};

// Workflow event payload shared by the Worker boundary and Workflow entrypoint.
export interface WorkflowParams {
	token: string;
	message: string;
	requestId: string;
	conversationKey: string;
}

/**
 * Cloudflare bindings and optional runtime configuration.
 *
 * This module is deliberately dependency-free so clients and Workflows can share
 * contracts without importing each other.
 */
export type Bindings = {
	DISCORD_TOKEN: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_APPLICATION_ID: string;
	GEMINI_API_KEY: string;
	GOOGLE_SERVICE_ACCOUNT: string;
	sushanshan_bot: KVNamespace;
	ANSWER_QUESTION_WORKFLOW: Workflow<WorkflowParams>;
	METRICS?: AnalyticsEngineDataset;
	GITHUB_TOKEN?: string;
	GEMINI_MODEL?: string;
	GEMINI_SUMMARY_MODEL?: string;
	GOOGLE_SPREADSHEET_ID?: string;
	GOOGLE_DATA_SHEET_NAME?: string;
	GOOGLE_DESCRIPTION_SHEET_NAME?: string;
	GITHUB_REPOSITORY?: string;
	HISTORY_TTL_SECONDS?: string;
};
