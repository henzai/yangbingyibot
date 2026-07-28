import { describe, expect, it } from "vitest";
import {
	ExternalServiceError,
	externalServiceErrorFromResponse,
	getExternalErrorLogContext,
	getUserMessage,
	isRetryableStatus,
	normalizeExternalServiceError,
	parseRetryAfterMs,
} from "./errors";

describe("ExternalServiceError", () => {
	it.each([undefined, 408, 429, 500, 503])(
		"classifies status %s as retryable",
		(status) => {
			expect(isRetryableStatus(status)).toBe(true);
		},
	);

	it.each([400, 401, 403, 404, 422])(
		"classifies permanent status %s as non-retryable",
		(status) => {
			expect(isRetryableStatus(status)).toBe(false);
		},
	);

	it("normalizes SDK errors from structured status without exposing the cause", () => {
		const secretBody = new Error(
			'{"error":{"message":"secret response body"}}',
		) as Error & { status: number };
		secretBody.status = 429;

		const result = normalizeExternalServiceError(secretBody, {
			service: "gemini",
			operation: "generate content",
			userMessage: "AIへの接続に失敗しました。",
		});

		expect(result).toBeInstanceOf(ExternalServiceError);
		expect(result.status).toBe(429);
		expect(result.retryable).toBe(true);
		expect(result.message).toBe("gemini generate content failed (status 429)");
		expect(result.message).not.toContain("secret response body");
		expect(result.cause).toBe(secretBody);
	});

	it("creates a safe error from an HTTP response without reading its body", () => {
		const response = new Response("secret response body", {
			status: 403,
			headers: { "Retry-After": "5" },
		});

		const result = externalServiceErrorFromResponse(
			"github",
			"create issue",
			response,
			"Issueの作成に失敗しました。",
		);

		expect(result.status).toBe(403);
		expect(result.retryable).toBe(false);
		expect(result.retryAfterMs).toBe(5000);
		expect(result.message).not.toContain("secret response body");
		expect(getUserMessage(result)).toBe("Issueの作成に失敗しました。");
	});

	it("returns only safe structured fields for logging", () => {
		const error = new ExternalServiceError({
			service: "discord",
			operation: "edit message",
			status: 500,
			retryable: true,
			userMessage: "Discordへの送信に失敗しました。",
			retryAfterMs: 2000,
			cause: new Error("secret cause"),
		});

		expect(getExternalErrorLogContext(error)).toEqual({
			service: "discord",
			operation: "edit message",
			status: 500,
			retryable: true,
			retryAfterMs: 2000,
		});
	});
});

describe("parseRetryAfterMs", () => {
	it("parses delta seconds", () => {
		expect(parseRetryAfterMs("1.5")).toBe(1500);
	});

	it("parses an HTTP date", () => {
		const now = Date.parse("2026-07-28T12:00:00.000Z");
		expect(parseRetryAfterMs("Tue, 28 Jul 2026 12:00:05 GMT", now)).toBe(5000);
	});

	it("clamps excessive values and rejects invalid values", () => {
		expect(parseRetryAfterMs("120")).toBe(60_000);
		expect(parseRetryAfterMs("-1")).toBeUndefined();
		expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
		expect(parseRetryAfterMs(null)).toBeUndefined();
	});
});
