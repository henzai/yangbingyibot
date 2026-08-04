import type { Bindings } from "./contracts";

const HISTORY_TTL_MIN_SECONDS = 60;
const HISTORY_TTL_MAX_SECONDS = 86_400;

export const DEFAULT_RUNTIME_CONFIG = {
	geminiModel: "gemini-3.5-flash-lite",
	geminiSummaryModel: "gemini-2.5-flash-lite",
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
	geminiApiKey: string;
	googleServiceAccount: string;
	githubToken?: string;
	geminiModel: string;
	geminiSummaryModel: string;
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

export function loadConfig(env: Bindings): AppConfig {
	return {
		discordToken: requiredString(env, "DISCORD_TOKEN"),
		discordPublicKey: requiredString(env, "DISCORD_PUBLIC_KEY"),
		discordApplicationId: requiredString(env, "DISCORD_APPLICATION_ID"),
		geminiApiKey: requiredString(env, "GEMINI_API_KEY"),
		googleServiceAccount: requiredString(env, "GOOGLE_SERVICE_ACCOUNT"),
		githubToken: optionalString(env, "GITHUB_TOKEN"),
		geminiModel:
			optionalString(env, "GEMINI_MODEL", DEFAULT_RUNTIME_CONFIG.geminiModel) ??
			DEFAULT_RUNTIME_CONFIG.geminiModel,
		geminiSummaryModel:
			optionalString(
				env,
				"GEMINI_SUMMARY_MODEL",
				DEFAULT_RUNTIME_CONFIG.geminiSummaryModel,
			) ?? DEFAULT_RUNTIME_CONFIG.geminiSummaryModel,
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
