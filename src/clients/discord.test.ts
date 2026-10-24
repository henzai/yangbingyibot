import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "../utils/errors";
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
			const mockFetch = vi.fn().mockResolvedValue(new Response(null));
			globalThis.fetch = mockFetch;

			const client = new DiscordWebhookClient("app-id", "test-token");
			const result = await client.editOriginalMessage("hello");

			expect(result).toBeUndefined();
			expect(mockFetch).toHaveBeenCalledWith(
				"https://discord.com/api/v10/webhooks/app-id/test-token/messages/@original",
				{
					method: "PATCH",
					body: JSON.stringify({ content: "hello" }),
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		it("throws a typed error on non-ok response", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response("secret body", { status: 500 }));

			const client = new DiscordWebhookClient("app-id", "token");
			const error = await client
				.editOriginalMessage("content")
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(ExternalServiceError);
			expect(error).toMatchObject({
				service: "discord",
				operation: "edit original message",
				status: 500,
				retryable: true,
			});
			expect(error.message).not.toContain("secret body");
		});

		it("carries Retry-After on a 429 without sleeping in the client", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 429,
					headers: { "Retry-After": "0.1" },
				}),
			);

			const client = new DiscordWebhookClient("app-id", "token");
			const error = await client
				.editOriginalMessage("content")
				.catch((caught) => caught);

			expect(error).toMatchObject({
				status: 429,
				retryable: true,
				retryAfterMs: 100,
			});
		});

		it("normalizes network errors without exposing their message", async () => {
			globalThis.fetch = vi
				.fn()
				.mockRejectedValue(new Error("Network error with test-token"));

			const client = new DiscordWebhookClient("app-id", "token");
			const error = await client
				.editOriginalMessage("content")
				.catch((caught) => caught);

			expect(error).toMatchObject({
				service: "discord",
				status: undefined,
				retryable: true,
			});
			expect(error.message).not.toContain("test-token");
		});
	});

	describe("postMessage", () => {
		it("sends POST to correct endpoint", async () => {
			const mockFetch = vi.fn().mockResolvedValue(new Response(null));
			globalThis.fetch = mockFetch;

			const client = new DiscordWebhookClient("app-id", "test-token");
			const result = await client.postMessage("hello world");

			expect(result).toBeUndefined();
			expect(mockFetch).toHaveBeenCalledWith(
				"https://discord.com/api/v10/webhooks/app-id/test-token",
				{
					method: "POST",
					body: JSON.stringify({ content: "hello world" }),
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		it.each([
			[400, false],
			[401, false],
			[403, false],
			[404, false],
			[408, true],
			[429, true],
			[500, true],
			[503, true],
		])("classifies status %s with retryable=%s", async (status, retryable) => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response(null, { status }));

			const client = new DiscordWebhookClient("app-id", "token");
			const error = await client
				.postMessage("content")
				.catch((caught) => caught);

			expect(error).toMatchObject({
				service: "discord",
				operation: "post message",
				status,
				retryable,
			});
		});

		it("normalizes a fetch error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

			const client = new DiscordWebhookClient("app-id", "token");
			const error = await client
				.postMessage("content")
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(ExternalServiceError);
			expect(error).toMatchObject({
				service: "discord",
				operation: "post message",
				retryable: true,
			});
		});
	});

	describe("createDiscordWebhookClient", () => {
		it("creates a new DiscordWebhookClient instance", () => {
			const client = createDiscordWebhookClient("app-id", "token");
			expect(client).toBeInstanceOf(DiscordWebhookClient);
		});
	});
});
