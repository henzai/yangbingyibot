import { GeminiLlmGateway } from "../llm/providers/gemini";
import type { LlmPrompt, LlmUsage } from "../llm/types";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type {
	GeminiPrompt,
	GeminiStreamEvent,
	GeminiStreamRequest,
	GeminiTextRequest,
	GeminiTextResult,
	GeminiUsage,
	IGeminiGateway,
} from "./types";

function fromLegacyPrompt(prompt: GeminiPrompt): LlmPrompt {
	return {
		systemInstruction: prompt.systemInstruction,
		messages: prompt.contents.map(({ role, parts }) => ({
			role: role === "model" ? "assistant" : "user",
			text: parts.map((part) => part.text).join(""),
		})),
	};
}

/** Keep the existing metrics schema until the provider-aware metrics migration. */
function toLegacyUsage(usage: LlmUsage | null): GeminiUsage | null {
	return (
		usage && {
			promptTokens: usage.inputTokens ?? 0,
			cachedTokens: usage.cachedInputTokens ?? 0,
			thoughtsTokens: usage.reasoningTokens ?? 0,
			candidatesTokens: usage.outputTokens ?? 0,
			totalTokens: usage.totalTokens ?? 0,
		}
	);
}

function toLegacyError(error: unknown): unknown {
	if (!(error instanceof ExternalServiceError) || error.service !== "llm")
		return error;
	return new ExternalServiceError({
		service: "gemini",
		provider: error.provider,
		kind: error.kind,
		operation: error.operation,
		status: error.status,
		retryable: error.retryable,
		retryAfterMs: error.retryAfterMs,
		userMessage: error.userMessage,
		cause: error,
	});
}

/** Temporary facade for the existing Workflow/coordinator and metrics contract. */
export class GeminiGateway implements IGeminiGateway {
	private readonly gateway: GeminiLlmGateway;
	constructor(apiKey: string, log?: Logger) {
		this.gateway = new GeminiLlmGateway(apiKey, log);
	}

	async *generateStream(
		request: GeminiStreamRequest,
	): AsyncIterable<GeminiStreamEvent> {
		let accumulated = "";
		try {
			for await (const event of this.gateway.generateStream({
				...request,
				prompt: fromLegacyPrompt(request.prompt),
				includeReasoningSummary: true,
			})) {
				switch (event.type) {
					case "text":
						accumulated += event.delta;
						yield { type: "response", delta: event.delta, accumulated };
						break;
					case "reasoning_summary":
						yield { type: "thinking", delta: event.delta };
						break;
					case "usage": {
						const usage = toLegacyUsage(event.usage);
						if (usage) yield { type: "usage", usage };
						break;
					}
					case "finish":
						yield {
							type: "finish",
							finishReason: event.finish.providerFinishReason,
							blockReason: event.finish.providerBlockReason,
						};
				}
			}
		} catch (error) {
			throw toLegacyError(error);
		}
	}

	async generateText(request: GeminiTextRequest): Promise<GeminiTextResult> {
		try {
			const result = await this.gateway.generateText({
				...request,
				prompt: fromLegacyPrompt(request.prompt),
			});
			return { text: result.text, usage: toLegacyUsage(result.usage) };
		} catch (error) {
			throw toLegacyError(error);
		}
	}
}

export function createGeminiGateway(
	apiKey: string,
	log?: Logger,
): GeminiGateway {
	return new GeminiGateway(apiKey, log);
}
