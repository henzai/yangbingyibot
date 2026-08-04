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
		expect(prompt.systemInstruction).toContain("質問と同じ言語");
		expect(prompt.systemInstruction).toContain("そのまま転載せず");
		expect(prompt.systemInstruction).toContain("HTMLタグは使わず");
		expect(prompt.systemInstruction).toContain("2〜3文で概要");
		expect(prompt.systemInstruction).toContain("時系列の箇条書き");
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
	it("places the previous summary and new thought in user content", () => {
		const prompt = buildThinkingSummaryPrompt("前の要約", "private thought");

		expect(prompt.systemInstruction).toContain("50文字以内");
		expect(prompt.systemInstruction).not.toContain("private thought");
		expect(prompt.contents).toEqual([
			{
				role: "user",
				parts: [
					{
						text: "前回の要約:\n前の要約\n\n新しい思考内容:\nprivate thought",
					},
				],
			},
		]);
	});

	it("初回は前回の要約がないことを明示する", () => {
		const prompt = buildThinkingSummaryPrompt("", "first thought");

		expect(prompt.contents[0]?.parts[0]?.text).toContain(
			"前回の要約:\n（なし）",
		);
	});
});
