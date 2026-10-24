import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { DiscordDeliveryService } from "./delivery";

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as Logger;

function discordError(
	status: number,
	options: { retryable?: boolean; retryAfterMs?: number } = {},
) {
	return new ExternalServiceError({
		service: "discord",
		operation: "deliver message",
		status,
		retryable: options.retryable ?? (status === 429 || status >= 500),
		userMessage: "Discordへの配信に失敗しました。",
		retryAfterMs: options.retryAfterMs,
	});
}

function createService() {
	const transport = {
		editOriginalMessage: vi.fn().mockResolvedValue(undefined),
		postMessage: vi.fn().mockResolvedValue(undefined),
	};
	const sleep = vi.fn().mockResolvedValue(undefined);
	const service = new DiscordDeliveryService(transport, log, {
		sleep,
		random: () => 0,
	});
	return { service, transport, sleep };
}

describe("DiscordDeliveryService", () => {
	it("returns an empty typed result for empty content", async () => {
		const { service, transport } = createService();

		await expect(service.deliverFinal("")).resolves.toEqual({
			status: "empty",
			success: false,
			editCount: 0,
			chunkCount: 0,
			failedChunks: [],
			retryCount: 0,
		});
		expect(transport.editOriginalMessage).not.toHaveBeenCalled();
		expect(transport.postMessage).not.toHaveBeenCalled();
	});

	it("edits only the first chunk for a streaming preview", async () => {
		const { service, transport } = createService();
		const content = "a".repeat(4000);

		const result = await service.deliverPreview(content);

		expect(transport.editOriginalMessage).toHaveBeenCalledWith(
			"a".repeat(2000),
		);
		expect(transport.postMessage).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "success",
			editCount: 1,
			chunkCount: 0,
		});
	});

	it("edits the original then posts all remaining chunks in order", async () => {
		const { service, transport } = createService();
		const content = `${"a".repeat(2000)}${"b".repeat(2000)}${"c".repeat(100)}`;

		const result = await service.deliverFinal(content);

		expect(transport.editOriginalMessage).toHaveBeenCalledWith(
			"a".repeat(2000),
		);
		expect(transport.postMessage.mock.calls).toEqual([
			["b".repeat(2000)],
			["c".repeat(100)],
		]);
		expect(result).toEqual({
			status: "success",
			success: true,
			editCount: 1,
			chunkCount: 2,
			failedChunks: [],
			retryCount: 0,
			statusCode: 200,
		});
	});

	it("continues after a middle chunk fails and reports a partial result", async () => {
		const { service, transport } = createService();
		transport.postMessage
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(discordError(400, { retryable: false }))
			.mockResolvedValueOnce(undefined);
		const content = [
			"a".repeat(2000),
			"b".repeat(2000),
			"c".repeat(2000),
			"d".repeat(2000),
		].join("");

		const result = await service.deliverFinal(content);

		expect(transport.postMessage).toHaveBeenCalledTimes(3);
		expect(result).toEqual({
			status: "partial",
			success: false,
			editCount: 1,
			chunkCount: 2,
			failedChunks: [2],
			retryCount: 0,
			statusCode: 400,
		});
	});

	it("does not increment editCount when the final edit fails", async () => {
		const { service, transport } = createService();
		transport.editOriginalMessage.mockRejectedValue(
			discordError(400, { retryable: false }),
		);

		const result = await service.deliverFinal("answer");

		expect(result).toMatchObject({
			status: "failed",
			success: false,
			editCount: 0,
			chunkCount: 0,
			failedChunks: [0],
			statusCode: 400,
		});
	});

	it("retries 429 with Retry-After", async () => {
		const { service, transport, sleep } = createService();
		transport.editOriginalMessage
			.mockRejectedValueOnce(
				discordError(429, { retryable: true, retryAfterMs: 2500 }),
			)
			.mockResolvedValueOnce(undefined);

		const result = await service.deliverFinal("answer");

		expect(transport.editOriginalMessage).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(2500);
		expect(result.retryCount).toBe(1);
		expect(result.success).toBe(true);
	});

	it("retries 5xx but does not retry permanent 4xx", async () => {
		const retryable = createService();
		retryable.transport.postMessage
			.mockRejectedValueOnce(discordError(500))
			.mockResolvedValueOnce(undefined);

		await expect(
			retryable.service.deliverFollowup("answer"),
		).resolves.toMatchObject({ success: true, retryCount: 1 });
		expect(retryable.transport.postMessage).toHaveBeenCalledTimes(2);

		const permanent = createService();
		permanent.transport.postMessage.mockRejectedValue(
			discordError(403, { retryable: false }),
		);

		await expect(
			permanent.service.deliverFollowup("answer"),
		).resolves.toMatchObject({
			status: "failed",
			success: false,
			retryCount: 0,
			statusCode: 403,
		});
		expect(permanent.transport.postMessage).toHaveBeenCalledTimes(1);
		expect(permanent.sleep).not.toHaveBeenCalled();
	});
});
