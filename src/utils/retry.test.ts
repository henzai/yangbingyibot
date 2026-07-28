import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "./errors";
import { withRetry } from "./retry";

function serviceError(
	status: number | undefined,
	options: { retryable?: boolean; retryAfterMs?: number } = {},
) {
	return new ExternalServiceError({
		service: "discord",
		operation: "post message",
		status,
		retryable: options.retryable ?? true,
		userMessage: "Discordへの送信に失敗しました。",
		retryAfterMs: options.retryAfterMs,
	});
}

describe("withRetry", () => {
	it("returns a successful result without sleeping", async () => {
		const fn = vi.fn().mockResolvedValue("success");
		const sleep = vi.fn();

		await expect(withRetry(fn, { sleep })).resolves.toBe("success");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it.each([undefined, 408, 429, 500, 503])(
		"retries a retryable status %s",
		async (status) => {
			const fn = vi
				.fn()
				.mockRejectedValueOnce(serviceError(status))
				.mockResolvedValueOnce("success");
			const sleep = vi.fn().mockResolvedValue(undefined);

			await expect(withRetry(fn, { sleep, random: () => 0.5 })).resolves.toBe(
				"success",
			);
			expect(fn).toHaveBeenCalledTimes(2);
			expect(sleep).toHaveBeenCalledTimes(1);
		},
	);

	it.each([400, 401, 403, 404])(
		"does not retry a permanent status %s",
		async (status) => {
			const error = serviceError(status, { retryable: false });
			const fn = vi.fn().mockRejectedValue(error);
			const sleep = vi.fn();

			await expect(withRetry(fn, { sleep })).rejects.toBe(error);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		},
	);

	it("does not retry generic errors by default", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("local failure"));

		await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toThrow(
			"local failure",
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("uses Retry-After instead of exponential backoff", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(serviceError(429, { retryAfterMs: 4200 }))
			.mockResolvedValueOnce("success");
		const sleep = vi.fn().mockResolvedValue(undefined);

		await withRetry(fn, {
			initialDelayMs: 1000,
			sleep,
			random: () => 0.25,
		});

		expect(sleep).toHaveBeenCalledWith(4200);
	});

	it("uses capped exponential backoff with full jitter", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(serviceError(500))
			.mockRejectedValueOnce(serviceError(503))
			.mockRejectedValueOnce(serviceError(408))
			.mockResolvedValueOnce("success");
		const sleep = vi.fn().mockResolvedValue(undefined);
		const random = vi
			.fn()
			.mockReturnValueOnce(0.5)
			.mockReturnValueOnce(0.25)
			.mockReturnValueOnce(1);

		await withRetry(fn, {
			maxAttempts: 4,
			initialDelayMs: 1000,
			backoffMultiplier: 3,
			maxDelayMs: 5000,
			sleep,
			random,
		});

		expect(sleep.mock.calls).toEqual([[500], [750], [5000]]);
	});

	it("throws the last error after maxAttempts", async () => {
		const first = serviceError(500);
		const last = serviceError(503);
		const fn = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last);

		await expect(
			withRetry(fn, {
				maxAttempts: 2,
				sleep: vi.fn().mockResolvedValue(undefined),
				random: () => 0,
			}),
		).rejects.toBe(last);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("allows an explicit retry predicate for non-service operations", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("retry me"))
			.mockResolvedValueOnce("success");

		await expect(
			withRetry(
				fn,
				{ sleep: vi.fn().mockResolvedValue(undefined), random: () => 0 },
				() => true,
			),
		).resolves.toBe("success");
	});

	it("logs structured fields without the cause message", async () => {
		const log = {
			warn: vi.fn(),
		};
		const error = new ExternalServiceError({
			service: "gemini",
			operation: "generate content",
			status: 500,
			retryable: true,
			userMessage: "AIへの接続に失敗しました。",
			cause: new Error("secret response body"),
		});
		const fn = vi
			.fn()
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce("success");

		await withRetry(
			fn,
			{ sleep: vi.fn().mockResolvedValue(undefined), random: () => 0 },
			undefined,
			log as never,
		);

		expect(log.warn).toHaveBeenCalledWith(
			"Retrying external service request",
			expect.objectContaining({
				service: "gemini",
				operation: "generate content",
				status: 500,
			}),
		);
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
			"secret response body",
		);
	});
});
