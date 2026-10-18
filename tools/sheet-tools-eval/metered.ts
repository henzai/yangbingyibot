import type {
	ILlmGateway,
	LlmRequest,
	LlmStreamEvent,
	LlmToolArguments,
	LlmUsage,
} from "../../src/llm/types";
import { ExternalServiceError } from "../../src/utils/errors";
import {
	calculateObservedCost,
	estimateRequestUpperBound,
} from "../llm-eval/pricing";
import type { PriceCatalogEntry } from "../llm-eval/types";

/** Production sends at most two provider attempts per request (adapter retry). */
export const MAX_PROVIDER_ATTEMPTS = 2;
/**
 * The legacy production request sets no output cap. The reservation assumes the
 * same ceiling as one sheet-tool round; the request itself is left unchanged.
 */
export const LEGACY_RESERVED_OUTPUT_TOKENS = 16_000;
/** Covers provider-side framing around the serialized prompt. */
const FRAMING_BYTES = 1024;

export function utf8Bytes(value: unknown): number {
	return new TextEncoder().encode(
		typeof value === "string" ? value : JSON.stringify(value),
	).byteLength;
}

/** UTF-8 bytes of everything a request sends; used as a token ceiling. */
export function requestInputBytes(request: LlmRequest): number {
	return (
		utf8Bytes({
			prompt: request.prompt,
			tools: request.tools ?? null,
			continuation: request.continuation ?? null,
		}) + FRAMING_BYTES
	);
}

export function reservationUsd(
	inputBytes: number,
	maxOutputTokens: number,
	price: PriceCatalogEntry,
): number {
	return (
		estimateRequestUpperBound(inputBytes, maxOutputTokens, price) *
		MAX_PROVIDER_ATTEMPTS
	);
}

/** Thrown before a request is sent; never an ExternalServiceError. */
export class HarnessBudgetStop extends Error {
	constructor() {
		super("harness budget stop");
		this.name = "HarnessBudgetStop";
	}
}

export type RequestRecord = {
	inputBytes: number;
	reservedUsd: number;
	attempts: number;
	usage: LlmUsage | null;
	/** observed: from reported usage; estimated: reservation-based fallback. */
	costKind: "observed" | "estimated";
	costUsd: number;
	/** null when the provider returned a response stream without throwing. */
	error: { service: string; operation: string; status: number | null } | null;
	/** Model-requested calls with raw arguments; local raw.jsonl only. */
	toolCalls: { name: string; arguments: LlmToolArguments }[];
};

/**
 * Wraps the real gateway: reserves a conservative worst case before each
 * request, stops the run when it would exceed the cap, and reconciles with the
 * reported usage afterwards. Production loop code runs unmodified on top.
 */
export class MeteredGateway implements ILlmGateway {
	readonly provider: string;
	readonly capabilities: ILlmGateway["capabilities"];
	readonly records: RequestRecord[] = [];
	private spentUsd = 0;

	constructor(
		private readonly inner: ILlmGateway,
		private readonly price: PriceCatalogEntry,
		private readonly maxUsd: number,
	) {
		this.provider = inner.provider;
		this.capabilities = inner.capabilities;
	}

	get spent(): number {
		return this.spentUsd;
	}

	async *generateStream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
		const inputBytes = requestInputBytes(request);
		const single = estimateRequestUpperBound(
			inputBytes,
			request.maxOutputTokens ?? LEGACY_RESERVED_OUTPUT_TOKENS,
			this.price,
		);
		const reserved = single * MAX_PROVIDER_ATTEMPTS;
		if (this.spentUsd + reserved > this.maxUsd) throw new HarnessBudgetStop();
		let attempts = 0;
		let usage: LlmUsage | null = null;
		let error: RequestRecord["error"] = null;
		const toolCalls: RequestRecord["toolCalls"] = [];
		const telemetry = {
			onAttempt: () => {
				attempts++;
				request.telemetry?.onAttempt();
			},
			onFirstText: () => request.telemetry?.onFirstText?.(),
		};
		try {
			for await (const event of this.inner.generateStream({
				...request,
				telemetry,
			})) {
				if (event.type === "usage") usage = event.usage;
				else if (event.type === "tool_calls")
					for (const call of event.calls)
						toolCalls.push({ name: call.name, arguments: call.arguments });
				yield event;
			}
		} catch (caught) {
			error =
				caught instanceof ExternalServiceError
					? {
							service: caught.service,
							operation: caught.operation,
							status: caught.status ?? null,
						}
					: { service: "harness", operation: "request", status: null };
			throw caught;
		} finally {
			const observed = error ? null : calculateObservedCost(usage, this.price);
			// Usage covers one attempt; every earlier attempt is reserved in full.
			const retries = Math.max(0, attempts - 1) * single;
			const costUsd =
				observed === null
					? Math.min(reserved, single * Math.max(1, attempts))
					: observed + retries;
			this.spentUsd += costUsd;
			this.records.push({
				inputBytes,
				reservedUsd: reserved,
				attempts,
				usage,
				costKind: observed === null ? "estimated" : "observed",
				costUsd,
				error,
				toolCalls,
			});
		}
	}

	generateText(): never {
		throw new Error("generateText is not used by the evaluation");
	}
}
