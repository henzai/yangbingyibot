import { describe, expect, it } from "vitest";
import { StreamCoordinator } from "./streamCoordinator";

const config = {
	responseEditIntervalMs: 100,
	responseMinChunkSize: 5,
	thinkingEditIntervalMs: 50,
	thinkingMinChunkSize: 4,
};

describe("StreamCoordinator", () => {
	it("emits the first thinking update and accumulates thought deltas", () => {
		const coordinator = new StreamCoordinator(config);

		const first = coordinator.handle(
			{ type: "reasoning_summary", delta: "abc" },
			10,
		);
		expect(first).toMatchObject({ phase: "thinking", text: "abc" });
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(
			coordinator.handle({ type: "reasoning_summary", delta: "def" }, 20),
		).toBeNull();
		expect(coordinator.getResult().thinking).toBe("abcdef");
	});

	it("requires both elapsed time and enough added text for another summary", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle(
			{ type: "reasoning_summary", delta: "start" },
			0,
		);
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(
			coordinator.handle({ type: "reasoning_summary", delta: "long" }, 40),
		).toBeNull();
		expect(
			coordinator.handle({ type: "reasoning_summary", delta: "x" }, 60),
		).toMatchObject({ text: "startlongx" });
	});

	it("forces an immediate preview when response starts", () => {
		const coordinator = new StreamCoordinator(config);
		const thinking = coordinator.handle(
			{ type: "reasoning_summary", delta: "thought" },
			100,
		);
		if (thinking) {
			coordinator.markDelivered(thinking);
		}

		expect(coordinator.handle({ type: "text", delta: "a" }, 101)).toMatchObject(
			{ phase: "response", text: "a" },
		);
	});

	it("throttles response updates using time and added length", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle({ type: "text", delta: "a" }, 0);
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(coordinator.handle({ type: "text", delta: "bcdef" }, 50)).toBeNull();
		expect(coordinator.handle({ type: "text", delta: "g" }, 100)).toMatchObject(
			{ text: "abcdefg" },
		);
	});

	it("only advances throttle state after a successful delivery is recorded", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle({ type: "text", delta: "first" }, 100);
		expect(first).not.toBeNull();

		expect(
			coordinator.handle({ type: "text", delta: " more" }, 101),
		).toMatchObject({ text: "first more" });
	});

	it("retains typed usage without mixing thought into the response", () => {
		const coordinator = new StreamCoordinator(config);
		coordinator.handle({ type: "reasoning_summary", delta: "private" }, 0);
		coordinator.handle({ type: "text", delta: "public" }, 1);
		coordinator.handle(
			{
				type: "usage",
				usage: {
					inputTokens: 10,
					cachedInputTokens: 2,
					reasoningTokens: 3,
					outputTokens: 4,
					totalTokens: 17,
				},
			},
			2,
		);

		expect(coordinator.getResult()).toMatchObject({
			phase: "response",
			thinking: "private",
			response: "public",
			usage: { totalTokens: 17 },
		});
	});

	it("records the finish reason without emitting a preview update", () => {
		const coordinator = new StreamCoordinator(config);
		coordinator.handle({ type: "reasoning_summary", delta: "thought only" }, 0);

		expect(
			coordinator.handle(
				{
					type: "finish",
					finish: { reason: "length", providerFinishReason: "MAX_TOKENS" },
				},
				1000,
			),
		).toBeNull();
		expect(coordinator.getResult()).toMatchObject({
			phase: "thinking",
			response: "",
			finish: { reason: "length", providerFinishReason: "MAX_TOKENS" },
		});
	});

	it("records a prompt block reason from the finish event", () => {
		const coordinator = new StreamCoordinator(config);

		expect(
			coordinator.handle(
				{
					type: "finish",
					finish: {
						reason: "blocked",
						providerFinishReason: "SAFETY",
						providerBlockReason: "SAFETY",
					},
				},
				0,
			),
		).toBeNull();
		expect(coordinator.getResult()).toMatchObject({
			finish: {
				reason: "blocked",
				providerFinishReason: "SAFETY",
				providerBlockReason: "SAFETY",
			},
		});
	});

	it("leaves both reasons undefined when the stream finishes without them", () => {
		const coordinator = new StreamCoordinator(config);
		coordinator.handle({ type: "text", delta: "hi" }, 0);
		coordinator.handle({ type: "finish", finish: { reason: "unknown" } }, 1);

		expect(coordinator.getResult()).toMatchObject({
			response: "hi",
			finish: { reason: "unknown" },
		});
	});
});
