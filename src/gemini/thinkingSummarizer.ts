import {
	getExternalErrorLogContext,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { buildThinkingSummaryPrompt } from "./promptBuilder";
import type { GeminiUsage, IGeminiGateway } from "./types";

export const THINKING_FALLBACK = "考え中...";

export type ThinkingSummaryResult = {
	text: string;
	usage: GeminiUsage | null;
	success: boolean;
};

export class ThinkingSummarizer {
	constructor(
		private readonly gateway: IGeminiGateway,
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
			if (summary) {
				return { text: summary, usage: result.usage, success: true };
			}
			this.log.warn("Empty summarization result, using fallback");
		} catch (error) {
			const normalized = normalizeExternalServiceError(error, {
				service: "gemini",
				operation: "summarize thinking",
				userMessage: "思考要約の生成に失敗しました。",
			});
			this.log.warn("Thinking summarization failed (non-fatal)", {
				...getExternalErrorLogContext(normalized),
			});
		}
		return { text: THINKING_FALLBACK, usage: null, success: false };
	}
}

export function createThinkingSummarizer(
	gateway: IGeminiGateway,
	model: string,
	log?: Logger,
): ThinkingSummarizer {
	return new ThinkingSummarizer(gateway, model, log);
}
