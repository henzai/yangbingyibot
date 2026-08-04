import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../utils/logger";
import { THINKING_FALLBACK, ThinkingSummarizer } from "./thinkingSummarizer";
import type { IGeminiGateway } from "./types";

const gateway = {
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
		gateway.generateText.mockResolvedValue({ text: " 要約結果 ", usage: null });

		const result = await new ThinkingSummarizer(
			gateway as unknown as IGeminiGateway,
			"summary-model",
			log,
		).summarize("前の要約", "new thought");

		expect(result).toEqual({ text: "要約結果", usage: null, success: true });
		expect(gateway.generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "summary-model",
				temperature: 0,
				maxOutputTokens: 128,
				prompt: expect.objectContaining({
					contents: [
						{
							role: "user",
							parts: [
								{
									text: "前回の要約:\n前の要約\n\n新しい思考内容:\nnew thought",
								},
							],
						},
					],
				}),
			}),
		);
	});

	it("returns fallback for an empty summary", async () => {
		gateway.generateText.mockResolvedValue({ text: " ", usage: null });

		await expect(
			new ThinkingSummarizer(
				gateway as unknown as IGeminiGateway,
				"model",
				log,
			).summarize("", "thought"),
		).resolves.toEqual({
			text: THINKING_FALLBACK,
			usage: null,
			success: false,
		});
	});

	it("returns fallback when summary generation fails", async () => {
		gateway.generateText.mockRejectedValue(new Error("unavailable"));

		await expect(
			new ThinkingSummarizer(
				gateway as unknown as IGeminiGateway,
				"model",
				log,
			).summarize("", "thought"),
		).resolves.toEqual({
			text: THINKING_FALLBACK,
			usage: null,
			success: false,
		});
		expect(log.warn).toHaveBeenCalledWith(
			"Thinking summarization failed (non-fatal)",
			expect.objectContaining({ service: "gemini" }),
		);
	});
});
