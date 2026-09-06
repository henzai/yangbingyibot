import {
	ExternalServiceError,
	type LlmErrorKind,
	normalizeExternalServiceError,
	parseRetryAfterMs,
} from "../utils/errors";

function retryAfter(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("headers" in error)) {
		return undefined;
	}
	const headers = error.headers;
	if (headers instanceof Headers) {
		return parseRetryAfterMs(headers.get("retry-after"));
	}
	if (headers && typeof headers === "object") {
		const value = Object.entries(headers).find(
			([name]) => name.toLowerCase() === "retry-after",
		)?.[1];
		return typeof value === "string" ? parseRetryAfterMs(value) : undefined;
	}
	return undefined;
}

export function normalizeLlmError(
	error: unknown,
	provider: string,
	operation: string,
	forceKind?: LlmErrorKind,
): ExternalServiceError {
	const normalized = normalizeExternalServiceError(error, {
		service: "llm",
		operation,
		userMessage: "AI APIへのリクエストに失敗しました。",
	});
	const name = error instanceof Error ? error.name : undefined;
	const kind =
		forceKind ??
		normalized.kind ??
		(name === "AbortError"
			? "cancelled"
			: name === "TimeoutError"
				? "timeout"
				: normalized.status === undefined
					? "transport"
					: "http");
	const retryable =
		kind === "cancelled" || kind === "timeout" || kind === "interrupted"
			? false
			: normalized.retryable;
	let userMessage = normalized.userMessage;
	if (kind === "timeout") {
		userMessage = "AIの応答が時間内に完了しませんでした。再度お試しください。";
	} else if (kind === "cancelled") {
		userMessage = "AIへのリクエストが中止されました。";
	} else if (normalized.status === 429) {
		userMessage =
			"API使用制限に達しました。しばらく待ってから再度お試しください。";
	} else if (normalized.status === 401 || normalized.status === 403) {
		userMessage = "API認証エラーが発生しました。";
	}
	return new ExternalServiceError({
		service: "llm",
		provider,
		kind,
		operation,
		status: normalized.status,
		retryable,
		retryAfterMs: normalized.retryAfterMs ?? retryAfter(error),
		userMessage,
		cause: error,
	});
}
