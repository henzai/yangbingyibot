import { logger as defaultLogger, type Logger } from './logger';

export interface RetryConfig {
	maxAttempts: number;
	initialDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	initialDelayMs: 1000,
	maxDelayMs: 10000,
	backoffMultiplier: 2,
};

export class RetryableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RetryableError';
	}
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
	shouldRetry: (error: Error) => boolean = () => true,
	log?: Logger,
): Promise<T> {
	const logger = log ?? defaultLogger;
	const { maxAttempts, initialDelayMs, maxDelayMs, backoffMultiplier } = {
		...DEFAULT_RETRY_CONFIG,
		...config,
	};

	let lastError: Error = new Error('Retry failed');

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry on last attempt or if error is not retryable
			if (attempt === maxAttempts - 1 || !shouldRetry(lastError)) {
				throw lastError;
			}

			// Calculate delay with exponential backoff
			const delay = Math.min(initialDelayMs * backoffMultiplier ** attempt, maxDelayMs);

			logger.warn(`Retry attempt ${attempt + 1}/${maxAttempts}`, {
				delayMs: delay,
				error: lastError.message,
			});

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}
