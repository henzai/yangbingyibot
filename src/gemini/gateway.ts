import {
	type GenerateContentResponseUsageMetadata,
	GoogleGenAI,
	ThinkingLevel,
} from "@google/genai";
import {
	ExternalServiceError,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import type {
	GeminiStreamEvent,
	GeminiStreamRequest,
	GeminiTextRequest,
	GeminiTextResult,
	GeminiUsage,
	IGeminiGateway,
} from "./types";

const ANSWER_GENERATION_CONFIG = {
	maxOutputTokens: 8192,
	responseMimeType: "text/plain",
	thinkingConfig: {
		includeThoughts: true,
		thinkingLevel: ThinkingLevel.MINIMAL,
	},
};

const RETRY_CONFIG = {
	maxAttempts: 2,
	initialDelayMs: 500,
	maxDelayMs: 2000,
};

function toUsage(
	usage: GenerateContentResponseUsageMetadata | undefined,
): GeminiUsage | null {
	if (!usage) {
		return null;
	}
	return {
		promptTokens: usage.promptTokenCount ?? 0,
		cachedTokens: usage.cachedContentTokenCount ?? 0,
		thoughtsTokens: usage.thoughtsTokenCount ?? 0,
		candidatesTokens: usage.candidatesTokenCount ?? 0,
		totalTokens: usage.totalTokenCount ?? 0,
	};
}

export class GeminiGateway implements IGeminiGateway {
	private readonly client: GoogleGenAI;
	private readonly log: Logger;

	constructor(apiKey: string, log?: Logger) {
		this.client = new GoogleGenAI({ apiKey });
		this.log = log ?? defaultLogger;
	}

	private userMessageForStatus(status: number | undefined): string {
		if (status === 429) {
			return "API使用制限に達しました。しばらく待ってから再度お試しください。";
		}
		if (status === 401 || status === 403) {
			return "API認証エラーが発生しました。";
		}
		return "AI APIへのリクエストに失敗しました。";
	}

	private normalizeError(
		error: unknown,
		operation: string,
	): ExternalServiceError {
		const normalized = normalizeExternalServiceError(error, {
			service: "gemini",
			operation,
			userMessage: "AI APIへのリクエストに失敗しました。",
		});
		if (normalized.service !== "gemini") {
			return normalized;
		}
		return new ExternalServiceError({
			service: normalized.service,
			operation: normalized.operation,
			status: normalized.status,
			retryable: normalized.retryable,
			userMessage: this.userMessageForStatus(normalized.status),
			retryAfterMs: normalized.retryAfterMs,
			cause: normalized.cause,
		});
	}

	private async executeRequest<T>(
		operation: string,
		request: () => Promise<T>,
	): Promise<T> {
		return withRetry(
			async () => {
				try {
					return await request();
				} catch (error) {
					throw this.normalizeError(error, operation);
				}
			},
			RETRY_CONFIG,
			undefined,
			this.log,
		);
	}

	async *generateStream(
		request: GeminiStreamRequest,
	): AsyncIterable<GeminiStreamEvent> {
		this.log.info("Gemini streaming API request starting", {
			model: request.model,
		});
		const startTime = Date.now();

		const stream = await this.executeRequest(
			"start content stream",
			async () =>
				await this.client.models.generateContentStream({
					model: request.model,
					contents: request.prompt.contents,
					config: {
						...ANSWER_GENERATION_CONFIG,
						systemInstruction: request.prompt.systemInstruction,
					},
				}),
		);

		let accumulated = "";
		let latestUsage: GeminiUsage | null = null;
		try {
			for await (const chunk of stream) {
				const usage = toUsage(chunk.usageMetadata);
				if (usage) {
					latestUsage = usage;
				}

				for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
					if (typeof part.text !== "string" || part.text.length === 0) {
						continue;
					}
					if (part.thought) {
						yield { type: "thinking", delta: part.text };
						continue;
					}
					accumulated += part.text;
					yield {
						type: "response",
						delta: part.text,
						accumulated,
					};
				}
			}
		} catch (error) {
			throw this.normalizeError(error, "consume content stream");
		}

		if (latestUsage) {
			yield { type: "usage", usage: latestUsage };
		} else {
			this.log.warn("Gemini usage metadata missing", { mode: "stream" });
		}
		this.log.info("Gemini streaming API completed", {
			model: request.model,
			durationMs: Date.now() - startTime,
		});
	}

	async generateText(request: GeminiTextRequest): Promise<GeminiTextResult> {
		this.log.info("Gemini text API request starting", {
			model: request.model,
		});
		const startTime = Date.now();
		const result = await this.executeRequest(
			"generate text",
			async () =>
				await this.client.models.generateContent({
					model: request.model,
					contents: request.prompt.contents,
					config: {
						systemInstruction: request.prompt.systemInstruction,
						temperature: request.temperature,
						maxOutputTokens: request.maxOutputTokens,
					},
				}),
		);
		this.log.info("Gemini text API completed", {
			model: request.model,
			durationMs: Date.now() - startTime,
		});

		const text =
			result.candidates?.[0]?.content?.parts
				?.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join("") ?? "";
		const usage = toUsage(result.usageMetadata);
		if (!usage) {
			this.log.warn("Gemini usage metadata missing", { mode: "generate" });
		}
		return { text, usage };
	}
}

export function createGeminiGateway(
	apiKey: string,
	log?: Logger,
): GeminiGateway {
	return new GeminiGateway(apiKey, log);
}
