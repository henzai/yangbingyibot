import { describe, expect, it } from "vitest";
import {
	DISCORD_CONTENT_LIMIT,
	formatAnswer,
	formatError,
	formatThinking,
	splitContent,
} from "./formatter";

describe("Discord formatter", () => {
	it("formats answer, thinking, and error content", () => {
		expect(formatAnswer("question", "answer")).toBe("> question\nanswer");
		expect(formatThinking("question", "summary")).toBe(
			"> question\n:thought_balloon: summary",
		);
		expect(formatError("question", "failure")).toBe(
			"> question\n:rotating_light: エラーが発生しました: failure",
		);
	});

	it.each([0, 1, 1999, 2000])(
		"keeps %i UTF-16 code units in one chunk",
		(length) => {
			const content = "a".repeat(length);
			expect(splitContent(content)).toEqual(length === 0 ? [] : [content]);
		},
	);

	it("splits 2001 UTF-16 code units without loss", () => {
		const content = "a".repeat(2001);
		const chunks = splitContent(content);

		expect(chunks.map((chunk) => chunk.length)).toEqual([2000, 1]);
		expect(chunks.join("")).toBe(content);
	});

	it("prefers newline and then space boundaries", () => {
		expect(splitContent("1234\n56789", 6)).toEqual(["1234\n", "56789"]);
		expect(splitContent("1234 56789", 6)).toEqual(["1234 ", "56789"]);
	});

	it("hard-splits content with no whitespace", () => {
		const content = "a".repeat(5000);
		const chunks = splitContent(content);

		expect(chunks.map((chunk) => chunk.length)).toEqual([2000, 2000, 1000]);
		expect(chunks.join("")).toBe(content);
	});

	it("never splits a surrogate pair at the content limit", () => {
		const content = `${"a".repeat(DISCORD_CONTENT_LIMIT - 1)}😀tail`;
		const chunks = splitContent(content);

		expect(chunks[0]).toHaveLength(DISCORD_CONTENT_LIMIT - 1);
		expect(chunks[1]?.startsWith("😀")).toBe(true);
		expect(chunks.every((chunk) => chunk.length <= DISCORD_CONTENT_LIMIT)).toBe(
			true,
		);
		expect(chunks.join("")).toBe(content);
	});

	it("keeps emoji content complete and ordered across chunks", () => {
		const content = "😀".repeat(2500);
		const chunks = splitContent(content);

		expect(chunks).toHaveLength(3);
		expect(chunks.every((chunk) => chunk.length <= DISCORD_CONTENT_LIMIT)).toBe(
			true,
		);
		expect(chunks.join("")).toBe(content);
	});

	it("splits a long question and answer combination without loss", () => {
		const content = formatAnswer("q".repeat(1990), "a".repeat(100));
		const chunks = splitContent(content);

		expect(chunks).toHaveLength(2);
		expect(chunks.every((chunk) => chunk.length <= DISCORD_CONTENT_LIMIT)).toBe(
			true,
		);
		expect(chunks.join("")).toBe(content);
	});

	it("rejects invalid limits", () => {
		expect(() => splitContent("content", 0)).toThrow(RangeError);
		expect(() => splitContent("😀", 1)).toThrow(RangeError);
	});

	it("supports a one-unit limit for single-unit code points", () => {
		expect(splitContent("abc", 1)).toEqual(["a", "b", "c"]);
	});
});
