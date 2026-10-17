import OpenAI from "openai";
import type {
	Response,
	ResponseFunctionToolCall,
	ResponseInputItem,
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
	LlmProbeRequest,
	LlmProbeResult,
	LlmRequest,
	LlmStreamEvent,
	LlmTextResult,
	LlmToolArguments,
	LlmToolCall,
	LlmToolState,
	LlmUsage,
} from "../types";
import {
	continuationItems,
	OPENAI_STATE_PROVIDER,
	openAIToolError,
	toOpenAIRequest,
} from "./openaiPrompt";

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

function toFinish(
	response: Response,
	refusalSeen = false,
	toolCalls = false,
): LlmFinish {
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
	if (status === "completed") {
		return {
			reason: toolCalls ? "tool_calls" : "stop",
			providerFinishReason: status,
		};
	}
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

function parseArguments(
	raw: unknown,
	name: string,
	known: ReadonlySet<string>,
): LlmToolArguments {
	if (!known.has(name)) return { ok: false, error: "unknown_tool" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(typeof raw === "string" ? raw : "");
	} catch {
		return { ok: false, error: "invalid_json" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return { ok: false, error: "not_object" };
	return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Tool calls come only from a completed final response; streamed argument
 * deltas are partial and never acted on. Protocol violations throw.
 */
function extractToolCalls(
	request: LlmRequest,
	response: Response,
	refusalSeen: boolean,
): { calls: LlmToolCall[]; state: LlmToolState } | null {
	if (response.status !== "completed") return null;
	const items = response.output.filter(
		(item): item is ResponseFunctionToolCall => item.type === "function_call",
	);
	if (items.length === 0) return null;
	if (refusalSeen || hasRefusal(response)) return null;
	if (!request.tools?.length) throw openAIToolError("validate tool calls");
	const known = new Set(request.tools.map((tool) => tool.name));
	const ids = new Set<string>();
	const calls = items.map((item): LlmToolCall => {
		if (typeof item.call_id !== "string" || item.call_id === "")
			throw openAIToolError("validate tool call id");
		if (ids.has(item.call_id)) throw openAIToolError("validate tool call id");
		ids.add(item.call_id);
		return {
			callId: item.call_id,
			name: item.name,
			arguments: parseArguments(item.arguments, item.name, known),
		};
	});
	return {
		calls,
		state: {
			provider: OPENAI_STATE_PROVIDER,
			// Cumulative: later rounds resend every earlier item, unmodified.
			items: [
				...continuationItems(request),
				...(response.output as ResponseInputItem[]),
			],
			pendingCallIds: [...ids],
		},
	};
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
	readonly capabilities = { reasoningSummary: true, tools: true } as const;
	private readonly responses: OpenAI["responses"];
	private readonly models?: OpenAI["models"];

	constructor(
		apiKey: string,
		private readonly log: Logger = defaultLogger,
		responses?: OpenAI["responses"],
		models?: OpenAI["models"],
	) {
		if (responses) {
			this.responses = responses;
			this.models = models;
			return;
		}
		const client = new OpenAI({
			apiKey,
			// The application owns retry and deadline policy.
			maxRetries: 0,
			timeout: 90_000,
		});
		this.responses = responses ?? client.responses;
		this.models = models ?? client.models;
	}

	private executeRequest<T>(
		scope: LlmRequestScope,
		operation: string,
		request: () => Promise<T>,
		onAttempt?: () => void,
	): Promise<T> {
		return withRetry(
			async () => {
				onAttempt?.();
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

	async probe(request: LlmProbeRequest): Promise<LlmProbeResult> {
		const models = this.models;
		if (!models) {
			return {
				status: "unverified",
				scope: "model_metadata",
				generationSupport: "unverified",
				detail: "OpenAI Models client is unavailable",
			};
		}
		const scope = new LlmRequestScope(
			this.provider,
			request.timeoutMs ?? 5_000,
			request.signal,
		);
		try {
			await scope.run("retrieve model metadata", () =>
				models.retrieve(request.model, { signal: scope.signal }),
			);
			return {
				status: "available",
				scope: "model_metadata",
				generationSupport: "unverified",
				detail:
					"Model availability was verified; Responses generation was not executed",
			};
		} catch (error) {
			throw normalizeLlmError(error, this.provider, "retrieve model metadata");
		} finally {
			scope.dispose();
		}
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
			const params = toOpenAIRequest(request);
			const stream = await this.executeRequest(
				scope,
				"start response stream",
				() =>
					this.responses.create(
						{ ...params, stream: true },
						{ signal: scope.signal },
					),
				request.telemetry?.onAttempt,
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
							if (event.delta) {
								request.telemetry?.onFirstText?.();
								yield { type: "text", delta: event.delta };
							}
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
			const tools = finalResponse
				? extractToolCalls(request, finalResponse, refusalSeen)
				: null;
			if (tools) yield { type: "tool_calls", ...tools };
			const usage = toUsage(finalResponse?.usage);
			if (usage) yield { type: "usage", usage };
			else this.log.warn("OpenAI usage metadata missing", { mode: "stream" });
			const finish: LlmFinish = finalResponse
				? toFinish(finalResponse, refusalSeen, tools !== null)
				: { reason: "unknown" };
			yield { type: "finish", finish };
			this.log.info("OpenAI streaming API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
				finishReason: finish.providerFinishReason,
				blockReason: finish.providerBlockReason,
				...(tools ? { toolCallCount: tools.calls.length } : {}),
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
			const params = toOpenAIRequest(request);
			const response = await this.executeRequest(
				scope,
				"create response",
				() =>
					this.responses.create(params, {
						signal: scope.signal,
					}),
				request.telemetry?.onAttempt,
			);
			const tools = extractToolCalls(request, response, false);
			const usage = toUsage(response.usage);
			if (!usage)
				this.log.warn("OpenAI usage metadata missing", { mode: "generate" });
			this.log.info("OpenAI text API completed", {
				model: request.model,
				durationMs: Date.now() - startTime,
				...(tools ? { toolCallCount: tools.calls.length } : {}),
			});
			return {
				text: extractText(response),
				usage,
				finish: toFinish(response, false, tools !== null),
				...(tools ? { toolCalls: tools.calls, toolState: tools.state } : {}),
			};
		} finally {
			scope.dispose();
		}
	}
}
