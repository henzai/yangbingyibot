import type { LlmMessage, LlmPrompt } from "./types";

export type AnswerPromptInput = {
	description: string;
	knowledge: string;
	history: readonly LlmMessage[];
	question: string;
};

export function buildAnswerPrompt(input: AnswerPromptInput): LlmPrompt {
	return {
		systemInstruction: `${input.description}

以下の回答ルールを必ず守ってください。
- 質問と同じ言語で回答してください。
- スプレッドシートの情報をそのまま転載せず、質問に必要な事実を要約・整理してください。
- HTMLタグは使わず、Discordで表示できるプレーンテキストまたはMarkdownを使ってください。改行には実際の改行文字を使ってください。
- 情報源に外国語の一般語句がある場合は回答言語へ訳し、固有名詞は必要に応じて原語を併記してください。
- 人物の経歴を尋ねられた場合は、最初に2〜3文で概要を示し、その後に主要な出来事だけを時系列の箇条書きで示してください。
- 重複する出来事や細かな受賞歴はまとめ、網羅的な情報が必要な場合は追加で質問できることを案内してください。`,
		context: input.knowledge,
		messages: [
			...input.history.map(({ role, text }) => ({ role, text })),
			{ role: "user", text: `質問: ${input.question}` },
		],
	};
}

export function buildThinkingSummaryPrompt(
	previousSummary: string,
	newThinking: string,
): LlmPrompt {
	return {
		systemInstruction:
			"前回の要約に新しい思考内容を反映し、AIの思考過程を日本語の1文（50文字以内）に要約してください。要約文だけを出力してください。",
		messages: [
			{
				role: "user",
				text: `前回の要約:\n${previousSummary || "（なし）"}\n\n新しい思考内容:\n${newThinking}`,
			},
		],
	};
}
