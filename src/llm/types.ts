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
	/**
	 * tool_calls: the response ended by requesting tools; any text in it is
	 * interim, NOT a final answer.
	 */
	reason: "stop" | "length" | "blocked" | "error" | "unknown" | "tool_calls";
	/** Diagnostic codes only, never provider response bodies. */
	providerFinishReason?: string;
	providerBlockReason?: string;
};

/** Provider-independent function tool. Schema validation is the executor's job. */
export type LlmToolDefinition = {
	name: string;
	description: string;
	/** JSON Schema passed through to the provider unchanged. */
	parameters: Readonly<Record<string, unknown>>;
	strict: true;
};

/** Parsed model arguments, or a code only; raw argument strings are never exposed. */
export type LlmToolArguments =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: "invalid_json" | "not_object" | "unknown_tool" };

export type LlmToolCall = {
	callId: string;
	name: string;
	arguments: LlmToolArguments;
};

/**
 * Opaque, JSON-serializable provider state for continuing a tool exchange, so
 * callers can checkpoint it. Callers must not inspect or log `items` (they may
 * contain encrypted reasoning) and must pass it back unchanged.
 */
export type LlmToolState = {
	readonly provider: string;
	readonly items: readonly unknown[];
	readonly pendingCallIds: readonly string[];
};

/** One result per pending call id, exactly. */
export type LlmToolContinuation = {
	state: LlmToolState;
	results: readonly { callId: string; output: string }[];
};

export type LlmStreamEvent =
	| { type: "text"; delta: string }
	/** Only provider-published summaries, not private chain-of-thought. */
	| { type: "reasoning_summary"; delta: string }
	/** At most once, after the response completes and before usage/finish. */
	| {
			type: "tool_calls";
			calls: readonly LlmToolCall[];
			state: LlmToolState;
	  }
	| { type: "usage"; usage: LlmUsage }
	| { type: "finish"; finish: LlmFinish };

export type LlmRequest = {
	model: string;
	prompt: LlmPrompt;
	temperature?: number;
	maxOutputTokens?: number;
	/** Requires capabilities.tools; unsupported providers/models throw. */
	tools?: readonly LlmToolDefinition[];
	/** Results for the previous round's tool calls; tools must be resent. */
	continuation?: LlmToolContinuation;
	/** Optional, best effort; callers must work without summary events. */
	includeReasoningSummary?: boolean;
	/** Total budget including retries and streaming; capped by the adapter. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * Optional request-local hooks for provider-independent metrics. Adapters
	 * call onAttempt exactly once immediately before every provider request.
	 */
	telemetry?: {
		onAttempt(): void;
		onFirstText?(): void;
	};
};

export type LlmProbeRequest = {
	model: string;
	/** Health probes are non-generating and use a short bounded deadline. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type LlmProbeResult = {
	status: "available" | "unavailable" | "unverified";
	/** Both built-in probes read metadata for one selected model. */
	scope: "model_metadata";
	/** Metadata support is not the same as a successful generation. */
	generationSupport: "supported" | "unverified";
	detail?: string;
};

export type LlmTextResult = {
	text: string;
	usage: LlmUsage | null;
	finish: LlmFinish;
	/** Present only when finish.reason is "tool_calls". */
	toolCalls?: readonly LlmToolCall[];
	toolState?: LlmToolState;
};

export interface ILlmGateway {
	readonly provider: string;
	/** Adapter support does not guarantee that every selected model emits it. */
	readonly capabilities: {
		readonly reasoningSummary: boolean;
		readonly tools: boolean;
	};
	/**
	 * Callers passing tools must hold text until `finish` and must not deliver
	 * it when the reason is "tool_calls" (the text is interim).
	 *
	 * Exactly one finish event on normal exhaustion, after any usage snapshots.
	 * Transport failures throw; partial text must not be treated as completed.
	 * Never automatically replay a stream once consumption has begun.
	 */
	generateStream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
	generateText(request: LlmRequest): Promise<LlmTextResult>;
	/**
	 * A non-generating reachability/authentication/model-availability probe.
	 * Optional so a provider without a safe non-generating probe is reported as
	 * unverified instead of being assumed healthy.
	 */
	probe?(request: LlmProbeRequest): Promise<LlmProbeResult>;
}
