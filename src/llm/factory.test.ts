import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config";
import { createLlmGateway } from "./factory";
import type { ILlmGateway } from "./types";

describe("LLM factory", () => {
	it("constructs the registered OpenAI adapter", () => {
		const gateway = createLlmGateway({
			provider: "openai",
			model: "configured-model",
			apiKey: "test-key",
		});
		expect(gateway.provider).toBe("openai");
		expect(gateway.capabilities.reasoningSummary).toBe(true);
	});
	it("constructs only the selected provider", () => {
		const gateway: ILlmGateway = {
			provider: "fake",
			capabilities: { reasoningSummary: false },
			generateStream: vi.fn(),
			generateText: vi.fn(),
		};
		const fake = vi.fn(() => gateway);
		const gemini = vi.fn(() => {
			throw new Error("unused provider must not initialize");
		});
		expect(
			createLlmGateway(
				{ provider: "fake", model: "model", apiKey: "fake-key" },
				undefined,
				{ fake, gemini },
			),
		).toBe(gateway);
		expect(fake).toHaveBeenCalledWith("fake-key", undefined);
		expect(gemini).not.toHaveBeenCalled();
	});
	it.each(["unknown", "__proto__", "constructor"])(
		"rejects unsupported provider %s",
		(provider) => {
			expect(() =>
				createLlmGateway({ provider, model: "model", apiKey: "secret" }),
			).toThrow(ConfigError);
		},
	);
});
