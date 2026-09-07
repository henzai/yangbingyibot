import { getExternalErrorLogContext } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { normalizeLlmError } from "./errors";
import { buildThinkingSummaryPrompt } from "./promptBuilder";
import type { ILlmGateway, LlmUsage } from "./types";

export const THINKING_FALLBACK = "考え中...";

export type ThinkingSummaryResult = {
	text: string;
	usage: LlmUsage | null;
	success: boolean;
};

export class ThinkingSummarizer {
	constructor(
		private readonly gateway: ILlmGateway,
		private readonly model: string,
		private readonly log: Logger = defaultLogger,
	) {}

	async summarize(
		previousSummary: string,
		newThinking: string,
	): Promise<ThinkingSummaryResult> {
		try {
			const result = await this.gateway.generateText({
				model: this.model,
				prompt: buildThinkingSummaryPrompt(previousSummary, newThinking),
				temperature: 0,
				maxOutputTokens: 128,
			});
			const summary = result.text.trim();
			if (
				summary &&
				result.finish.reason !== "blocked" &&
				result.finish.reason !== "error" &&
				result.finish.reason !== "length"
			) {
				return { text: summary, usage: result.usage, success: true };
			}
			this.log.warn("Empty or incomplete summarization result, using fallback");
			return { text: THINKING_FALLBACK, usage: result.usage, success: false };
		} catch (error) {
			const normalized = normalizeLlmError(
				error,
				this.gateway.provider,
				"summarize thinking",
			);
			this.log.warn("Thinking summarization failed (non-fatal)", {
				...getExternalErrorLogContext(normalized),
			});
		}
		return { text: THINKING_FALLBACK, usage: null, success: false };
	}
}

export function createThinkingSummarizer(
	gateway: ILlmGateway,
	model: string,
	log?: Logger,
): ThinkingSummarizer {
	return new ThinkingSummarizer(gateway, model, log);
}
