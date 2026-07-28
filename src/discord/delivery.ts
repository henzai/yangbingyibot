import {
	ExternalServiceError,
	getExternalErrorLogContext,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { type RetryConfig, withRetry } from "../utils/retry";
import { splitContent } from "./formatter";

export type DeliveryStatus = "success" | "empty" | "partial" | "failed";

export interface DeliveryResult {
	status: DeliveryStatus;
	success: boolean;
	editCount: number;
	chunkCount: number;
	failedChunks: number[];
	retryCount: number;
	statusCode?: number;
}

export interface DiscordWebhookTransport {
	editOriginalMessage(content: string): Promise<void>;
	postMessage(content: string): Promise<void>;
}

const DEFAULT_DISCORD_RETRY_CONFIG: Partial<RetryConfig> = {
	maxAttempts: 3,
	initialDelayMs: 1000,
	maxDelayMs: 10_000,
	backoffMultiplier: 2,
};

interface DeliveryAttempt {
	success: boolean;
	retryCount: number;
	statusCode?: number;
}

function deliveryStatus(
	successfulCalls: number,
	failedChunks: number[],
): DeliveryStatus {
	if (failedChunks.length === 0) {
		return "success";
	}
	return successfulCalls === 0 ? "failed" : "partial";
}

export class DiscordDeliveryService {
	private transport: DiscordWebhookTransport;
	private log: Logger;
	private retryConfig: Partial<RetryConfig>;

	constructor(
		transport: DiscordWebhookTransport,
		log?: Logger,
		retryConfig: Partial<RetryConfig> = {},
	) {
		this.transport = transport;
		this.log = log ?? defaultLogger;
		this.retryConfig = {
			...DEFAULT_DISCORD_RETRY_CONFIG,
			...retryConfig,
		};
	}

	async deliverPreview(content: string): Promise<DeliveryResult> {
		const [preview] = splitContent(content);
		if (preview === undefined) {
			return this.emptyResult();
		}

		const attempt = await this.attemptDelivery(
			() => this.transport.editOriginalMessage(preview),
			"preview edit",
			0,
		);
		const failedChunks = attempt.success ? [] : [0];

		return {
			status: attempt.success ? "success" : "failed",
			success: attempt.success,
			editCount: attempt.success ? 1 : 0,
			chunkCount: 0,
			failedChunks,
			retryCount: attempt.retryCount,
			statusCode: attempt.statusCode,
		};
	}

	async deliverFinal(content: string): Promise<DeliveryResult> {
		const chunks = splitContent(content);
		if (chunks.length === 0) {
			return this.emptyResult();
		}

		let editCount = 0;
		let chunkCount = 0;
		let retryCount = 0;
		let statusCode: number | undefined = 200;
		const failedChunks: number[] = [];

		const editAttempt = await this.attemptDelivery(
			() => this.transport.editOriginalMessage(chunks[0] as string),
			"final edit",
			0,
		);
		retryCount += editAttempt.retryCount;
		if (editAttempt.success) {
			editCount++;
		} else {
			failedChunks.push(0);
			statusCode = editAttempt.statusCode;
		}

		for (let index = 1; index < chunks.length; index++) {
			const chunk = chunks[index] as string;
			const followupAttempt = await this.attemptDelivery(
				() => this.transport.postMessage(chunk),
				"follow-up message",
				index,
			);
			retryCount += followupAttempt.retryCount;
			if (followupAttempt.success) {
				chunkCount++;
			} else {
				failedChunks.push(index);
				statusCode = followupAttempt.statusCode;
			}
		}

		const status = deliveryStatus(editCount + chunkCount, failedChunks);
		return {
			status,
			success: status === "success",
			editCount,
			chunkCount,
			failedChunks,
			retryCount,
			statusCode,
		};
	}

	async deliverFollowup(content: string): Promise<DeliveryResult> {
		const chunks = splitContent(content);
		if (chunks.length === 0) {
			return this.emptyResult();
		}

		let chunkCount = 0;
		let retryCount = 0;
		let statusCode: number | undefined = 200;
		const failedChunks: number[] = [];

		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index] as string;
			const attempt = await this.attemptDelivery(
				() => this.transport.postMessage(chunk),
				"follow-up message",
				index,
			);
			retryCount += attempt.retryCount;
			if (attempt.success) {
				chunkCount++;
			} else {
				failedChunks.push(index);
				statusCode = attempt.statusCode;
			}
		}

		const status = deliveryStatus(chunkCount, failedChunks);
		return {
			status,
			success: status === "success",
			editCount: 0,
			chunkCount,
			failedChunks,
			retryCount,
			statusCode,
		};
	}

	private emptyResult(): DeliveryResult {
		return {
			status: "empty",
			success: false,
			editCount: 0,
			chunkCount: 0,
			failedChunks: [],
			retryCount: 0,
		};
	}

	private async attemptDelivery(
		operation: () => Promise<void>,
		operationName: string,
		chunkIndex: number,
	): Promise<DeliveryAttempt> {
		let attemptCount = 0;
		try {
			await withRetry(
				async () => {
					attemptCount++;
					await operation();
				},
				this.retryConfig,
				undefined,
				this.log,
			);
			return {
				success: true,
				retryCount: attemptCount - 1,
				statusCode: 200,
			};
		} catch (error) {
			this.log.warn("Discord delivery failed", {
				deliveryOperation: operationName,
				chunkIndex,
				...getExternalErrorLogContext(error),
			});
			return {
				success: false,
				retryCount: Math.max(0, attemptCount - 1),
				statusCode:
					error instanceof ExternalServiceError ? error.status : undefined,
			};
		}
	}
}

export function createDiscordDeliveryService(
	transport: DiscordWebhookTransport,
	log?: Logger,
	retryConfig?: Partial<RetryConfig>,
): DiscordDeliveryService {
	return new DiscordDeliveryService(transport, log, retryConfig);
}
