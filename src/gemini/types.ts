export type GeminiContent = {
	role: "user" | "model";
	parts: Array<{ text: string }>;
};

export type GeminiPrompt = {
	systemInstruction: string;
	contents: GeminiContent[];
};

export type GeminiUsage = {
	promptTokens: number;
	cachedTokens: number;
	thoughtsTokens: number;
	candidatesTokens: number;
	totalTokens: number;
};

export type GeminiStreamEvent =
	| {
			type: "thinking";
			delta: string;
	  }
	| {
			type: "response";
			delta: string;
			accumulated: string;
	  }
	| {
			type: "usage";
			usage: GeminiUsage;
	  };

export type GeminiStreamRequest = {
	model: string;
	prompt: GeminiPrompt;
};

export type GeminiTextRequest = {
	model: string;
	prompt: GeminiPrompt;
	temperature?: number;
	maxOutputTokens?: number;
};

export type GeminiTextResult = {
	text: string;
	usage: GeminiUsage | null;
};

export interface IGeminiGateway {
	generateStream(
		request: GeminiStreamRequest,
	): AsyncIterable<GeminiStreamEvent>;
	generateText(request: GeminiTextRequest): Promise<GeminiTextResult>;
}
