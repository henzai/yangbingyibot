import type { Bindings } from "./contracts";
import {
	type LlmRoutingConfig,
	type LlmSelection,
	PROVIDERS,
	type ProviderCatalog,
} from "./llm/providerCatalog";

const HISTORY_TTL_MIN_SECONDS = 60;
const HISTORY_TTL_MAX_SECONDS = 86_400;

export const DEFAULT_RUNTIME_CONFIG = {
	geminiModel: PROVIDERS.gemini.defaultModel,
	geminiSummaryModel: PROVIDERS.gemini.defaultSummaryModel,
	spreadsheet: {
		id: "1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg",
		dataSheetName: "test",
		descriptionSheetName: "description",
	},
	githubRepository: {
		owner: "henzai",
		name: "yangbingyibot",
		fullName: "henzai/yangbingyibot",
	},
	historyTtlSeconds: 300,
} as const;

export type SpreadsheetConfig = {
	id: string;
	dataSheetName: string;
	descriptionSheetName: string;
};

export type GitHubRepositoryConfig = {
	owner: string;
	name: string;
	fullName: string;
};

export type AppConfig = {
	discordToken: string;
	discordPublicKey: string;
	discordApplicationId: string;
	llm: LlmRoutingConfig;
	googleServiceAccount: string;
	githubToken?: string;
	spreadsheet: SpreadsheetConfig;
	githubRepository: GitHubRepositoryConfig;
	historyTtlSeconds: number;
};

export class ConfigError extends Error {
	readonly setting: keyof Bindings;

	constructor(setting: keyof Bindings, reason: string) {
		super(`Invalid configuration for ${setting}: ${reason}`);
		this.name = "ConfigError";
		this.setting = setting;
	}
}

function requiredString(
	env: Bindings,
	setting:
		| "DISCORD_TOKEN"
		| "DISCORD_PUBLIC_KEY"
		| "DISCORD_APPLICATION_ID"
		| "GEMINI_API_KEY"
		| "OPENAI_API_KEY"
		| "GOOGLE_SERVICE_ACCOUNT",
): string {
	const value = env[setting];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ConfigError(setting, "a non-empty value is required");
	}
	return value.trim();
}

function optionalString(
	env: Bindings,
	setting:
		| "GITHUB_TOKEN"
		| "GEMINI_MODEL"
		| "GEMINI_SUMMARY_MODEL"
		| "LLM_PROVIDER"
		| "LLM_MODEL"
		| "LLM_SUMMARY_ENABLED"
		| "LLM_SUMMARY_PROVIDER"
		| "LLM_SUMMARY_MODEL"
		| "GOOGLE_SPREADSHEET_ID"
		| "GOOGLE_DATA_SHEET_NAME"
		| "GOOGLE_DESCRIPTION_SHEET_NAME",
	fallback?: string,
): string | undefined {
	const value = env[setting];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ConfigError(setting, "must be a non-empty string when set");
	}
	return value.trim();
}

function parseHistoryTtl(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_RUNTIME_CONFIG.historyTtlSeconds;
	}
	if (!/^\d+$/.test(value.trim())) {
		throw new ConfigError("HISTORY_TTL_SECONDS", "must be an integer");
	}
	const ttl = Number(value);
	if (
		!Number.isSafeInteger(ttl) ||
		ttl < HISTORY_TTL_MIN_SECONDS ||
		ttl > HISTORY_TTL_MAX_SECONDS
	) {
		throw new ConfigError(
			"HISTORY_TTL_SECONDS",
			`must be between ${HISTORY_TTL_MIN_SECONDS} and ${HISTORY_TTL_MAX_SECONDS}`,
		);
	}
	return ttl;
}

function parseGitHubRepository(
	value: string | undefined,
): GitHubRepositoryConfig {
	const fullName =
		value === undefined
			? DEFAULT_RUNTIME_CONFIG.githubRepository.fullName
			: value.trim();
	if (!fullName) {
		throw new ConfigError(
			"GITHUB_REPOSITORY",
			"must be a non-empty owner/repository value when set",
		);
	}
	const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)$/.exec(
		fullName,
	);
	if (!match) {
		throw new ConfigError(
			"GITHUB_REPOSITORY",
			"must use the owner/repository format",
		);
	}
	return {
		owner: match[1],
		name: match[2],
		fullName,
	};
}

function loadLlmConfig(
	env: Bindings,
	catalog: ProviderCatalog,
): LlmRoutingConfig {
	const provider = optionalString(env, "LLM_PROVIDER", "gemini") ?? "gemini";
	const select = (
		provider: string,
		purpose: "answer" | "summary",
	): LlmSelection => {
		const providerSetting =
			purpose === "answer" ? "LLM_PROVIDER" : "LLM_SUMMARY_PROVIDER";
		const modelSetting =
			purpose === "answer" ? "LLM_MODEL" : "LLM_SUMMARY_MODEL";
		if (!Object.hasOwn(catalog, provider))
			throw new ConfigError(
				providerSetting,
				"provider is not supported by this build",
			);
		const definition = catalog[provider];
		const legacySetting =
			purpose === "answer"
				? definition.legacyModelSetting
				: definition.legacySummaryModelSetting;
		const model =
			optionalString(env, modelSetting) ??
			(legacySetting ? optionalString(env, legacySetting) : undefined) ??
			(purpose === "answer"
				? definition.defaultModel
				: definition.defaultSummaryModel);
		if (!model)
			throw new ConfigError(
				modelSetting,
				"an explicit model is required for the selected provider",
			);
		return {
			provider,
			model,
			apiKey: requiredString(env, definition.apiKeySetting),
		};
	};
	const answer = select(provider, "answer");
	const enabled = optionalString(env, "LLM_SUMMARY_ENABLED", "true");
	if (enabled !== "true" && enabled !== "false")
		throw new ConfigError("LLM_SUMMARY_ENABLED", "must be true or false");
	if (enabled === "false") {
		if (
			env.LLM_SUMMARY_PROVIDER !== undefined ||
			env.LLM_SUMMARY_MODEL !== undefined
		) {
			throw new ConfigError(
				"LLM_SUMMARY_ENABLED",
				"summary provider/model must be unset when summaries are disabled",
			);
		}
		return { answer, summary: null };
	}
	const summaryProvider =
		optionalString(env, "LLM_SUMMARY_PROVIDER", provider) ?? provider;
	return { answer, summary: select(summaryProvider, "summary") };
}

export function loadConfig(
	env: Bindings,
	catalog: ProviderCatalog = PROVIDERS,
): AppConfig {
	return {
		discordToken: requiredString(env, "DISCORD_TOKEN"),
		discordPublicKey: requiredString(env, "DISCORD_PUBLIC_KEY"),
		discordApplicationId: requiredString(env, "DISCORD_APPLICATION_ID"),
		llm: loadLlmConfig(env, catalog),
		googleServiceAccount: requiredString(env, "GOOGLE_SERVICE_ACCOUNT"),
		githubToken: optionalString(env, "GITHUB_TOKEN"),
		spreadsheet: {
			id:
				optionalString(
					env,
					"GOOGLE_SPREADSHEET_ID",
					DEFAULT_RUNTIME_CONFIG.spreadsheet.id,
				) ?? DEFAULT_RUNTIME_CONFIG.spreadsheet.id,
			dataSheetName:
				optionalString(
					env,
					"GOOGLE_DATA_SHEET_NAME",
					DEFAULT_RUNTIME_CONFIG.spreadsheet.dataSheetName,
				) ?? DEFAULT_RUNTIME_CONFIG.spreadsheet.dataSheetName,
			descriptionSheetName:
				optionalString(
					env,
					"GOOGLE_DESCRIPTION_SHEET_NAME",
					DEFAULT_RUNTIME_CONFIG.spreadsheet.descriptionSheetName,
				) ?? DEFAULT_RUNTIME_CONFIG.spreadsheet.descriptionSheetName,
		},
		githubRepository: parseGitHubRepository(env.GITHUB_REPOSITORY),
		historyTtlSeconds: parseHistoryTtl(env.HISTORY_TTL_SECONDS),
	};
}
