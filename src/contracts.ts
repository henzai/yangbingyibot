import type { LlmMessage } from "./llm/types";

export type HistoryEntry = LlmMessage;

export type ParsedDiscordAskCommand = {
	token: string;
	question: string;
	includeFacePhotos: boolean;
	conversationKey: string;
};

// Workflow event payload shared by the Worker boundary and Workflow entrypoint.
export interface WorkflowParams {
	token: string;
	message: string;
	requestId: string;
	conversationKey: string;
	/** Absent on instances created before the `photo` option existed. */
	includeFacePhotos?: boolean;
	/**
	 * Epoch ms when the Worker accepted the interaction, for latency metrics.
	 * Absent on instances created before this field existed.
	 */
	receivedAt?: number;
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
	GEMINI_API_KEY?: string;
	OPENAI_API_KEY?: string;
	GOOGLE_SERVICE_ACCOUNT: string;
	sushanshan_bot: KVNamespace;
	ANSWER_QUESTION_WORKFLOW: Workflow<WorkflowParams>;
	METRICS?: AnalyticsEngineDataset;
	GITHUB_TOKEN?: string;
	GEMINI_MODEL?: string;
	GEMINI_SUMMARY_MODEL?: string;
	LLM_PROVIDER?: string;
	LLM_MODEL?: string;
	LLM_SUMMARY_ENABLED?: string;
	LLM_SUMMARY_PROVIDER?: string;
	LLM_SUMMARY_MODEL?: string;
	GOOGLE_SPREADSHEET_ID?: string;
	GOOGLE_DATA_SHEET_NAME?: string;
	GOOGLE_DESCRIPTION_SHEET_NAME?: string;
	GITHUB_REPOSITORY?: string;
	HISTORY_TTL_SECONDS?: string;
};
