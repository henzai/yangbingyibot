import {
	type GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	GoogleGenAI,
} from "@google/genai";
import { DEFAULT_RUNTIME_CONFIG } from "../config";
import type { HistoryEntry } from "../contracts";
import {
	ExternalServiceError,
	getExternalErrorLogContext,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

export class GeminiClient {
	private client: GoogleGenAI;
	private history: HistoryEntry[];
	private log: Logger;
	private modelName: string;

	private readonly RETRY_CONFIG = {
		maxAttempts: 2,
		initialDelayMs: 500,
		maxDelayMs: 2000,
	};

	constructor(
		apiKey: string,
		initialHistory: HistoryEntry[] = [],
		log?: Logger,
		modelName: string = DEFAULT_RUNTIME_CONFIG.geminiModel,
	) {
		this.client = new GoogleGenAI({ apiKey });
		this.history = initialHistory;
		this.log = log ?? defaultLogger;
		this.modelName = modelName;
	}

	private buildPrompt(
		input: string,
		sheet: string,
		description: string,
	): string {
		const systemPrompt = getPrompt(sheet, description);
		const historyText = this.history
			.map((h) => `${h.role}: ${h.text}`)
			.join("\n");

		return `${systemPrompt}

${historyText ? `会話履歴:\n${historyText}\n\n` : ""}質問: ${input}`;
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

	private normalizeGeminiError(
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
					throw this.normalizeGeminiError(error, operation);
				}
			},
			this.RETRY_CONFIG,
			undefined,
			this.log,
		);
	}

	private handleUnexpectedError(error: unknown, context: string): never {
		if (error instanceof ExternalServiceError) {
			throw error;
		}

		const normalized = normalizeExternalServiceError(error, {
			service: "gemini",
			operation: context,
			retryable: false,
			userMessage: "AI処理中に予期しないエラーが発生しました。",
		});
		this.log.error("Unexpected Gemini client error", {
			context,
			...getExternalErrorLogContext(normalized),
		});
		throw normalized;
	}

	// トークン使用量を記録する。入力トークンがコストの大半を占めるため、
	// 内訳とキャッシュのヒット率を追えるようにしておく。
	private logUsage(
		usage: GenerateContentResponseUsageMetadata | undefined,
		mode: "generate" | "stream",
	): void {
		if (!usage) {
			this.log.warn("Gemini usage metadata missing", { mode });
			return;
		}

		const promptTokens = usage.promptTokenCount ?? 0;
		const cachedTokens = usage.cachedContentTokenCount ?? 0;

		this.log.info("Gemini token usage", {
			mode,
			model: this.modelName,
			promptTokens,
			cachedTokens,
			// 暗黙キャッシュが効いているかはこの比率で判断する
			cachedRatio:
				promptTokens > 0
					? Number((cachedTokens / promptTokens).toFixed(3))
					: null,
			thoughtsTokens: usage.thoughtsTokenCount ?? 0,
			candidatesTokens: usage.candidatesTokenCount ?? 0,
			totalTokens: usage.totalTokenCount ?? 0,
		});
	}

	private addToHistory(input: string, response: string): void {
		this.history.push({
			role: "user",
			text: `質問: ${input}`,
		});
		this.history.push({
			role: "model",
			text: response,
		});
	}

	async ask(
		input: string,
		sheet: string,
		description: string,
	): Promise<string> {
		try {
			const fullPrompt = this.buildPrompt(input, sheet, description);

			this.log.info("Gemini API request starting");
			const startTime = Date.now();
			const result: GenerateContentResponse = await this.executeRequest(
				"generate content",
				async () => {
					return await this.client.models.generateContent({
						model: this.modelName,
						contents: fullPrompt,
						config: generationConfig,
					});
				},
			);
			this.log.info("Gemini API completed", {
				durationMs: Date.now() - startTime,
			});
			this.logUsage(result.usageMetadata, "generate");

			// Validate response structure
			if (!result.candidates?.[0]?.content?.parts?.[0]) {
				const error = new ExternalServiceError({
					service: "gemini",
					operation: "validate response",
					retryable: false,
					userMessage: "AIからの応答形式が不正です。",
				});
				this.log.error("Invalid Gemini response structure", {
					...getExternalErrorLogContext(error),
				});
				throw error;
			}

			const response = result.candidates[0].content.parts[0].text;

			if (!response || typeof response !== "string" || !response.trim()) {
				throw new ExternalServiceError({
					service: "gemini",
					operation: "validate response text",
					retryable: false,
					userMessage: "AIから有効な応答が得られませんでした。",
				});
			}

			this.addToHistory(input, response);

			return response;
		} catch (error) {
			this.handleUnexpectedError(error, "Gemini client");
		}
	}

	async askStream(
		input: string,
		sheet: string,
		description: string,
		onChunk: (
			accumulatedText: string,
			phase: "thinking" | "response",
		) => Promise<void>,
	): Promise<string> {
		try {
			const fullPrompt = this.buildPrompt(input, sheet, description);

			let fullText = "";
			let usage: GenerateContentResponseUsageMetadata | undefined;

			this.log.info("Gemini streaming API request starting");
			const startTime = Date.now();

			const stream = await this.executeRequest(
				"start content stream",
				async () => {
					return await this.client.models.generateContentStream({
						model: this.modelName,
						contents: fullPrompt,
						config: streamGenerationConfig,
					});
				},
			);

			try {
				for await (const chunk of stream) {
					// ストリーミングでは使用量は終盤のチャンクに載るため、最後の値を採用する
					if (chunk.usageMetadata) {
						usage = chunk.usageMetadata;
					}

					const parts = chunk.candidates?.[0]?.content?.parts ?? [];
					for (const part of parts) {
						if (typeof part.text !== "string") {
							continue;
						}
						if (part.thought) {
							await onChunk(part.text, "thinking");
						} else {
							fullText += part.text;
							await onChunk(fullText, "response");
						}
					}
				}

				this.log.info("Gemini streaming API completed", {
					durationMs: Date.now() - startTime,
				});
				this.logUsage(usage, "stream");
			} catch (error) {
				throw this.normalizeGeminiError(error, "consume content stream");
			}

			if (!fullText?.trim()) {
				throw new ExternalServiceError({
					service: "gemini",
					operation: "validate streamed response",
					retryable: false,
					userMessage: "AIから有効な応答が得られませんでした。",
				});
			}

			this.addToHistory(input, fullText);

			return fullText;
		} catch (error) {
			this.handleUnexpectedError(error, "Gemini streaming client");
		}
	}

	getHistory(): HistoryEntry[] {
		return this.history;
	}
}

export const createGeminiClient = (
	apiKey: string,
	initialHistory: HistoryEntry[] = [],
	log?: Logger,
	modelName: string = DEFAULT_RUNTIME_CONFIG.geminiModel,
): GeminiClient => {
	return new GeminiClient(apiKey, initialHistory, log, modelName);
};

const generationConfig = {
	temperature: 1,
	topP: 0.95,
	topK: 40,
	maxOutputTokens: 8192,
	responseMimeType: "text/plain",
};

const streamGenerationConfig = {
	...generationConfig,
	thinkingConfig: {
		includeThoughts: true,
	},
};

const getPrompt = (sheet: string, description: string) => {
	return `
${description}
思考過程は必ず日本語で行ってください。
---
スプレッドシートの情報:
${sheet}
---
`;
};
