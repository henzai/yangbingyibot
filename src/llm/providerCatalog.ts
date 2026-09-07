/** Configuration metadata only: importing configuration never creates an SDK client. */
export type ProviderDefinition = {
	apiKeySetting: "GEMINI_API_KEY" | "OPENAI_API_KEY";
	defaultModel?: string;
	defaultSummaryModel?: string;
	legacyModelSetting?: "GEMINI_MODEL";
	legacySummaryModelSetting?: "GEMINI_SUMMARY_MODEL";
};

export type ProviderCatalog = Readonly<Record<string, ProviderDefinition>>;

export const PROVIDERS = {
	gemini: {
		apiKeySetting: "GEMINI_API_KEY",
		defaultModel: "gemini-3.5-flash-lite",
		defaultSummaryModel: "gemini-2.5-flash-lite",
		legacyModelSetting: "GEMINI_MODEL",
		legacySummaryModelSetting: "GEMINI_SUMMARY_MODEL",
	},
} as const satisfies ProviderCatalog;

export type LlmSelection = {
	provider: string;
	model: string;
	apiKey: string;
};

export type LlmRoutingConfig = {
	answer: LlmSelection;
	summary: LlmSelection | null;
};
