import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "../utils/errors";
import {
	createGitHubIssueClient,
	type ErrorReport,
	GitHubIssueClient,
} from "./github";

describe("GitHubIssueClient", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
	});

	const sampleReport: ErrorReport = {
		errorMessage: "Gemini API failed with status 500",
		requestId: "req-123",
		workflowId: "wf-456",
		step: "streamGeminiAndEditDiscord",
		durationMs: 5000,
		stepCount: 2,
		timestamp: "2026-02-14T12:00:00.000Z",
	};

	describe("generateFingerprint", () => {
		it("replaces UUIDs with placeholder", () => {
			const client = new GitHubIssueClient("token");
			const result = client.generateFingerprint(
				"Error for request 550e8400-e29b-41d4-a716-446655440000",
			);
			expect(result).toBe("Error for request <UUID>");
		});

		it("replaces timestamps with placeholder", () => {
			const client = new GitHubIssueClient("token");
			const result = client.generateFingerprint(
				"Error at 2026-02-14T12:00:00.000Z",
			);
			expect(result).toBe("Error at <TIMESTAMP>");
		});

		it("replaces numbers with placeholder", () => {
			const client = new GitHubIssueClient("token");
			const result = client.generateFingerprint(
				"Failed with status 500 after 3 retries",
			);
			expect(result).toBe("Failed with status <N> after <N> retries");
		});

		it("replaces hex strings with placeholder", () => {
			const client = new GitHubIssueClient("token");
			const result = client.generateFingerprint(
				"Error for hash abcdef0123456789",
			);
			expect(result).toBe("Error for hash <HEX>");
		});

		it("normalizes complex error messages consistently", () => {
			const client = new GitHubIssueClient("token");
			const msg1 =
				"Gemini API error: status 503 at 2026-02-14T10:00:00Z request abc12345";
			const msg2 =
				"Gemini API error: status 429 at 2026-02-14T15:30:00Z request def67890";
			expect(client.generateFingerprint(msg1)).toBe(
				client.generateFingerprint(msg2),
			);
		});
	});

	describe("createIssue", () => {
		it("creates an issue successfully", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 201,
			});
			globalThis.fetch = mockFetch;

			const client = new GitHubIssueClient("test-token");
			const result = await client.createIssue(sampleReport, "test-fingerprint");

			expect(result).toBeUndefined();
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const [url, options] = mockFetch.mock.calls[0];
			expect(url).toBe(
				"https://api.github.com/repos/henzai/yangbingyibot/issues",
			);
			expect(options.method).toBe("POST");
			expect(options.headers.Authorization).toBe("Bearer test-token");

			const body = JSON.parse(options.body);
			expect(body.title).toContain("[Auto] Worker Error:");
			expect(body.title).toContain("Gemini API failed");
			expect(body.labels).toEqual(["bug", "auto-reported"]);
			expect(body.body).toContain("test-fingerprint");
			expect(body.body).toContain("req-123");
		});

		it("uses the configured repository", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 201,
			});
			globalThis.fetch = mockFetch;
			const client = new GitHubIssueClient("test-token", undefined, {
				owner: "octo-org",
				name: "bot",
				fullName: "octo-org/bot",
			});

			await client.createIssue(sampleReport, "fingerprint");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/octo-org/bot/issues",
				expect.any(Object),
			);
		});

		it("truncates long error messages in the title", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 201,
			});

			const client = new GitHubIssueClient("test-token");
			const longReport = {
				...sampleReport,
				errorMessage: "A".repeat(200),
			};
			await client.createIssue(longReport, "fp");

			const body = JSON.parse(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			// Title should be truncated: "[Auto] Worker Error: " + 80 chars
			expect(body.title.length).toBeLessThanOrEqual(
				"[Auto] Worker Error: ".length + 80,
			);
		});

		it("throws a typed non-retryable API error", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("secret body", { status: 403 }));

			const client = new GitHubIssueClient("test-token");
			const error = await client
				.createIssue(sampleReport, "fp")
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(ExternalServiceError);
			expect(error).toMatchObject({
				service: "github",
				operation: "create issue",
				status: 403,
				retryable: false,
			});
			expect(error.message).not.toContain("secret body");
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("does not retry an ambiguous POST network error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

			const client = new GitHubIssueClient("test-token");
			const error = await client
				.createIssue(sampleReport, "fp")
				.catch((caught) => caught);

			expect(error).toMatchObject({
				service: "github",
				operation: "create issue",
				retryable: true,
			});
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("omits step row from body when step is undefined", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 201,
			});

			const client = new GitHubIssueClient("test-token");
			const reportWithoutStep = { ...sampleReport, step: undefined };
			await client.createIssue(reportWithoutStep, "fp");

			const body = JSON.parse(
				(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
			);
			expect(body.body).not.toContain("**Step**");
		});
	});

	describe("isDuplicate", () => {
		it("returns true when matching issues exist", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ total_count: 1 }),
			});

			const client = new GitHubIssueClient("test-token");
			const result = await client.isDuplicate("test-fingerprint");

			expect(result).toBe(true);

			const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(url).toContain("search/issues");
			expect(url).toContain("auto-reported");
			expect(url).toContain("test-fingerprint");
		});

		it("returns false when no matching issues exist", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ total_count: 0 }),
			});

			const client = new GitHubIssueClient("test-token");
			const result = await client.isDuplicate("test-fingerprint");

			expect(result).toBe(false);
		});

		it("throws without retrying a permanent API error", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 403 }));

			const client = new GitHubIssueClient("test-token");
			const error = await client
				.isDuplicate("test-fingerprint")
				.catch((caught) => caught);

			expect(error).toMatchObject({
				status: 403,
				retryable: false,
			});
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("retries a network error before succeeding", async () => {
			vi.useFakeTimers();
			globalThis.fetch = vi
				.fn()
				.mockRejectedValueOnce(new Error("Network error"))
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ total_count: 0 }),
				});

			const client = new GitHubIssueClient("test-token");
			const promise = client.isDuplicate("test-fingerprint");
			await vi.runAllTimersAsync();

			await expect(promise).resolves.toBe(false);
			expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("createGitHubIssueClient", () => {
		it("creates a new GitHubIssueClient instance", () => {
			const client = createGitHubIssueClient("test-token");
			expect(client).toBeInstanceOf(GitHubIssueClient);
		});
	});
});
