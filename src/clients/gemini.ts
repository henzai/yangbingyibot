import { GoogleGenAI } from '@google/genai';

export class GeminiClient {
	private client: GoogleGenAI;
	private history: { role: string; text: string }[];

	constructor(apiKey: string, initialHistory: { role: string; text: string }[] = []) {
		this.client = new GoogleGenAI({ apiKey });
		this.history = initialHistory;
	}

	async ask(input: string, sheet: string, description: string) {
		// Create the full prompt with context and history
		const systemPrompt = getPrompt(sheet, description);
		const historyText = this.history.map((h) => `${h.role}: ${h.text}`).join('\n');

		const fullPrompt = `${systemPrompt}

${historyText ? `会話履歴:\n${historyText}\n\n` : ''}質問: ${input}`;

		const result = await this.client.models.generateContent({
			model: 'gemini-3-flash-preview',
			contents: fullPrompt,
			config: generationConfig,
		});

		if (
			!result.candidates ||
			!result.candidates[0] ||
			!result.candidates[0].content ||
			!result.candidates[0].content.parts ||
			!result.candidates[0].content.parts[0]
		) {
			throw new Error('Invalid response from Gemini API');
		}

		const response = result.candidates[0].content.parts[0].text;

		if (!response) {
			throw new Error('No text response from Gemini API');
		}

		// Add the user's message and assistant's response to history
		this.history.push({
			role: 'user',
			text: `質問: ${input}`,
		});
		this.history.push({
			role: 'model',
			text: response,
		});

		return response;
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
