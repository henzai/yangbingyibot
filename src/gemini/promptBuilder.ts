import type { HistoryEntry } from "../contracts";
import {
	buildAnswerPrompt as buildLlmAnswerPrompt,
	buildThinkingSummaryPrompt as buildLlmThinkingSummaryPrompt,
} from "../llm/promptBuilder";
import { toGeminiPrompt } from "../llm/providers/geminiPrompt";
import type { GeminiPrompt } from "./types";

export type AnswerPromptInput = {
	description: string;
	knowledge: string;
	history: HistoryEntry[];
	question: string;
};

/** Keep the old prompt shape until Workflow and history migrate in #430. */
export function buildAnswerPrompt(input: AnswerPromptInput): GeminiPrompt {
	return toGeminiPrompt(
		buildLlmAnswerPrompt({
			...input,
			history: input.history.map(({ role, text }) => ({
				role: role === "model" ? "assistant" : "user",
				text,
			})),
		}),
		true,
	);
}

export function buildThinkingSummaryPrompt(
	previousSummary: string,
	newThinking: string,
): GeminiPrompt {
	return toGeminiPrompt(
		buildLlmThinkingSummaryPrompt(previousSummary, newThinking),
	);
}
