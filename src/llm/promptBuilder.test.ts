import { describe, expect, it } from "vitest";
import {
	buildAnswerPrompt,
	buildSheetToolPrompt,
	buildThinkingSummaryPrompt,
} from "./promptBuilder";
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
			capabilities: { reasoningSummary: false, tools: false },
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

describe("buildSheetToolPrompt", () => {
	const input = {
		description: "policy",
		questionDate: "2026-10-18",
		catalog: "field catalog text",
		maxToolCalls: 7,
		history: [{ role: "assistant", text: "previous answer" }] as LlmMessage[],
		question: "new question",
	};

	it("keeps the description first and shares the answer rules", () => {
		const prompt = buildSheetToolPrompt(input);
		const legacy = buildAnswerPrompt({
			description: "policy",
			knowledge: "tsv rows",
			history: [],
			question: "q",
		});
		const rules = legacy.systemInstruction.slice("policy\n\n".length);
		expect(prompt.systemInstruction.startsWith("policy\n\n")).toBe(true);
		expect(prompt.systemInstruction).toContain(rules);
	});

	it("includes the question date and tool call budget", () => {
		const { systemInstruction } = buildSheetToolPrompt(input);
		expect(systemInstruction).toContain("2026-10-18");
		expect(systemInstruction).toContain("合計7回");
	});

	it("puts the catalog in context and never in the instruction", () => {
		const prompt = buildSheetToolPrompt(input);
		expect(prompt.context).toBe("field catalog text");
		expect(prompt.systemInstruction).not.toContain("field catalog text");
		expect(prompt.systemInstruction).not.toContain("new question");
	});

	it("maps history and the question like the legacy builder", () => {
		const prompt = buildSheetToolPrompt(input);
		expect(prompt.messages).toEqual([
			{ role: "assistant", text: "previous answer" },
			{ role: "user", text: "質問: new question" },
		]);
		expect(prompt.messages).toEqual(
			buildAnswerPrompt({
				description: "policy",
				knowledge: "",
				history: input.history,
				question: "new question",
			}).messages,
		);
	});

	it("is deterministic for identical inputs", () => {
		expect(buildSheetToolPrompt({ ...input })).toEqual(
			buildSheetToolPrompt({ ...input }),
		);
	});
});
