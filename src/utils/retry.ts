import { ExternalServiceError, getExternalErrorLogContext } from "./errors";
import { logger as defaultLogger, type Logger } from "./logger";

type Sleep = (delayMs: number) => Promise<void>;
type RandomSource = () => number;

export interface RetryConfig {
	maxAttempts: number;
	initialDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
	sleep: Sleep;
	random: RandomSource;
}

const defaultSleep: Sleep = async (delayMs) => {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	initialDelayMs: 1000,
	maxDelayMs: 10000,
	backoffMultiplier: 2,
	sleep: defaultSleep,
	random: Math.random,
};

const isRetryableExternalServiceError = (error: Error): boolean =>
	error instanceof ExternalServiceError && error.retryable;

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
	shouldRetry: (error: Error) => boolean = isRetryableExternalServiceError,
	log?: Logger,
): Promise<T> {
	const logger = log ?? defaultLogger;
	const {
		maxAttempts,
		initialDelayMs,
		maxDelayMs,
		backoffMultiplier,
		sleep,
		random,
	} = {
		...DEFAULT_RETRY_CONFIG,
		...config,
	};

	let lastError: Error = new Error("Retry failed");

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry on last attempt or if error is not retryable
			if (attempt === maxAttempts - 1 || !shouldRetry(lastError)) {
				throw lastError;
			}

			const cappedBackoff = Math.min(
				initialDelayMs * backoffMultiplier ** attempt,
				maxDelayMs,
			);
			const randomValue = Math.min(1, Math.max(0, random()));
			const delay =
				lastError instanceof ExternalServiceError &&
				lastError.retryAfterMs !== undefined
					? lastError.retryAfterMs
					: Math.round(cappedBackoff * randomValue);

			logger.warn("Retrying external service request", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs: delay,
				...getExternalErrorLogContext(lastError),
			});

			await sleep(delay);
		}
	}

	throw lastError;
}
