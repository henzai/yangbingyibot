import {
	type GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	GoogleGenAI,
} from "@google/genai";
import type { HistoryEntry } from "../types";
import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

export class GeminiClient {
	private static readonly MODEL_NAME = "gemini-3-flash-preview";

	private client: GoogleGenAI;
	private history: HistoryEntry[];
	private log: Logger;

	private readonly RETRY_CONFIG = {
		maxAttempts: 2,
		initialDelayMs: 500,
		maxDelayMs: 2000,
	};

	constructor(
		apiKey: string,
		initialHistory: HistoryEntry[] = [],
		log?: Logger,
	) {
		this.client = new GoogleGenAI({ apiKey });
		this.history = initialHistory;
		this.log = log ?? defaultLogger;
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

	private isRetryableError(error: Error): boolean {
		const msg = error.message.toLowerCase();
		return (
			msg.includes("quota") ||
			msg.includes("rate limit") ||
			msg.includes("network") ||
			msg.includes("timeout") ||
			msg.includes("500") ||
			msg.includes("503")
		);
	}

	private handleGeminiError(error: unknown): never {
		this.log.error("Gemini API request failed", {
			error: getErrorMessage(error),
		});

		if (error instanceof Error) {
			if (
				error.message.includes("quota") ||
				error.message.includes("rate limit")
			) {
				throw new Error(
					"API使用制限に達しました。しばらく待ってから再度お試しください。",
				);
			}
			if (
				error.message.includes("invalid") ||
				error.message.includes("API key")
			) {
				throw new Error("API認証エラーが発生しました。");
			}
		}

		throw new Error("AI APIへのリクエストに失敗しました。");
	}

	private handleUnexpectedError(error: unknown, context: string): never {
		if (
			error instanceof Error &&
			(error.message.includes("API") || error.message.includes("AI"))
		) {
			throw error;
		}

		this.log.error(`Unexpected error in ${context}`, {
			error: getErrorMessage(error),
		});
		throw new Error("AI処理中に予期しないエラーが発生しました。");
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
			model: GeminiClient.MODEL_NAME,
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

			let result: GenerateContentResponse;
			try {
				// Add retry logic with exponential backoff
				this.log.info("Gemini API request starting");
				const startTime = Date.now();
				result = await withRetry(
					async () => {
						return await this.client.models.generateContent({
							model: GeminiClient.MODEL_NAME,
							contents: fullPrompt,
							config: generationConfig,
						});
					},
					this.RETRY_CONFIG,
					this.isRetryableError,
					this.log,
				);
				this.log.info("Gemini API completed", {
					durationMs: Date.now() - startTime,
				});
				this.logUsage(result.usageMetadata, "generate");
			} catch (error) {
				this.handleGeminiError(error);
			}

			// Validate response structure
			if (
				!result.candidates ||
				!result.candidates[0] ||
				!result.candidates[0].content ||
				!result.candidates[0].content.parts ||
				!result.candidates[0].content.parts[0]
			) {
				this.log.error("Invalid Gemini response structure", {
					result: JSON.stringify(result),
				});
				throw new Error("AIからの応答形式が不正です。");
			}

			const response = result.candidates[0].content.parts[0].text;

			if (!response || typeof response !== "string" || !response.trim()) {
				this.log.error("Empty or invalid text in Gemini response");
				throw new Error("AIから有効な応答が得られませんでした。");
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

			try {
				this.log.info("Gemini streaming API request starting");
				const startTime = Date.now();

				const stream = await withRetry(
					async () => {
						return await this.client.models.generateContentStream({
							model: GeminiClient.MODEL_NAME,
							contents: fullPrompt,
							config: streamGenerationConfig,
						});
					},
					this.RETRY_CONFIG,
					this.isRetryableError,
					this.log,
				);

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
				this.handleGeminiError(error);
			}

			if (!fullText || !fullText.trim()) {
				this.log.error("Empty text from Gemini streaming response");
				throw new Error("AIから有効な応答が得られませんでした。");
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
): GeminiClient => {
	return new GeminiClient(apiKey, initialHistory, log);
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
