import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_RUNTIME_CONFIG, loadConfig } from "./config";
import type { Bindings, WorkflowParams } from "./contracts";
import { PROVIDERS } from "./llm/providerCatalog";

function createBindings(overrides: Partial<Bindings> = {}): Bindings {
	return {
		DISCORD_TOKEN: "discord-token",
		DISCORD_PUBLIC_KEY: "discord-public-key",
		DISCORD_APPLICATION_ID: "discord-application-id",
		GEMINI_API_KEY: "gemini-api-key",
		GOOGLE_SERVICE_ACCOUNT: '{"type":"service_account"}',
		sushanshan_bot: {} as KVNamespace,
		ANSWER_QUESTION_WORKFLOW: {} as Workflow<WorkflowParams>,
		...overrides,
	};
}

describe("loadConfig", () => {
	it("uses backward-compatible defaults for optional settings", () => {
		const config = loadConfig(createBindings());

		expect(DEFAULT_RUNTIME_CONFIG.geminiModel).toBe("gemini-3.5-flash-lite");
		expect(config).toMatchObject({
			llm: {
				answer: {
					provider: "gemini",
					model: DEFAULT_RUNTIME_CONFIG.geminiModel,
				},
				summary: {
					provider: "gemini",
					model: DEFAULT_RUNTIME_CONFIG.geminiSummaryModel,
				},
			},
			spreadsheet: DEFAULT_RUNTIME_CONFIG.spreadsheet,
			githubRepository: DEFAULT_RUNTIME_CONFIG.githubRepository,
			historyTtlSeconds: 300,
		});
	});

	it("loads and trims optional overrides", () => {
		const config = loadConfig(
			createBindings({
				GEMINI_MODEL: " answer-model ",
				GEMINI_SUMMARY_MODEL: " summary-model ",
				GOOGLE_SPREADSHEET_ID: " spreadsheet-id ",
				GOOGLE_DATA_SHEET_NAME: " data ",
				GOOGLE_DESCRIPTION_SHEET_NAME: " description ",
				GITHUB_REPOSITORY: " octo-org/bot ",
				HISTORY_TTL_SECONDS: "600",
			}),
		);

		expect(config).toMatchObject({
			llm: {
				answer: { model: "answer-model" },
				summary: { model: "summary-model" },
			},
			spreadsheet: {
				id: "spreadsheet-id",
				dataSheetName: "data",
				descriptionSheetName: "description",
			},
			githubRepository: {
				owner: "octo-org",
				name: "bot",
				fullName: "octo-org/bot",
			},
			historyTtlSeconds: 600,
		});
	});

	it.each([
		["non-numeric TTL", { HISTORY_TTL_SECONDS: "five" }],
		["TTL below minimum", { HISTORY_TTL_SECONDS: "59" }],
		["TTL above maximum", { HISTORY_TTL_SECONDS: "86401" }],
		["invalid repository", { GITHUB_REPOSITORY: "not-a-repository" }],
		["blank repository", { GITHUB_REPOSITORY: "  " }],
		["blank optional value", { GEMINI_MODEL: "  " }],
	] satisfies Array<[string, Partial<Bindings>]>)(
		"rejects %s",
		(_name, overrides) => {
			expect(() => loadConfig(createBindings(overrides))).toThrow(ConfigError);
		},
	);

	it("identifies a missing required setting without exposing secret values", () => {
		const secret = "super-secret-value";
		const env = createBindings({
			GEMINI_API_KEY: " ",
			DISCORD_TOKEN: secret,
		});

		try {
			loadConfig(env);
			throw new Error("expected loadConfig to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as Error).message).toContain("GEMINI_API_KEY");
			expect((error as Error).message).not.toContain(secret);
		}
	});
});

const catalog = {
	...PROVIDERS,
	fake: { apiKeySetting: "OPENAI_API_KEY" as const },
};
describe("LLM routing configuration", () => {
	it("prefers common models over legacy models and ignores unused credentials", () => {
		const config = loadConfig(
			createBindings({
				LLM_MODEL: " common-answer ",
				LLM_SUMMARY_MODEL: "common-summary",
				GEMINI_MODEL: "legacy-answer",
				GEMINI_SUMMARY_MODEL: "legacy-summary",
				OPENAI_API_KEY: " ",
			}),
		);
		expect(config.llm.answer.model).toBe("common-answer");
		expect(config.llm.summary?.model).toBe("common-summary");
	});
	it("selects another provider without requiring Gemini when summaries are disabled", () => {
		const config = loadConfig(
			createBindings({
				LLM_PROVIDER: "fake",
				LLM_MODEL: "fake-model",
				OPENAI_API_KEY: "fake-key",
				GEMINI_API_KEY: undefined,
				GEMINI_MODEL: " ",
				GEMINI_SUMMARY_MODEL: " ",
				LLM_SUMMARY_ENABLED: "false",
			}),
			catalog,
		);
		expect(config.llm).toEqual({
			answer: { provider: "fake", model: "fake-model", apiKey: "fake-key" },
			summary: null,
		});
	});
	it("uses an alternate provider for both models without Gemini credentials", () => {
		const config = loadConfig(
			createBindings({
				GEMINI_API_KEY: undefined,
				OPENAI_API_KEY: "fake-key",
				LLM_PROVIDER: "fake",
				LLM_MODEL: "fake-answer",
				LLM_SUMMARY_MODEL: "fake-summary",
			}),
			catalog,
		);
		expect(config.llm.summary).toEqual({
			provider: "fake",
			model: "fake-summary",
			apiKey: "fake-key",
		});
	});
	it("does not inherit the legacy summary model for another provider", () => {
		expect(() =>
			loadConfig(
				createBindings({
					OPENAI_API_KEY: "fake-key",
					LLM_PROVIDER: "fake",
					LLM_MODEL: "fake-answer",
					GEMINI_SUMMARY_MODEL: "legacy-summary",
				}),
				catalog,
			),
		).toThrow("Invalid configuration for LLM_SUMMARY_MODEL:");
	});
	it("allows an independently selected summary provider", () => {
		const config = loadConfig(
			createBindings({
				LLM_SUMMARY_PROVIDER: "fake",
				LLM_SUMMARY_MODEL: "fake-summary",
				OPENAI_API_KEY: "fake-key",
			}),
			catalog,
		);
		expect(config.llm.answer.provider).toBe("gemini");
		expect(config.llm.summary).toEqual({
			provider: "fake",
			model: "fake-summary",
			apiKey: "fake-key",
		});
	});
	it.each([
		[{ LLM_PROVIDER: "unknown" }, "LLM_PROVIDER"],
		[{ LLM_PROVIDER: "__proto__" }, "LLM_PROVIDER"],
		[
			{
				LLM_PROVIDER: "fake",
				OPENAI_API_KEY: "fake-key",
				GEMINI_MODEL: "legacy",
				LLM_SUMMARY_ENABLED: "false",
			},
			"LLM_MODEL",
		],
		[
			{
				LLM_PROVIDER: "fake",
				LLM_MODEL: "fake-model",
				LLM_SUMMARY_ENABLED: "false",
			},
			"OPENAI_API_KEY",
		],
		[
			{ LLM_SUMMARY_PROVIDER: "fake", LLM_SUMMARY_MODEL: "fake-model" },
			"OPENAI_API_KEY",
		],
		[{ LLM_SUMMARY_PROVIDER: "unknown" }, "LLM_SUMMARY_PROVIDER"],
		[{ LLM_SUMMARY_ENABLED: "yes" }, "LLM_SUMMARY_ENABLED"],
		[
			{ LLM_SUMMARY_ENABLED: "false", LLM_SUMMARY_MODEL: "ignored" },
			"LLM_SUMMARY_ENABLED",
		],
		[
			{ LLM_SUMMARY_ENABLED: "false", LLM_SUMMARY_PROVIDER: "gemini" },
			"LLM_SUMMARY_ENABLED",
		],
		[{ GOOGLE_SERVICE_ACCOUNT: " " }, "GOOGLE_SERVICE_ACCOUNT"],
	] satisfies Array<[Partial<Bindings>, string]>)(
		"rejects invalid routing %j safely",
		(overrides, setting) => {
			expect(() => loadConfig(createBindings(overrides), catalog)).toThrow(
				`Invalid configuration for ${setting}:`,
			);
		},
	);
});
