import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../utils/logger";
import { THINKING_FALLBACK, ThinkingSummarizer } from "./thinkingSummarizer";
import type { ILlmGateway } from "./types";

const gateway = {
	provider: "gemini",
	capabilities: { reasoningSummary: true },
	generateStream: vi.fn(),
	generateText: vi.fn(),
};

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: vi.fn(),
} as unknown as Logger;

describe("ThinkingSummarizer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses the configured summary model through the shared gateway", async () => {
		gateway.generateText.mockResolvedValue({
			text: " 要約結果 ",
			usage: null,
			finish: { reason: "stop" },
		});

		const result = await new ThinkingSummarizer(
			gateway as unknown as ILlmGateway,
			"summary-model",
			log,
		).summarize("前の要約", "new thought");

		expect(result).toEqual({
			text: "要約結果",
			usage: null,
			success: true,
			retryCount: 0,
		});
		expect(gateway.generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "summary-model",
				temperature: 0,
				maxOutputTokens: 128,
				prompt: expect.objectContaining({
					messages: [
						{
							role: "user",
							text: "前回の要約:\n前の要約\n\n新しい思考内容:\nnew thought",
						},
					],
				}),
			}),
		);
	});

	it("returns fallback for an empty summary", async () => {
		gateway.generateText.mockResolvedValue({
			text: " ",
			usage: null,
			finish: { reason: "stop" },
		});

		await expect(
			new ThinkingSummarizer(
				gateway as unknown as ILlmGateway,
				"model",
				log,
			).summarize("", "thought"),
		).resolves.toEqual({
			text: THINKING_FALLBACK,
			usage: null,
			success: false,
			retryCount: 0,
		});
	});

	it.each(["length", "blocked", "error"])(
		"falls back on %s while retaining consumed usage",
		async (reason) => {
			const usage = {
				inputTokens: 1,
				cachedInputTokens: 0,
				reasoningTokens: null,
				outputTokens: 2,
				totalTokens: 3,
			};
			gateway.generateText.mockResolvedValue({
				text: "incomplete summary",
				usage,
				finish: { reason },
			});
			await expect(
				new ThinkingSummarizer(gateway, "summary", log).summarize("", "source"),
			).resolves.toEqual({
				text: THINKING_FALLBACK,
				usage,
				success: false,
				retryCount: 0,
			});
		},
	);
	it("returns fallback when summary generation fails", async () => {
		gateway.generateText.mockRejectedValue(new Error("unavailable"));

		await expect(
			new ThinkingSummarizer(
				gateway as unknown as ILlmGateway,
				"model",
				log,
			).summarize("", "thought"),
		).resolves.toEqual({
			text: THINKING_FALLBACK,
			usage: null,
			success: false,
			retryCount: 0,
		});
		expect(log.warn).toHaveBeenCalledWith(
			"Thinking summarization failed (non-fatal)",
			expect.objectContaining({ service: "llm", provider: "gemini" }),
		);
	});

	it("reports provider retries for one logical summary call", async () => {
		gateway.generateText.mockImplementation(async (request) => {
			request.telemetry?.onAttempt();
			request.telemetry?.onAttempt();
			return {
				text: "summary",
				usage: null,
				finish: { reason: "stop" },
			};
		});

		await expect(
			new ThinkingSummarizer(gateway, "model", log).summarize("", "thought"),
		).resolves.toMatchObject({ success: true, retryCount: 1 });
	});
});
