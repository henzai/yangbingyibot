import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CheckResult } from "./health";
import { runHealthCheck } from "./health";
import type { Bindings } from "./types";

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createMockEnv(
	overrides: Partial<Bindings> = {},
): Bindings & { METRICS: { writeDataPoint: Mock } } {
	const mockKV = {
		get: vi.fn().mockResolvedValue(null),
		put: vi.fn().mockResolvedValue(undefined),
	} as unknown as KVNamespace;

	const mockMetrics = {
		writeDataPoint: vi.fn(),
	};

	return {
		DISCORD_TOKEN: "test-token",
		DISCORD_PUBLIC_KEY: "test-public-key",
		DISCORD_APPLICATION_ID: "test-app-id",
		GEMINI_API_KEY: "test-gemini-key",
		GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
			type: "service_account",
			client_email: "test@test.iam.gserviceaccount.com",
			private_key:
				"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
		}),
		sushanshan_bot: mockKV,
		// biome-ignore lint/suspicious/noExplicitAny: mock binding for test
		ANSWER_QUESTION_WORKFLOW: {} as any,
		METRICS: mockMetrics as unknown as AnalyticsEngineDataset,
		...overrides,
	} as Bindings & { METRICS: { writeDataPoint: Mock } };
}

const mockLog = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: vi.fn().mockReturnThis(),
};

// biome-ignore lint/suspicious/noExplicitAny: mock logger for test
const log = mockLog as any;

describe("health check", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockReset();
	});

	describe("all checks pass", () => {
		it("returns allHealthy: true with no GitHub issue", async () => {
			const env = createMockEnv();
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(true);
			expect(result.checks).toHaveLength(3);
			for (const check of result.checks) {
				expect(check.ok).toBe(true);
			}
			// Metrics recorded for all 3 checks
			expect(env.METRICS.writeDataPoint).toHaveBeenCalledTimes(3);
			// No GitHub issue creation (fetch called only for Gemini models.list)
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("KV failure", () => {
		it("reports allHealthy: false and creates GitHub issue", async () => {
			const mockKV = {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "__health_check__") {
						throw new Error("KV binding unavailable");
					}
					// For deduplication KV check
					return Promise.resolve(null);
				}),
				put: vi.fn().mockResolvedValue(undefined),
			} as unknown as KVNamespace;

			const env = createMockEnv({
				sushanshan_bot: mockKV,
				GITHUB_TOKEN: "test-github-token",
			});

			// Gemini models.list - success
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);
			// GitHub isDuplicate search - not duplicate
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			);
			// GitHub create issue - success
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1 }), { status: 201 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const kvCheck = result.checks.find((c: CheckResult) => c.name === "kv");
			expect(kvCheck?.ok).toBe(false);
			expect(kvCheck?.error).toBe("KV binding unavailable");

			// GitHub issue created
			expect(mockFetch).toHaveBeenCalledTimes(3);
		});
	});

	describe("Gemini API failure", () => {
		it("reports failure on HTTP 500", async () => {
			const env = createMockEnv({ GITHUB_TOKEN: "test-github-token" });

			// Gemini models.list - HTTP 500
			mockFetch.mockResolvedValueOnce(
				new Response("Internal Server Error", { status: 500 }),
			);
			// GitHub isDuplicate search
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			);
			// GitHub create issue
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1 }), { status: 201 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const geminiCheck = result.checks.find(
				(c: CheckResult) => c.name === "gemini",
			);
			expect(geminiCheck?.ok).toBe(false);
			expect(geminiCheck?.error).toBe("HTTP 500");
		});

		it("reports failure on HTTP 401 (invalid key)", async () => {
			const env = createMockEnv({ GITHUB_TOKEN: "test-github-token" });

			mockFetch.mockResolvedValueOnce(
				new Response("Unauthorized", { status: 401 }),
			);
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			);
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1 }), { status: 201 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const geminiCheck = result.checks.find(
				(c: CheckResult) => c.name === "gemini",
			);
			expect(geminiCheck?.ok).toBe(false);
			expect(geminiCheck?.error).toBe("HTTP 401");
		});
	});

	describe("Google SA failure", () => {
		it("reports failure on invalid JSON", async () => {
			const env = createMockEnv({
				GOOGLE_SERVICE_ACCOUNT: "not-json",
			});

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const saCheck = result.checks.find(
				(c: CheckResult) => c.name === "google_sa",
			);
			expect(saCheck?.ok).toBe(false);
			expect(saCheck?.error).toBeDefined();
		});

		it("reports failure when required fields are missing", async () => {
			const env = createMockEnv({
				GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
					type: "service_account",
				}),
			});

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const saCheck = result.checks.find(
				(c: CheckResult) => c.name === "google_sa",
			);
			expect(saCheck?.ok).toBe(false);
			expect(saCheck?.error).toBe(
				"Missing required fields: client_email or private_key",
			);
		});
	});

	describe("GITHUB_TOKEN not set", () => {
		it("runs checks and records metrics but skips issue creation", async () => {
			const env = createMockEnv({
				GOOGLE_SERVICE_ACCOUNT: "invalid-json",
			});
			// No GITHUB_TOKEN set

			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			// Metrics still recorded
			expect(env.METRICS.writeDataPoint).toHaveBeenCalledTimes(3);
			// Only Gemini models.list fetch, no GitHub API calls
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("multiple simultaneous failures", () => {
		it("reports all failures in a single issue", async () => {
			const mockKV = {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "__health_check__") {
						throw new Error("KV unavailable");
					}
					return Promise.resolve(null);
				}),
				put: vi.fn().mockResolvedValue(undefined),
			} as unknown as KVNamespace;

			const env = createMockEnv({
				sushanshan_bot: mockKV,
				GOOGLE_SERVICE_ACCOUNT: "invalid",
				GITHUB_TOKEN: "test-github-token",
			});

			// Gemini - failure
			mockFetch.mockResolvedValueOnce(new Response("Error", { status: 500 }));
			// GitHub isDuplicate
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
			);
			// GitHub create issue
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 1 }), { status: 201 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			const failedChecks = result.checks.filter((c: CheckResult) => !c.ok);
			expect(failedChecks).toHaveLength(3);
		});
	});

	describe("GitHub issue creation failure", () => {
		it("returns health check result normally (non-fatal)", async () => {
			const env = createMockEnv({
				GOOGLE_SERVICE_ACCOUNT: "invalid",
				GITHUB_TOKEN: "test-github-token",
			});

			// Gemini - success
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);
			// GitHub isDuplicate - fails
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const result = await runHealthCheck(env, log);

			// Health check result is still returned despite GitHub failure
			expect(result.allHealthy).toBe(false);
			expect(result.checks).toHaveLength(3);
		});
	});

	describe("deduplication (KV cache hit)", () => {
		it("does not create duplicate issue when KV cache hit", async () => {
			const mockKV = {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "__health_check__") {
						throw new Error("KV unavailable");
					}
					// KV deduplication key exists
					if (key.startsWith("error_reported:")) {
						return Promise.resolve("1");
					}
					return Promise.resolve(null);
				}),
				put: vi.fn().mockResolvedValue(undefined),
			} as unknown as KVNamespace;

			const env = createMockEnv({
				sushanshan_bot: mockKV,
				GITHUB_TOKEN: "test-github-token",
			});

			// Gemini - success
			mockFetch.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await runHealthCheck(env, log);

			expect(result.allHealthy).toBe(false);
			// Only Gemini fetch, no GitHub API calls due to KV dedup
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});
});
