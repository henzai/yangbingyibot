import { describe, expect, it, vi } from "vitest";

vi.mock("discord-api-types/v10", () => ({
	InteractionResponseType: {
		ChannelMessageWithSource: 4,
	},
}));

import { errorResponse } from "./errorResponse";

describe("errorResponse", () => {
	it("returns ChannelMessageWithSource type", () => {
		const result = errorResponse("test error");
		// InteractionResponseType.ChannelMessageWithSource = 4
		expect(result.type).toBe(4);
	});

	it("includes error header content", () => {
		const result = errorResponse("test error");
		expect(result.data.content).toBe("🚨 エラーが発生しました");
	});

	it("includes error message in embed description", () => {
		const result = errorResponse("Database connection failed");
		expect(result.data.embeds?.[0].description).toBe(
			"Database connection failed",
		);
	});

	it("uses red color (0xff0000) for error embed", () => {
		const result = errorResponse("any error");
		expect(result.data.embeds?.[0].color).toBe(0xff0000);
	});

	it("handles empty error message", () => {
		const result = errorResponse("");
		expect(result.data.embeds?.[0].description).toBe("");
	});
});
