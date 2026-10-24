import type { Response } from "openai/resources/responses/responses";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILlmGateway, LlmRequest, LlmStreamEvent } from "../types";

const mocks = vi.hoisted(() => ({
	geminiGenerate: vi.fn(),
	geminiStream: vi.fn(),
	openaiCreate: vi.fn(),
}));
vi.mock("@google/genai", () => ({
	ThinkingLevel: { LOW: "LOW" },
	GoogleGenAI: class {
		models = {
			generateContent: mocks.geminiGenerate,
			generateContentStream: mocks.geminiStream,
		};
	},
}));
vi.mock("openai", () => ({
	default: class {
		responses = { create: mocks.openaiCreate };
	},
}));

import { GeminiLlmGateway } from "./gemini";
import { OpenAILlmGateway } from "./openai";

type Provider = "gemini" | "openai";
type Scenario = "success" | "missing_usage" | "length" | "blocked";

const request: LlmRequest = {
	model: "contract-model",
	prompt: {
		systemInstruction: "instruction",
		messages: [{ role: "user", text: "question" }],
	},
};

async function* sequence(...items: unknown[]) {
	for (const item of items) yield item;
}

function openAIResponse(
	status: "completed" | "incomplete" = "completed",
	overrides: Record<string, unknown> = {},
): Response {
	return {
		status,
		output_text: status === "incomplete" ? "partial" : "answer",
		output: [],
		incomplete_details:
			status === "incomplete" ? { reason: "max_output_tokens" } : null,
		error: null,
		usage: {
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 2 },
			output_tokens: 4,
			output_tokens_details: { reasoning_tokens: 1 },
			total_tokens: 14,
		},
		...overrides,
	} as unknown as Response;
}

function createGateway(provider: Provider): ILlmGateway {
	return provider === "gemini"
		? new GeminiLlmGateway("key")
		: new OpenAILlmGateway("key");
}

function prepare(provider: Provider, scenario: Scenario): void {
	if (provider === "gemini") {
		const value =
			scenario === "blocked"
				? { candidates: [{}], promptFeedback: { blockReason: "SAFETY" } }
				: {
						candidates: [
							{
								content: {
									parts: [
										{ text: scenario === "length" ? "partial" : "answer" },
									],
								},
								finishReason: scenario === "length" ? "MAX_TOKENS" : "STOP",
							},
						],
						...(scenario === "missing_usage"
							? {}
							: {
									usageMetadata: {
										promptTokenCount: 10,
										cachedContentTokenCount: 2,
										candidatesTokenCount: 3,
										thoughtsTokenCount: 1,
										totalTokenCount: 14,
									},
								}),
					};
		mocks.geminiGenerate.mockResolvedValue(value);
		mocks.geminiStream.mockResolvedValue(sequence(value));
		return;
	}

	const value =
		scenario === "blocked"
			? openAIResponse("completed", {
					output_text: "",
					output: [
						{
							type: "message",
							content: [{ type: "refusal", refusal: "not returned" }],
						},
					],
					usage: null,
				})
			: scenario === "length"
				? openAIResponse("incomplete")
				: openAIResponse("completed", {
						usage: scenario === "missing_usage" ? null : openAIResponse().usage,
					});
	const streamItems = [
		...(scenario === "blocked"
			? [{ type: "response.refusal.delta", delta: "not returned" }]
			: [
					{
						type: "response.output_text.delta",
						delta: scenario === "length" ? "partial" : "answer",
					},
				]),
		{
			type:
				value.status === "incomplete"
					? "response.incomplete"
					: "response.completed",
			response: value,
		},
	];
	mocks.openaiCreate.mockImplementation((body) =>
		body.stream
			? Promise.resolve(sequence(...streamItems))
			: Promise.resolve(value),
	);
}

async function collect(gateway: ILlmGateway): Promise<LlmStreamEvent[]> {
	const result: LlmStreamEvent[] = [];
	for await (const event of gateway.generateStream(request)) result.push(event);
	return result;
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe.each(["gemini", "openai"] as const)(
	"shared ILlmGateway contract: %s",
	(provider) => {
		it("emits delta text, one cumulative usage snapshot, then one finish", async () => {
			prepare(provider, "success");
			expect(await collect(createGateway(provider))).toEqual([
				{ type: "text", delta: "answer" },
				{
					type: "usage",
					usage: {
						inputTokens: 10,
						cachedInputTokens: 2,
						outputTokens: 3,
						reasoningTokens: 1,
						totalTokens: 14,
					},
				},
				expect.objectContaining({
					type: "finish",
					finish: expect.objectContaining({ reason: "stop" }),
				}),
			]);
		});

		it("returns the same text/usage/finish semantics for generateText", async () => {
			prepare(provider, "success");
			expect(await createGateway(provider).generateText(request)).toMatchObject(
				{
					text: "answer",
					usage: {
						inputTokens: 10,
						cachedInputTokens: 2,
						outputTokens: 3,
						reasoningTokens: 1,
						totalTokens: 14,
					},
					finish: { reason: "stop" },
				},
			);
		});

		it("preserves missing usage", async () => {
			prepare(provider, "missing_usage");
			expect(
				(await createGateway(provider).generateText(request)).usage,
			).toBeNull();
			expect(
				(await collect(createGateway(provider))).filter(
					(event) => event.type === "usage",
				),
			).toEqual([]);
		});

		it.each([
			["length", "partial"],
			["blocked", ""],
		] as const)("normalizes %s completion", async (scenario, text) => {
			prepare(provider, scenario);
			expect(await createGateway(provider).generateText(request)).toMatchObject(
				{
					text,
					finish: { reason: scenario },
				},
			);
		});
	},
);
