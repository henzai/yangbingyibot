import OpenAI from "openai";
import type {
	Response,
	ResponseStreamEvent,
	ResponseUsage,
} from "openai/resources/responses/responses";
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
import { toOpenAIRequest } from "./openaiPrompt";

const RETRY_CONFIG = { maxAttempts: 2, initialDelayMs: 500, maxDelayMs: 2000 };

function optionalCounter(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function toUsage(usage: ResponseUsage | null | undefined): LlmUsage | null {
	if (!usage) return null;
	const inputTokens = optionalCounter(usage.input_tokens);
	const cachedInputTokens = optionalCounter(
		usage.input_tokens_details?.cached_tokens,
	);
	const inclusiveOutputTokens = optionalCounter(usage.output_tokens);
	const reasoningTokens = optionalCounter(
		usage.output_tokens_details?.reasoning_tokens,
	);
	return {
		inputTokens,
		cachedInputTokens,
		// Responses includes reasoning in output_tokens; the common contract does not.
		outputTokens:
			inclusiveOutputTokens === null || reasoningTokens === null
				? null
				: Math.max(0, inclusiveOutputTokens - reasoningTokens),
		reasoningTokens,
		totalTokens: optionalCounter(usage.total_tokens),
	};
}

function hasRefusal(response: Response): boolean {
	return response.output.some(
		(item) =>
			item.type === "message" &&
			item.content.some((content) => content.type === "refusal"),
	);
}

function toFinish(response: Response, refusalSeen = false): LlmFinish {
	const status = response.status;
	const incompleteReason = response.incomplete_details?.reason;
	const errorCode = response.error?.code;
	if (refusalSeen || hasRefusal(response)) {
		return {
			reason: "blocked",
			providerFinishReason: status,
			providerBlockReason: "refusal",
		};
	}
	if (status === "completed")
		return { reason: "stop", providerFinishReason: status };
	if (status === "incomplete") {
		if (
			incompleteReason === "max_output_tokens" ||
			incompleteReason === "max_messages"
		) {
			return {
				reason: "length",
				providerFinishReason: status,
				providerBlockReason: incompleteReason,
			};
		}
		if (incompleteReason === "content_filter") {
			return {
				reason: "blocked",
				providerFinishReason: status,
				providerBlockReason: incompleteReason,
			};
		}
		return {
			reason: "error",
			providerFinishReason: status,
			providerBlockReason: incompleteReason,
		};
	}
	if (status === "failed" || status === "cancelled") {
		return {
			reason: "error",
			providerFinishReason: status,
			providerBlockReason: errorCode,
		};
	}
	return { reason: "unknown", providerFinishReason: status };
}

function extractText(response: Response): string {
	if (typeof response.output_text === "string") return response.output_text;
	return response.output
		.flatMap((item) => (item.type === "message" ? item.content : []))
		.filter((content) => content.type === "output_text")
		.map((content) => content.text)
		.join("");
}

export class OpenAILlmGateway implements ILlmGateway {
	readonly provider = "openai";
	readonly capabilities = { reasoningSummary: true } as const;
	private readonly responses: OpenAI["responses"];

	constructor(
		apiKey: string,
		private readonly log: Logger = defaultLogger,
		responses?: OpenAI["responses"],
	) {
		this.responses =
			responses ??
			new OpenAI({
				apiKey,
				// The application owns retry and deadline policy.
				maxRetries: 0,
				timeout: 90_000,
			}).responses;
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
		const startTime = Date.now();
		this.log.info("OpenAI streaming API request starting", {
			model: request.model,
		});
		try {
			const stream = await this.executeRequest(
				scope,
				"start response stream",
				() =>
					this.responses.create(
						{ ...toOpenAIRequest(request), stream: true },
						{ signal: scope.signal },
					),
			);
			let finalResponse: Response | null = null;
			let refusalSeen = false;
			const iterator = stream[Symbol.asyncIterator]();
			try {
				while (true) {
					const next = await scope.run("consume response stream", () =>
						iterator.next(),
					);
					if (next.done) break;
					const event: ResponseStreamEvent = next.value;
					scope.signal.throwIfAborted();
					switch (event.type) {
						case "response.output_text.delta":
							if (event.delta) yield { type: "text", delta: event.delta };
							break;
						case "response.reasoning_summary_text.delta":
							if (request.includeReasoningSummary && event.delta)
								yield { type: "reasoning_summary", delta: event.delta };
							break;
						case "response.refusal.delta":
							refusalSeen = true;
							break;
						case "response.completed":
						case "response.incomplete":
						case "response.failed":
							finalResponse = event.response;
							break;
						case "error":
							throw new Error("OpenAI response stream reported an error");
					}
				}
			} catch (error) {
				const normalized = normalizeLlmError(
					error,
					this.provider,
					"consume response stream",
				);
				throw normalizeLlmError(
					normalized,
					this.provider,
					"consume response stream",
					normalized.kind === "timeout" || normalized.kind === "cancelled"
						? normalized.kind
						: "interrupted",
				);
			} finally {
				scope.dispose();
				void iterator.return?.(undefined).catch(() => {});
			}
			const usage = toUsage(finalResponse?.usage);
			if (usage) yield { type: "usage", usage };
			else this.log.warn("OpenAI usage metadata missing", { mode: "stream" });
			const finish: LlmFinish = finalResponse
				? toFinish(finalResponse, refusalSeen)
				: { reason: "unknown" };
			yield { type: "finish", finish };
			this.log.info("OpenAI streaming API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
				finishReason: finish.providerFinishReason,
				blockReason: finish.providerBlockReason,
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
		const startTime = Date.now();
		this.log.info("OpenAI text API request starting", { model: request.model });
		try {
			const response = await this.executeRequest(scope, "create response", () =>
				this.responses.create(toOpenAIRequest(request), {
					signal: scope.signal,
				}),
			);
			const usage = toUsage(response.usage);
			if (!usage)
				this.log.warn("OpenAI usage metadata missing", { mode: "generate" });
			this.log.info("OpenAI text API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
			});
			return {
				text: extractText(response),
				usage,
				finish: toFinish(response),
			};
		} finally {
			scope.dispose();
		}
	}
}
