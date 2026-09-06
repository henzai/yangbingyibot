/** Text-only application contracts. Provider SDK types belong in adapters. */
export type LlmMessage = {
	role: "user" | "assistant";
	text: string;
};

export type LlmPrompt = {
	systemInstruction: string;
	/** Knowledge supplied by the application, kept separate from instructions. */
	context?: string;
	messages: readonly LlmMessage[];
};

/**
 * A cumulative snapshot for ONE generation, never a delta to add per chunk.
 * null means unavailable, including when only some fields were reported.
 * inputTokens includes cachedInputTokens; outputTokens EXCLUDES reasoningTokens.
 * totalTokens is the provider's reported total, not a sum of possibly missing fields.
 */
export type LlmUsage = {
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
};

export type LlmFinish = {
	/** unknown includes streams that ended without a provider finish marker. */
	reason: "stop" | "length" | "blocked" | "error" | "unknown";
	/** Diagnostic codes only, never provider response bodies. */
	providerFinishReason?: string;
	providerBlockReason?: string;
};

export type LlmStreamEvent =
	| { type: "text"; delta: string }
	/** Only provider-published summaries, not private chain-of-thought. */
	| { type: "reasoning_summary"; delta: string }
	| { type: "usage"; usage: LlmUsage }
	| { type: "finish"; finish: LlmFinish };

export type LlmRequest = {
	model: string;
	prompt: LlmPrompt;
	temperature?: number;
	maxOutputTokens?: number;
	/** Optional, best effort; callers must work without summary events. */
	includeReasoningSummary?: boolean;
	/** Total budget including retries and streaming; capped by the adapter. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type LlmTextResult = {
	text: string;
	usage: LlmUsage | null;
	finish: LlmFinish;
};

export interface ILlmGateway {
	readonly provider: string;
	/** Adapter support does not guarantee that every selected model emits it. */
	readonly capabilities: { readonly reasoningSummary: boolean };
	/**
	 * Exactly one finish event on normal exhaustion, after any usage snapshots.
	 * Transport failures throw; partial text must not be treated as completed.
	 * Never automatically replay a stream once consumption has begun.
	 */
	generateStream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
	generateText(request: LlmRequest): Promise<LlmTextResult>;
}
