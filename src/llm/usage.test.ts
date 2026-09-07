import { describe, expect, it } from "vitest";
import { addLlmUsage, normalizeSavedUsage, zeroUsage } from "./usage";

describe("usage aggregation and checkpoint compatibility", () => {
	it("adds separate calls while keeping an unknown component unknown", () => {
		const first = {
			...zeroUsage(),
			inputTokens: 10,
			outputTokens: null,
			totalTokens: 14,
		};
		const second = {
			...zeroUsage(),
			inputTokens: 20,
			outputTokens: 4,
			totalTokens: 24,
		};
		expect(addLlmUsage(addLlmUsage(zeroUsage(), first), second)).toEqual({
			...zeroUsage(),
			inputTokens: 30,
			outputTokens: null,
			totalTokens: 38,
		});
		expect(Object.values(addLlmUsage(second, null))).toEqual([
			null,
			null,
			null,
			null,
			null,
		]);
	});
	it("reads legacy counters from completed Workflow steps", () => {
		expect(
			normalizeSavedUsage({
				promptTokens: 10,
				cachedTokens: 2,
				candidatesTokens: 3,
				thoughtsTokens: 4,
				totalTokens: 17,
			}),
		).toEqual({
			inputTokens: 10,
			cachedInputTokens: 2,
			outputTokens: 3,
			reasoningTokens: 4,
			totalTokens: 17,
		});
	});
	it("preserves missing counters and rejects malformed values", () => {
		expect(
			normalizeSavedUsage({
				...zeroUsage(),
				inputTokens: null,
				outputTokens: -1,
				totalTokens: Number.NaN,
			}),
		).toEqual({
			...zeroUsage(),
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
		});
		expect(normalizeSavedUsage(null)).toBeNull();
		expect(normalizeSavedUsage("invalid")).toBeNull();
	});
});
