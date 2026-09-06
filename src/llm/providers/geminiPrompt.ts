import type { LlmPrompt } from "../types";

/** Gemini wire conversion, also used by the temporary legacy prompt facade. */
export function toGeminiPrompt(
	prompt: LlmPrompt,
	includeReasoningSummary = false,
) {
	let systemInstruction = prompt.systemInstruction;
	if (prompt.context !== undefined) {
		if (includeReasoningSummary) {
			systemInstruction += "\n思考過程は必ず日本語で行ってください。";
		}
		systemInstruction += `\n---\nスプレッドシートの情報:\n${prompt.context}\n---`;
	}
	return {
		systemInstruction,
		contents: prompt.messages.map(({ role, text }) => ({
			role: role === "assistant" ? ("model" as const) : ("user" as const),
			parts: [{ text }],
		})),
	};
}
