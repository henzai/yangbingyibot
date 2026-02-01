import { GoogleGenAI } from '@google/genai';
import { withRetry } from '../utils/retry';

export class GeminiClient {
	private client: GoogleGenAI;
	private history: { role: string; text: string }[];

	constructor(apiKey: string, initialHistory: { role: string; text: string }[] = []) {
		this.client = new GoogleGenAI({ apiKey });
		this.history = initialHistory;
	}

	async ask(input: string, sheet: string, description: string): Promise<string> {
		try {
			// Create the full prompt with context and history
			const systemPrompt = getPrompt(sheet, description);
			const historyText = this.history.map((h) => `${h.role}: ${h.text}`).join('\n');

			const fullPrompt = `${systemPrompt}

${historyText ? `会話履歴:\n${historyText}\n\n` : ''}質問: ${input}`;

			let result;
			try {
				// Add retry logic with exponential backoff
				result = await withRetry(
					async () => {
						return await this.client.models.generateContent({
							model: 'gemini-3-flash-preview',
							contents: fullPrompt,
							config: generationConfig,
						});
					},
					{
						maxAttempts: 3,
						initialDelayMs: 1000,
						maxDelayMs: 8000,
					},
					// Only retry on transient errors
					(error) => {
						const msg = error.message.toLowerCase();
						// Retry rate limits, network errors, and server errors
						return (
							msg.includes('quota') ||
							msg.includes('rate limit') ||
							msg.includes('network') ||
							msg.includes('timeout') ||
							msg.includes('500') ||
							msg.includes('503')
						);
					}
				);
			} catch (error) {
				console.error('Gemini API request failed:', error);

				// Check for specific error types
				if (error instanceof Error) {
					if (error.message.includes('quota') || error.message.includes('rate limit')) {
						throw new Error('API使用制限に達しました。しばらく待ってから再度お試しください。');
					}
					if (error.message.includes('invalid') || error.message.includes('API key')) {
						throw new Error('API認証エラーが発生しました。');
					}
				}

				throw new Error('AI APIへのリクエストに失敗しました。');
			}

			// Validate response structure
			if (
				!result.candidates ||
				!result.candidates[0] ||
				!result.candidates[0].content ||
				!result.candidates[0].content.parts ||
				!result.candidates[0].content.parts[0]
			) {
				console.error('Invalid Gemini response structure:', JSON.stringify(result));
				throw new Error('AIからの応答形式が不正です。');
			}

			const response = result.candidates[0].content.parts[0].text;

			if (!response || typeof response !== 'string' || !response.trim()) {
				console.error('Empty or invalid text in Gemini response');
				throw new Error('AIから有効な応答が得られませんでした。');
			}

			// Add to history
			this.history.push({
				role: 'user',
				text: `質問: ${input}`,
			});
			this.history.push({
				role: 'model',
				text: response,
			});

			return response;
		} catch (error) {
			// Preserve user-friendly errors
			if (error instanceof Error && (error.message.includes('API') || error.message.includes('AI'))) {
				throw error;
			}

			console.error('Unexpected error in Gemini client:', error);
			throw new Error('AI処理中に予期しないエラーが発生しました。');
		}
	}

	getHistory(): { role: string; text: string }[] {
		return this.history;
	}

	clearHistory() {
		this.history = [];
	}
}

export const createGeminiClient = (apiKey: string, initialHistory: { role: string; text: string }[] = []): GeminiClient => {
	return new GeminiClient(apiKey, initialHistory);
};

const generationConfig = {
	temperature: 1,
	topP: 0.95,
	topK: 40,
	maxOutputTokens: 8192,
	responseMimeType: 'text/plain',
};

const getPrompt = (sheet: string, description: string) => {
	return `
${description}
---
スプレッドシートの情報:
${sheet}
---
`;
};
