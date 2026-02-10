import { type GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

export class GeminiClient {
	private client: GoogleGenAI;
	private history: { role: string; text: string }[];
	private log: Logger;

	constructor(
		apiKey: string,
		initialHistory: { role: string; text: string }[] = [],
		log?: Logger,
	) {
		this.client = new GoogleGenAI({ apiKey });
		this.history = initialHistory;
		this.log = log ?? defaultLogger;
	}

	async ask(
		input: string,
		sheet: string,
		description: string,
	): Promise<string> {
		try {
			// Create the full prompt with context and history
			const systemPrompt = getPrompt(sheet, description);
			const historyText = this.history
				.map((h) => `${h.role}: ${h.text}`)
				.join("\n");

			const fullPrompt = `${systemPrompt}

${historyText ? `会話履歴:\n${historyText}\n\n` : ""}質問: ${input}`;

			let result: GenerateContentResponse;
			try {
				// Add retry logic with exponential backoff
				this.log.info("Gemini API request starting");
				const startTime = Date.now();
				result = await withRetry(
					async () => {
						return await this.client.models.generateContent({
							model: "gemini-3-flash-preview",
							contents: fullPrompt,
							config: generationConfig,
						});
					},
					{
						maxAttempts: 2,
						initialDelayMs: 500,
						maxDelayMs: 2000,
					},
					// Only retry on transient errors
					(error) => {
						const msg = error.message.toLowerCase();
						// Retry rate limits, network errors, and server errors
						return (
							msg.includes("quota") ||
							msg.includes("rate limit") ||
							msg.includes("network") ||
							msg.includes("timeout") ||
							msg.includes("500") ||
							msg.includes("503")
						);
					},
					this.log,
				);
				this.log.info("Gemini API completed", {
					durationMs: Date.now() - startTime,
				});
			} catch (error) {
				this.log.error("Gemini API request failed", {
					error: error instanceof Error ? error.message : "Unknown error",
				});

				// Check for specific error types
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

			// Add to history
			this.history.push({
				role: "user",
				text: `質問: ${input}`,
			});
			this.history.push({
				role: "model",
				text: response,
			});

			return response;
		} catch (error) {
			// Preserve user-friendly errors
			if (
				error instanceof Error &&
				(error.message.includes("API") || error.message.includes("AI"))
			) {
				throw error;
			}

			this.log.error("Unexpected error in Gemini client", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			throw new Error("AI処理中に予期しないエラーが発生しました。");
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
			const systemPrompt = getPrompt(sheet, description);
			const historyText = this.history
				.map((h) => `${h.role}: ${h.text}`)
				.join("\n");

			const fullPrompt = `${systemPrompt}

${historyText ? `会話履歴:\n${historyText}\n\n` : ""}質問: ${input}`;

			let fullText = "";

			try {
				this.log.info("Gemini streaming API request starting");
				const startTime = Date.now();

				const stream = await withRetry(
					async () => {
						return await this.client.models.generateContentStream({
							model: "gemini-3-flash-preview",
							contents: fullPrompt,
							config: streamGenerationConfig,
						});
					},
					{
						maxAttempts: 2,
						initialDelayMs: 500,
						maxDelayMs: 2000,
					},
					(error) => {
						const msg = error.message.toLowerCase();
						return (
							msg.includes("quota") ||
							msg.includes("rate limit") ||
							msg.includes("network") ||
							msg.includes("timeout") ||
							msg.includes("500") ||
							msg.includes("503")
						);
					},
					this.log,
				);

				for await (const chunk of stream) {
					const chunkText = chunk.text;
					if (chunkText) {
						fullText += chunkText;
						// Check if this chunk is a thought or response
						const phase: "thinking" | "response" =
							chunk.parts?.[0]?.thought === true ? "thinking" : "response";
						await onChunk(fullText, phase);
					}
				}

				this.log.info("Gemini streaming API completed", {
					durationMs: Date.now() - startTime,
				});
			} catch (error) {
				this.log.error("Gemini streaming API request failed", {
					error: error instanceof Error ? error.message : "Unknown error",
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

			if (!fullText || !fullText.trim()) {
				this.log.error("Empty text from Gemini streaming response");
				throw new Error("AIから有効な応答が得られませんでした。");
			}

			// Add to history only after stream completes successfully
			this.history.push({
				role: "user",
				text: `質問: ${input}`,
			});
			this.history.push({
				role: "model",
				text: fullText,
			});

			return fullText;
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes("API") || error.message.includes("AI"))
			) {
				throw error;
			}

			this.log.error("Unexpected error in Gemini streaming client", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
			throw new Error("AI処理中に予期しないエラーが発生しました。");
		}
	}

	getHistory(): { role: string; text: string }[] {
		return this.history;
	}
}

export const createGeminiClient = (
	apiKey: string,
	initialHistory: { role: string; text: string }[] = [],
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
	temperature: 1,
	topP: 0.95,
	topK: 40,
	maxOutputTokens: 8192,
	responseMimeType: "text/plain",
	thinkingConfig: {
		includeThoughts: true,
	},
};

const getPrompt = (sheet: string, description: string) => {
	return `
${description}
---
スプレッドシートの情報:
${sheet}
---
思考過程は必ず日本語で行ってください。
`;
};
