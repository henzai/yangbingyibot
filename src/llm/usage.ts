import type { LlmUsage } from "./types";

export function zeroUsage(): LlmUsage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
	};
}

/** Add separate calls only. Any missing counter makes that aggregate unknown. */
export function addLlmUsage(total: LlmUsage, usage: LlmUsage | null): LlmUsage {
	const result = zeroUsage();
	for (const key of Object.keys(result) as Array<keyof LlmUsage>) {
		const value = usage?.[key];
		result[key] =
			total[key] === null || value == null ? null : total[key] + value;
	}
	return result;
}

/** Decode usage from a checkpoint written before or after the common-contract migration. */
export function normalizeSavedUsage(value: unknown): LlmUsage | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const legacyNames = {
		inputTokens: "promptTokens",
		cachedInputTokens: "cachedTokens",
		outputTokens: "candidatesTokens",
		reasoningTokens: "thoughtsTokens",
		totalTokens: "totalTokens",
	} as const;
	const isLegacy = "promptTokens" in record || "candidatesTokens" in record;
	const result = zeroUsage();
	for (const key of Object.keys(result) as Array<keyof LlmUsage>) {
		const counter = record[isLegacy ? legacyNames[key] : key];
		result[key] =
			typeof counter === "number" && Number.isFinite(counter) && counter >= 0
				? counter
				: null;
	}
	return result;
}
