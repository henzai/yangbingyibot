import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Bindings } from "./contracts";
import { runHealthCheck } from "./health";
import type { LlmSelection } from "./llm/providerCatalog";
import type { ILlmGateway, LlmProbeResult } from "./llm/types";
import { ExternalServiceError } from "./utils/errors";
import type { Logger } from "./utils/logger";

function createMockEnv(
	overrides: Partial<Bindings> = {},
): Bindings & { METRICS: { writeDataPoint: Mock } } {
	const mockKV = {
		get: vi.fn().mockResolvedValue(null),
		put: vi.fn().mockResolvedValue(undefined),
	} as unknown as KVNamespace;
	const mockMetrics = { writeDataPoint: vi.fn() };
	return {
		DISCORD_TOKEN: "test-token",
		DISCORD_PUBLIC_KEY: "test-public-key",
		DISCORD_APPLICATION_ID: "test-app-id",
		GEMINI_API_KEY: "test-gemini-key",
		GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
			client_email: "test@test.iam.gserviceaccount.com",
			private_key: "test-private-key",
		}),
		sushanshan_bot: mockKV,
		// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
		ANSWER_QUESTION_WORKFLOW: {} as any,
		METRICS: mockMetrics as unknown as AnalyticsEngineDataset,
		...overrides,
	} as Bindings & { METRICS: { writeDataPoint: Mock } };
}

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: vi.fn().mockReturnThis(),
} as unknown as Logger;

const available: LlmProbeResult = {
	status: "available",
	scope: "model_metadata",
	generationSupport: "supported",
};

function gateway(provider: string, probe?: ILlmGateway["probe"]): ILlmGateway {
	return {
		provider,
		capabilities: { reasoningSummary: true },
		generateStream: vi.fn(),
		generateText: vi.fn(),
		...(probe ? { probe } : {}),
	};
}

function factory(
	probes: Record<string, (model: string) => Promise<LlmProbeResult>>,
) {
	return vi.fn((selection: LlmSelection) =>
		gateway(selection.provider, ({ model }) =>
			probes[selection.provider](model),
		),
	);
}

describe("health check", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		globalThis.fetch = vi.fn();
	});

	it("probes one Gemini answer target when summaries are disabled", async () => {
		const probe = vi.fn().mockResolvedValue(available);
		const createGateway = factory({ gemini: probe });
		const env = createMockEnv({ LLM_SUMMARY_ENABLED: "false" });

		const result = await runHealthCheck(env, log, createGateway);

		expect(result.allHealthy).toBe(true);
		expect(probe).toHaveBeenCalledOnce();
		expect(probe).toHaveBeenCalledWith("gemini-3.5-flash-lite");
		expect(result.checks).toContainEqual(
			expect.objectContaining({
				provider: "gemini",
				model: "gemini-3.5-flash-lite",
				purposes: ["answer"],
				status: "healthy",
			}),
		);
	});

	it("probes OpenAI only and never initializes an unselected provider", async () => {
		const openaiProbe = vi.fn().mockResolvedValue(available);
		const createGateway = factory({ openai: openaiProbe });
		const env = createMockEnv({
			LLM_PROVIDER: "openai",
			LLM_MODEL: "openai-answer",
			LLM_SUMMARY_ENABLED: "false",
			OPENAI_API_KEY: "test-openai-key",
		});

		const result = await runHealthCheck(env, log, createGateway);

		expect(result.allHealthy).toBe(true);
		expect(createGateway).toHaveBeenCalledOnce();
		expect(createGateway).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai", model: "openai-answer" }),
			log,
		);
		expect(openaiProbe).toHaveBeenCalledWith("openai-answer");
	});

	it("deduplicates a shared provider/model used for answer and summary", async () => {
		const probe = vi.fn().mockResolvedValue(available);
		const env = createMockEnv({
			LLM_MODEL: "shared-model",
			LLM_SUMMARY_MODEL: "shared-model",
		});

		const result = await runHealthCheck(env, log, factory({ gemini: probe }));

		expect(probe).toHaveBeenCalledTimes(1);
		expect(result.checks).toContainEqual(
			expect.objectContaining({
				provider: "gemini",
				model: "shared-model",
				purposes: ["answer", "summary"],
			}),
		);
	});

	it("probes two models separately when one provider serves both purposes", async () => {
		const probe = vi.fn().mockResolvedValue(available);
		const createGateway = factory({ gemini: probe });
		const env = createMockEnv({
			LLM_MODEL: "answer-model",
			LLM_SUMMARY_MODEL: "summary-model",
		});

		const result = await runHealthCheck(env, log, createGateway);

		expect(createGateway).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(probe.mock.calls.map(([model]) => model)).toEqual([
			"answer-model",
			"summary-model",
		]);
		expect(result.checks.filter((check) => check.provider)).toHaveLength(2);
	});

	it("probes answer and summary providers separately", async () => {
		const geminiProbe = vi.fn().mockResolvedValue(available);
		const openaiProbe = vi.fn().mockResolvedValue({
			...available,
			generationSupport: "unverified",
		});
		const env = createMockEnv({
			LLM_MODEL: "gemini-answer",
			LLM_SUMMARY_PROVIDER: "openai",
			LLM_SUMMARY_MODEL: "openai-summary",
			OPENAI_API_KEY: "test-openai-key",
		});

		const result = await runHealthCheck(
			env,
			log,
			factory({ gemini: geminiProbe, openai: openaiProbe }),
		);

		expect(geminiProbe).toHaveBeenCalledWith("gemini-answer");
		expect(openaiProbe).toHaveBeenCalledWith("openai-summary");
		expect(result.checks.filter((check) => check.provider)).toHaveLength(2);
		expect(result.allHealthy).toBe(true);
	});

	it("distinguishes authentication, timeout, and unavailable-probe states", async () => {
		const authentication = new ExternalServiceError({
			service: "llm",
			provider: "gemini",
			kind: "http",
			operation: "retrieve model metadata",
			status: 401,
			retryable: false,
			userMessage: "authentication failed",
		});
		const timeout = new ExternalServiceError({
			service: "llm",
			provider: "gemini",
			kind: "timeout",
			operation: "retrieve model metadata",
			retryable: false,
			userMessage: "timeout",
		});
		for (const [error, errorKind] of [
			[authentication, "authentication"],
			[timeout, "timeout"],
		] as const) {
			const result = await runHealthCheck(
				createMockEnv({ LLM_SUMMARY_ENABLED: "false" }),
				log,
				vi.fn(() => gateway("gemini", vi.fn().mockRejectedValue(error))),
			);
			expect(result.checks).toContainEqual(
				expect.objectContaining({ status: "unhealthy", errorKind }),
			);
		}

		const unverified = await runHealthCheck(
			createMockEnv({ LLM_SUMMARY_ENABLED: "false" }),
			log,
			vi.fn(() => gateway("gemini")),
		);
		expect(unverified.allHealthy).toBe(false);
		expect(unverified.checks).toContainEqual(
			expect.objectContaining({
				status: "unverified",
				errorKind: "probe_unavailable",
			}),
		);
	});

	it("keeps KV and Google service-account checks", async () => {
		const mockKV = {
			get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
			put: vi.fn(),
		} as unknown as KVNamespace;
		const result = await runHealthCheck(
			createMockEnv({
				sushanshan_bot: mockKV,
				GOOGLE_SERVICE_ACCOUNT: "invalid-json",
				LLM_SUMMARY_ENABLED: "false",
			}),
			log,
			factory({ gemini: vi.fn().mockResolvedValue(available) }),
		);

		expect(result.allHealthy).toBe(false);
		expect(result.checks).toContainEqual(
			expect.objectContaining({ name: "kv", status: "unhealthy" }),
		);
		expect(result.checks).toContainEqual(
			expect.objectContaining({ name: "google_sa", status: "unhealthy" }),
		);
	});

	it("records provider/model/purpose in health metrics", async () => {
		const env = createMockEnv({ LLM_SUMMARY_ENABLED: "false" });
		await runHealthCheck(
			env,
			log,
			factory({ gemini: vi.fn().mockResolvedValue(available) }),
		);

		expect(env.METRICS.writeDataPoint).toHaveBeenCalledWith({
			indexes: ["llm:gemini:gemini-3.5-flash-lite:answer"],
			blobs: [
				"health_check",
				"llm:gemini:gemini-3.5-flash-lite:answer",
				"healthy",
				"gemini",
				"gemini-3.5-flash-lite",
				"answer",
				"",
				"model_metadata",
				"supported",
			],
			doubles: [expect.any(Number), 1],
		});
	});

	it("uses separate v2 incident fingerprints for different providers", async () => {
		const env = createMockEnv({
			LLM_MODEL: "gemini-answer",
			LLM_SUMMARY_PROVIDER: "openai",
			LLM_SUMMARY_MODEL: "openai-summary",
			OPENAI_API_KEY: "test-openai-key",
			GITHUB_TOKEN: "github-token",
		});
		const failure = (provider: string) =>
			new ExternalServiceError({
				service: "llm",
				provider,
				kind: "transport",
				operation: "retrieve model metadata",
				retryable: true,
				userMessage: "unavailable",
			});
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response("{}", { status: 201 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response("{}", { status: 201 }));

		await runHealthCheck(
			env,
			log,
			vi.fn((selection) =>
				gateway(
					selection.provider,
					vi.fn().mockRejectedValue(failure(selection.provider)),
				),
			),
		);

		const searchUrls = vi
			.mocked(globalThis.fetch)
			.mock.calls.map(([url]) => String(url))
			.filter((url) => url.includes("/search/issues"))
			.map((url) => decodeURIComponent(url));
		expect(searchUrls).toHaveLength(2);
		expect(searchUrls[0]).toContain("gemini:gemini-answer:answer");
		expect(searchUrls[0]).not.toContain("openai-summary");
		expect(searchUrls[1]).toContain("openai:openai-summary:summary");
		expect(searchUrls[1]).not.toContain("gemini-answer");
	});
});
