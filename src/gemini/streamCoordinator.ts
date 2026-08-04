import type { GeminiStreamEvent, GeminiUsage } from "./types";

export type StreamPhase = "idle" | "thinking" | "response";

export type StreamPreviewDecision = {
	phase: Exclude<StreamPhase, "idle">;
	text: string;
	textLength: number;
	createdAt: number;
};

export type StreamCoordinatorConfig = {
	responseEditIntervalMs: number;
	responseMinChunkSize: number;
	thinkingEditIntervalMs: number;
	thinkingMinChunkSize: number;
};

const DEFAULT_CONFIG: StreamCoordinatorConfig = {
	responseEditIntervalMs: 1500,
	responseMinChunkSize: 50,
	thinkingEditIntervalMs: 1000,
	thinkingMinChunkSize: 200,
};

export class StreamCoordinator {
	private phase: StreamPhase = "idle";
	private thinking = "";
	private hasSeenThinking = false;
	private response = "";
	private usage: GeminiUsage | null = null;
	private finishReason: string | undefined;
	private blockReason: string | undefined;
	private lastEditAt = 0;
	private lastThinkingEditLength = 0;
	private lastResponseEditLength = 0;
	private readonly config: StreamCoordinatorConfig;

	constructor(config: Partial<StreamCoordinatorConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	handle(event: GeminiStreamEvent, now: number): StreamPreviewDecision | null {
		if (event.type === "usage") {
			this.usage = event.usage;
			return null;
		}

		if (event.type === "finish") {
			this.finishReason = event.finishReason;
			this.blockReason = event.blockReason;
			return null;
		}

		const previousPhase = this.phase;
		if (event.type === "thinking") {
			const firstThinking = !this.hasSeenThinking;
			this.hasSeenThinking = true;
			this.phase = "thinking";
			this.thinking += event.delta;
			return this.createDecision(event.type, now, firstThinking, false);
		} else {
			this.phase = "response";
			this.response = event.accumulated;
			return this.createDecision(
				event.type,
				now,
				false,
				previousPhase !== "response",
			);
		}
	}

	private createDecision(
		phase: Exclude<StreamPhase, "idle">,
		now: number,
		firstThinking: boolean,
		phaseTransition: boolean,
	): StreamPreviewDecision | null {
		const text = phase === "thinking" ? this.thinking : this.response;
		const lastLength =
			phase === "thinking"
				? this.lastThinkingEditLength
				: this.lastResponseEditLength;
		const interval =
			phase === "thinking"
				? this.config.thinkingEditIntervalMs
				: this.config.responseEditIntervalMs;
		const minChunkSize =
			phase === "thinking"
				? this.config.thinkingMinChunkSize
				: this.config.responseMinChunkSize;
		const elapsed = now - this.lastEditAt;
		const addedLength = text.length - lastLength;

		if (
			!firstThinking &&
			!phaseTransition &&
			(elapsed < interval || addedLength < minChunkSize)
		) {
			return null;
		}

		return {
			phase,
			text,
			textLength: text.length,
			createdAt: now,
		};
	}

	markDelivered(decision: StreamPreviewDecision): void {
		this.lastEditAt = decision.createdAt;
		if (decision.phase === "thinking") {
			this.lastThinkingEditLength = decision.textLength;
		} else {
			this.lastResponseEditLength = decision.textLength;
		}
	}

	getResult(): {
		phase: StreamPhase;
		response: string;
		thinking: string;
		usage: GeminiUsage | null;
		finishReason: string | undefined;
		blockReason: string | undefined;
	} {
		return {
			phase: this.phase,
			response: this.response,
			thinking: this.thinking,
			usage: this.usage,
			finishReason: this.finishReason,
			blockReason: this.blockReason,
		};
	}
}
