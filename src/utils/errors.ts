export type ExternalService = "discord" | "gemini" | "sheets" | "github";

type ExternalServiceErrorOptions = {
	service: ExternalService;
	operation: string;
	status?: number;
	retryable: boolean;
	userMessage: string;
	retryAfterMs?: number;
	cause?: unknown;
};

type NormalizeExternalServiceErrorOptions = Omit<
	ExternalServiceErrorOptions,
	"retryable" | "status"
> & {
	status?: number;
	retryable?: boolean;
};

const MAX_RETRY_AFTER_MS = 60_000;

export class ExternalServiceError extends Error {
	readonly service: ExternalService;
	readonly operation: string;
	readonly status?: number;
	readonly retryable: boolean;
	readonly userMessage: string;
	readonly retryAfterMs?: number;

	constructor(options: ExternalServiceErrorOptions) {
		const statusSuffix =
			options.status === undefined ? "" : ` (status ${options.status})`;
		super(`${options.service} ${options.operation} failed${statusSuffix}`, {
			cause: options.cause,
		});
		this.name = "ExternalServiceError";
		this.service = options.service;
		this.operation = options.operation;
		this.status = options.status;
		this.retryable = options.retryable;
		this.userMessage = options.userMessage;
		this.retryAfterMs = options.retryAfterMs;
	}
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

export function getUserMessage(
	error: unknown,
	fallback = "予期しないエラーが発生しました。",
): string {
	return error instanceof ExternalServiceError ? error.userMessage : fallback;
}

export function isRetryableStatus(status: number | undefined): boolean {
	return (
		status === undefined ||
		status === 408 ||
		status === 429 ||
		(status >= 500 && status <= 599)
	);
}

export function parseRetryAfterMs(
	value: string | null,
	nowMs = Date.now(),
	maxMs = MAX_RETRY_AFTER_MS,
): number | undefined {
	if (value === null) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) {
		return seconds >= 0
			? Math.min(Math.round(seconds * 1000), maxMs)
			: undefined;
	}

	const retryAt = Date.parse(trimmed);
	if (Number.isNaN(retryAt)) {
		return undefined;
	}

	return Math.min(Math.max(0, retryAt - nowMs), maxMs);
}

function extractStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	for (const field of ["status", "statusCode", "code"] as const) {
		const value = (error as Record<string, unknown>)[field];
		if (
			typeof value === "number" &&
			Number.isInteger(value) &&
			value >= 100 &&
			value <= 599
		) {
			return value;
		}
	}

	return undefined;
}

export function normalizeExternalServiceError(
	error: unknown,
	options: NormalizeExternalServiceErrorOptions,
): ExternalServiceError {
	if (error instanceof ExternalServiceError) {
		return error;
	}

	const status = options.status ?? extractStatus(error);
	return new ExternalServiceError({
		...options,
		status,
		retryable: options.retryable ?? isRetryableStatus(status),
		cause: error,
	});
}

export function externalServiceErrorFromResponse(
	service: ExternalService,
	operation: string,
	response: Response,
	userMessage: string,
): ExternalServiceError {
	return new ExternalServiceError({
		service,
		operation,
		status: response.status,
		retryable: isRetryableStatus(response.status),
		userMessage,
		retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
	});
}

export function getExternalErrorLogContext(
	error: unknown,
): Record<string, unknown> {
	if (!(error instanceof ExternalServiceError)) {
		return { error: getErrorMessage(error) };
	}

	return {
		service: error.service,
		operation: error.operation,
		status: error.status,
		retryable: error.retryable,
		retryAfterMs: error.retryAfterMs,
	};
}
