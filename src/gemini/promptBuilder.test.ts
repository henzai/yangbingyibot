import { describe, expect, it } from "vitest";
import { buildAnswerPrompt, buildThinkingSummaryPrompt } from "./promptBuilder";

describe("buildAnswerPrompt", () => {
	it("keeps instructions, knowledge, history, and the question in separate fields", () => {
		const prompt = buildAnswerPrompt({
			description: "回答方針",
			knowledge: "シートの知識",
			history: [
				{ role: "user", text: "質問: 前の質問" },
				{ role: "model", text: "前の回答" },
			],
			question: "新しい質問",
		});

		expect(prompt.systemInstruction).toContain("回答方針");
		expect(prompt.systemInstruction).toContain("シートの知識");
		expect(prompt.contents).toEqual([
			{ role: "user", parts: [{ text: "質問: 前の質問" }] },
			{ role: "model", parts: [{ text: "前の回答" }] },
			{ role: "user", parts: [{ text: "質問: 新しい質問" }] },
		]);
		expect(prompt.systemInstruction).not.toContain("新しい質問");
	});

	it("does not invent history when none exists", () => {
		const prompt = buildAnswerPrompt({
			description: "description",
			knowledge: "knowledge",
			history: [],
			question: "question",
		});

		expect(prompt.contents).toEqual([
			{ role: "user", parts: [{ text: "質問: question" }] },
		]);
	});
});

describe("buildThinkingSummaryPrompt", () => {
	it("places thought text in user content instead of the instruction", () => {
		const prompt = buildThinkingSummaryPrompt("private thought");

		expect(prompt.systemInstruction).toContain("50文字以内");
		expect(prompt.systemInstruction).not.toContain("private thought");
		expect(prompt.contents).toEqual([
			{ role: "user", parts: [{ text: "private thought" }] },
		]);
	});
});
