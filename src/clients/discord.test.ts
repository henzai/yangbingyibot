import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordWebhookClient, DiscordWebhookClient } from "./discord";

describe("DiscordWebhookClient", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("editOriginalMessage", () => {
		it("sends PATCH to correct endpoint", async () => {
			const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
			globalThis.fetch = mockFetch;

			const client = new DiscordWebhookClient("app-id", "test-token");
			const result = await client.editOriginalMessage("hello");

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://discord.com/api/v10/webhooks/app-id/test-token/messages/@original",
				{
					method: "PATCH",
					body: JSON.stringify({ content: "hello" }),
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		it("returns false on non-ok response", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				headers: new Headers(),
			});

			const client = new DiscordWebhookClient("app-id", "token");
			const result = await client.editOriginalMessage("content");

			expect(result).toBe(false);
		});

		it("waits on 429 rate limit with Retry-After header", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 429,
				headers: new Headers({ "Retry-After": "0.1" }),
			});

			const client = new DiscordWebhookClient("app-id", "token");
			const start = Date.now();
			const result = await client.editOriginalMessage("content");
			const elapsed = Date.now() - start;

			expect(result).toBe(false);
			expect(elapsed).toBeGreaterThanOrEqual(80);
		});

		it("returns false on fetch error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

			const client = new DiscordWebhookClient("app-id", "token");
			const result = await client.editOriginalMessage("content");

			expect(result).toBe(false);
		});
	});

	describe("postMessage", () => {
		it("sends POST to correct endpoint", async () => {
			const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
			globalThis.fetch = mockFetch;

			const client = new DiscordWebhookClient("app-id", "test-token");
			const result = await client.postMessage("hello world");

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://discord.com/api/v10/webhooks/app-id/test-token",
				{
					method: "POST",
					body: JSON.stringify({ content: "hello world" }),
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		it("throws error on non-ok response", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
			});

			const client = new DiscordWebhookClient("app-id", "token");
			await expect(client.postMessage("content")).rejects.toThrow(
				"Discord POST failed with status 500",
			);
		});

		it("throws error on fetch error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

			const client = new DiscordWebhookClient("app-id", "token");
			await expect(client.postMessage("content")).rejects.toThrow(
				"Network error",
			);
		});
	});

	describe("createDiscordWebhookClient", () => {
		it("creates a new DiscordWebhookClient instance", () => {
			const client = createDiscordWebhookClient("app-id", "token");
			expect(client).toBeInstanceOf(DiscordWebhookClient);
		});
	});
});
