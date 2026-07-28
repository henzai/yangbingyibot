import type { HistoryEntry } from "../contracts";
import type { GeminiPrompt } from "./types";

export type AnswerPromptInput = {
	description: string;
	knowledge: string;
	history: HistoryEntry[];
	question: string;
};

export function buildAnswerPrompt(input: AnswerPromptInput): GeminiPrompt {
	const history = input.history.map((entry) => ({
		role: entry.role,
		parts: [{ text: entry.text }],
	}));

	return {
		systemInstruction: `${input.description}
思考過程は必ず日本語で行ってください。
---
スプレッドシートの情報:
${input.knowledge}
---`,
		contents: [
			...history,
			{
				role: "user",
				parts: [{ text: `質問: ${input.question}` }],
			},
		],
	};
}

export function buildThinkingSummaryPrompt(thinkingText: string): GeminiPrompt {
	return {
		systemInstruction:
			"AIの思考過程を日本語の1文（50文字以内）に要約し、要約文だけを出力してください。",
		contents: [
			{
				role: "user",
				parts: [{ text: thinkingText }],
			},
		],
	};
}
