import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

export class GeminiClient {
	private llm: GoogleGenerativeAI;

	constructor(apiKey: string) {
		this.llm = new GoogleGenerativeAI(apiKey);
	}

	async ask(input: string, sheet: string, description: string) {
		const model = this.llm.getGenerativeModel({
			model: 'gemini-2.0-flash',
		});

		const chatSession = model.startChat({
			generationConfig,
			safetySettings,
			history: [
				{
					role: 'user',
					parts: [
						{
							text: getPrompt(sheet, description),
						},
					],
				},
			],
		});

		const result = await chatSession.sendMessage(`質問: ${input}`);
		return result.response.text();
	}
}

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
