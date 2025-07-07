import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, Content } from '@google/generative-ai';

export class GeminiClient {
	private llm: GoogleGenerativeAI;
	private history: Content[];

	constructor(apiKey: string, initialHistory: { role: string; text: string }[] = []) {
		this.llm = new GoogleGenerativeAI(apiKey);
		this.history = initialHistory.map((h) => ({
			role: h.role,
			parts: [{ text: h.text }],
		}));
	}

	async ask(input: string, sheet: string, description: string) {
		const model = this.llm.getGenerativeModel({
			model: 'gemini-2.0-pro',
		});

		const chatSession = model.startChat({
			generationConfig,
			safetySettings,
			history: [
				{
					role: 'user',
					parts: [{ text: getPrompt(sheet, description) }],
				},
				...this.history,
			],
		});

		const result = await chatSession.sendMessage(`質問: ${input}`);
		const response = result.response.text();

		// Add the user's message and assistant's response to history
		this.history.push({
			role: 'user',
			parts: [{ text: `質問: ${input}` }],
		});
		this.history.push({
			role: 'model',
			parts: [{ text: response }],
		});

		return response;
	}

	getHistory(): { role: string; text: string }[] {
		return this.history.map((content) => ({
			role: content.role,
			text: content.parts[0].text || '',
		}));
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

const safetySettings = [
	{
		category: HarmCategory.HARM_CATEGORY_HARASSMENT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
];

const getPrompt = (sheet: string, description: string) => {
	return `
${description}
---
スプレッドシートの情報:
${sheet}
---
`;
};
