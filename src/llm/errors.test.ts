import { describe, expect, it } from "vitest";
import { getExternalErrorLogContext } from "../utils/errors";
import { normalizeLlmError } from "./errors";

describe("LLM errors", () => {
	it.each([
		[401, false, "http"],
		[403, false, "http"],
		[429, true, "http"],
		[503, true, "http"],
		[undefined, true, "transport"],
	])(
		"classifies status %s without including SDK bodies",
		(status, retryable, kind) => {
			const result = normalizeLlmError(
				Object.assign(new Error("secret response"), { status }),
				"test-provider",
				"generate",
			);
			expect(result).toMatchObject({
				service: "llm",
				provider: "test-provider",
				status,
				retryable,
				kind,
			});
			expect(JSON.stringify(getExternalErrorLogContext(result))).not.toContain(
				"secret",
			);
			expect(result.message).not.toContain("secret");
		},
	);

	it.each([new Headers({ "Retry-After": "2" }), { "retry-after": "2" }])(
		"extracts Retry-After from structured headers",
		(headers) => {
			const result = normalizeLlmError(
				{ status: 429, headers },
				"gemini",
				"generate",
			);
			expect(result.retryAfterMs).toBe(2000);
		},
	);

	it.each([
		["AbortError", "cancelled"],
		["TimeoutError", "timeout"],
	] as const)("does not retry %s", (name, kind) => {
		const result = normalizeLlmError(
			new DOMException("secret", name),
			"gemini",
			"generate",
		);
		expect(result).toMatchObject({ kind, retryable: false });
	});
});
