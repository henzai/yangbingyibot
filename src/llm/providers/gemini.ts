import {
	type GenerateContentResponseUsageMetadata,
	GoogleGenAI,
	ThinkingLevel,
} from "@google/genai";
import { logger as defaultLogger, type Logger } from "../../utils/logger";
import { withRetry } from "../../utils/retry";
import { normalizeLlmError } from "../errors";
import { LlmRequestScope } from "../requestScope";
import type {
	ILlmGateway,
	LlmFinish,
	LlmRequest,
	LlmStreamEvent,
	LlmTextResult,
	LlmUsage,
} from "../types";
import { toGeminiPrompt } from "./geminiPrompt";

const RETRY_CONFIG = { maxAttempts: 2, initialDelayMs: 500, maxDelayMs: 2000 };

function toUsage(
	usage: GenerateContentResponseUsageMetadata | undefined,
): LlmUsage | null {
	if (!usage) return null;
	return {
		inputTokens: usage.promptTokenCount ?? null,
		cachedInputTokens: usage.cachedContentTokenCount ?? null,
		outputTokens: usage.candidatesTokenCount ?? null,
		reasoningTokens: usage.thoughtsTokenCount ?? null,
		totalTokens: usage.totalTokenCount ?? null,
	};
}

const BLOCKED_REASONS = new Set([
	"SAFETY",
	"RECITATION",
	"BLOCKLIST",
	"PROHIBITED_CONTENT",
	"SPII",
	"IMAGE_SAFETY",
	"IMAGE_PROHIBITED_CONTENT",
	"IMAGE_RECITATION",
]);

function toFinish(
	providerFinishReason?: string,
	providerBlockReason?: string,
): LlmFinish {
	let reason: LlmFinish["reason"] = "unknown";
	if (providerBlockReason && providerBlockReason !== "BLOCK_REASON_UNSPECIFIED")
		reason = "blocked";
	else if (providerFinishReason === "STOP") reason = "stop";
	else if (providerFinishReason === "MAX_TOKENS") reason = "length";
	else if (providerFinishReason && BLOCKED_REASONS.has(providerFinishReason))
		reason = "blocked";
	else if (
		providerFinishReason &&
		providerFinishReason !== "FINISH_REASON_UNSPECIFIED"
	)
		reason = "error";
	return { reason, providerFinishReason, providerBlockReason };
}

export class GeminiLlmGateway implements ILlmGateway {
	readonly provider = "gemini";
	readonly capabilities = { reasoningSummary: true } as const;
	private readonly client: GoogleGenAI;

	constructor(
		apiKey: string,
		private readonly log: Logger = defaultLogger,
	) {
		// The application owns retry policy: SDK attempts include the first call.
		this.client = new GoogleGenAI({
			apiKey,
			httpOptions: { retryOptions: { attempts: 1 } },
		});
	}

	private executeRequest<T>(
		scope: LlmRequestScope,
		operation: string,
		request: () => Promise<T>,
	): Promise<T> {
		return withRetry(
			async () => {
				try {
					return await scope.run(operation, request);
				} catch (error) {
					throw normalizeLlmError(error, this.provider, operation);
				}
			},
			{ ...RETRY_CONFIG, sleep: (delay) => scope.sleep(delay) },
			undefined,
			this.log,
		);
	}

	async *generateStream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
		const scope = new LlmRequestScope(
			this.provider,
			request.timeoutMs ?? 90_000,
			request.signal,
		);
		const prompt = toGeminiPrompt(
			request.prompt,
			request.includeReasoningSummary,
		);
		const startTime = Date.now();
		this.log.info("Gemini streaming API request starting", {
			model: request.model,
		});
		try {
			const stream = await this.executeRequest(
				scope,
				"start content stream",
				() =>
					this.client.models.generateContentStream({
						model: request.model,
						contents: prompt.contents,
						config: {
							systemInstruction: prompt.systemInstruction,
							maxOutputTokens: request.maxOutputTokens ?? 8192,
							responseMimeType: "text/plain",
							...(request.temperature === undefined
								? {}
								: { temperature: request.temperature }),
							thinkingConfig: {
								includeThoughts: request.includeReasoningSummary ?? false,
								thinkingLevel: ThinkingLevel.LOW,
							},
							abortSignal: scope.signal,
						},
					}),
			);
			let latestUsage: LlmUsage | null = null;
			let finishReason: string | undefined;
			let blockReason: string | undefined;
			const iterator = stream[Symbol.asyncIterator]();
			try {
				while (true) {
					const next = await scope.run("consume content stream", () =>
						iterator.next(),
					);
					if (next.done) break;
					const chunk = next.value;
					if (chunk.usageMetadata) latestUsage = toUsage(chunk.usageMetadata);
					finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
					blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
					for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
						scope.signal.throwIfAborted();
						if (typeof part.text !== "string" || part.text.length === 0)
							continue;
						if (part.thought) {
							if (request.includeReasoningSummary)
								yield { type: "reasoning_summary", delta: part.text };
						} else yield { type: "text", delta: part.text };
					}
				}
			} catch (error) {
				const normalized = normalizeLlmError(
					error,
					this.provider,
					"consume content stream",
				);
				// Even if no text was emitted, consumption cannot be safely replayed.
				throw normalizeLlmError(
					normalized,
					this.provider,
					"consume content stream",
					normalized.kind === "timeout" || normalized.kind === "cancelled"
						? normalized.kind
						: "interrupted",
				);
			} finally {
				// A stuck SDK must not extend the deadline during iterator cleanup.
				scope.dispose();
				void iterator.return?.(undefined).catch(() => {});
			}
			if (latestUsage) yield { type: "usage", usage: latestUsage };
			else this.log.warn("Gemini usage metadata missing", { mode: "stream" });
			yield { type: "finish", finish: toFinish(finishReason, blockReason) };
			this.log.info("Gemini streaming API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
				finishReason,
				blockReason,
			});
		} finally {
			scope.dispose();
		}
	}

	async generateText(request: LlmRequest): Promise<LlmTextResult> {
		const scope = new LlmRequestScope(
			this.provider,
			request.timeoutMs ?? 15_000,
			request.signal,
		);
		const prompt = toGeminiPrompt(
			request.prompt,
			request.includeReasoningSummary,
		);
		const startTime = Date.now();
		this.log.info("Gemini text API request starting", { model: request.model });
		try {
			const result = await this.executeRequest(scope, "generate text", () =>
				this.client.models.generateContent({
					model: request.model,
					contents: prompt.contents,
					config: {
						systemInstruction: prompt.systemInstruction,
						temperature: request.temperature,
						maxOutputTokens: request.maxOutputTokens,
						...(request.includeReasoningSummary
							? { thinkingConfig: { includeThoughts: true } }
							: {}),
						abortSignal: scope.signal,
					},
				}),
			);
			this.log.info("Gemini text API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
			});
			const text =
				result.candidates?.[0]?.content?.parts
					?.filter((part) => !part.thought)
					.map((part) => (typeof part.text === "string" ? part.text : ""))
					.join("") ?? "";
			const usage = toUsage(result.usageMetadata);
			if (!usage)
				this.log.warn("Gemini usage metadata missing", { mode: "generate" });
			return {
				text,
				usage,
				finish: toFinish(
					result.candidates?.[0]?.finishReason,
					result.promptFeedback?.blockReason,
				),
			};
		} finally {
			scope.dispose();
		}
	}
}
