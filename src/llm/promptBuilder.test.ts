import { describe, expect, it } from "vitest";
import { buildAnswerPrompt, buildThinkingSummaryPrompt } from "./promptBuilder";
import type { ILlmGateway, LlmMessage, LlmStreamEvent } from "./types";

describe("provider-independent prompts", () => {
	it("keeps knowledge and conversation separate from instructions and copies history", () => {
		const history: LlmMessage[] = [
			{ role: "assistant", text: "previous answer" },
		];
		const prompt = buildAnswerPrompt({
			description: "policy",
			knowledge: "knowledge",
			question: "new question",
			history,
		});
		expect(prompt.systemInstruction).toContain("policy");
		expect(prompt.systemInstruction).toContain("HTMLタグは使わず");
		expect(prompt.systemInstruction).not.toContain("knowledge");
		expect(prompt.systemInstruction).not.toContain("new question");
		expect(prompt.systemInstruction).not.toContain("思考過程は必ず");
		expect(prompt.context).toBe("knowledge");
		expect(prompt.messages).toEqual([
			{ role: "assistant", text: "previous answer" },
			{ role: "user", text: "質問: new question" },
		]);
		history[0].text = "changed";
		expect(prompt.messages[0].text).toBe("previous answer");
	});

	it("supports answer and summary prompts through an SDK-free gateway", async () => {
		const gateway: ILlmGateway = {
			provider: "fake",
			capabilities: { reasoningSummary: false },
			async *generateStream(request) {
				yield {
					type: "text",
					delta: request.prompt.messages.at(-1)?.text ?? "",
				};
				yield { type: "finish", finish: { reason: "stop" } };
			},
			async generateText(request) {
				return {
					text: request.prompt.messages[0].text,
					usage: null,
					finish: { reason: "stop" },
				};
			},
		};
		const prompt = buildAnswerPrompt({
			description: "policy",
			knowledge: "facts",
			history: [],
			question: "question",
		});
		const events: LlmStreamEvent[] = [];
		for await (const event of gateway.generateStream({
			model: "fake-model",
			prompt,
		}))
			events.push(event);
		expect(events).toEqual([
			{ type: "text", delta: "質問: question" },
			{ type: "finish", finish: { reason: "stop" } },
		]);
		const summary = buildThinkingSummaryPrompt("", "published summary");
		expect(summary.systemInstruction).not.toContain("published summary");
		expect(
			(await gateway.generateText({ model: "fake-model", prompt: summary }))
				.text,
		).toBe("前回の要約:\n（なし）\n\n新しい思考内容:\npublished summary");
	});
});
