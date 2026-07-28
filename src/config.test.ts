import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_RUNTIME_CONFIG, loadConfig } from "./config";
import type { Bindings, WorkflowParams } from "./contracts";

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

		expect(config).toMatchObject({
			geminiModel: DEFAULT_RUNTIME_CONFIG.geminiModel,
			geminiSummaryModel: DEFAULT_RUNTIME_CONFIG.geminiSummaryModel,
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
			geminiModel: "answer-model",
			geminiSummaryModel: "summary-model",
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
