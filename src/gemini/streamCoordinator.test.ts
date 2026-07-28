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

		const first = coordinator.handle({ type: "thinking", delta: "abc" }, 10);
		expect(first).toMatchObject({ phase: "thinking", text: "abc" });
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(
			coordinator.handle({ type: "thinking", delta: "def" }, 20),
		).toBeNull();
		expect(coordinator.getResult().thinking).toBe("abcdef");
	});

	it("requires both elapsed time and enough added text for another summary", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle({ type: "thinking", delta: "start" }, 0);
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(
			coordinator.handle({ type: "thinking", delta: "long" }, 40),
		).toBeNull();
		expect(
			coordinator.handle({ type: "thinking", delta: "x" }, 60),
		).toMatchObject({ text: "startlongx" });
	});

	it("forces an immediate preview when response starts", () => {
		const coordinator = new StreamCoordinator(config);
		const thinking = coordinator.handle(
			{ type: "thinking", delta: "thought" },
			100,
		);
		if (thinking) {
			coordinator.markDelivered(thinking);
		}

		expect(
			coordinator.handle(
				{ type: "response", delta: "a", accumulated: "a" },
				101,
			),
		).toMatchObject({ phase: "response", text: "a" });
	});

	it("throttles response updates using time and added length", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle(
			{ type: "response", delta: "a", accumulated: "a" },
			0,
		);
		if (first) {
			coordinator.markDelivered(first);
		}

		expect(
			coordinator.handle(
				{ type: "response", delta: "bcdef", accumulated: "abcdef" },
				50,
			),
		).toBeNull();
		expect(
			coordinator.handle(
				{ type: "response", delta: "g", accumulated: "abcdefg" },
				100,
			),
		).toMatchObject({ text: "abcdefg" });
	});

	it("only advances throttle state after a successful delivery is recorded", () => {
		const coordinator = new StreamCoordinator(config);
		const first = coordinator.handle(
			{ type: "response", delta: "first", accumulated: "first" },
			100,
		);
		expect(first).not.toBeNull();

		expect(
			coordinator.handle(
				{ type: "response", delta: " more", accumulated: "first more" },
				101,
			),
		).toMatchObject({ text: "first more" });
	});

	it("retains typed usage without mixing thought into the response", () => {
		const coordinator = new StreamCoordinator(config);
		coordinator.handle({ type: "thinking", delta: "private" }, 0);
		coordinator.handle(
			{ type: "response", delta: "public", accumulated: "public" },
			1,
		);
		coordinator.handle(
			{
				type: "usage",
				usage: {
					promptTokens: 10,
					cachedTokens: 2,
					thoughtsTokens: 3,
					candidatesTokens: 4,
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
});
