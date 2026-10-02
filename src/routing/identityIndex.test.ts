import { describe, expect, it } from "vitest";
import {
	buildSheetStructure,
	SHEET_SCHEMA_ANCHORS,
} from "../sheets/structuredSheet";
import { buildIdentityIndex, normalizeIdentityText } from "./identityIndex";
import { createStructure } from "./testFixtures";

function termsOf(index: ReturnType<typeof buildIdentityIndex>) {
	return index.terms.map(({ text, source, personIndex }) => ({
		text,
		source,
		personIndex,
	}));
}

describe("normalizeIdentityText", () => {
	it("applies NFKC, lower-cases Latin and collapses whitespace", () => {
		expect(normalizeIdentityText("　ＺＨＡＮＧ　 Ｓａｎ\t")).toBe("zhang san");
		expect(normalizeIdentityText("ﾒﾝﾔﾝ")).toBe("メンヤン");
	});

	it("strips Latin tone marks but keeps kana voicing marks", () => {
		expect(normalizeIdentityText("Zhāng Yǔ Xīn")).toBe("zhang yu xin");
		expect(normalizeIdentityText("がぱ")).toBe("がぱ");
	});
});

describe("buildIdentityIndex", () => {
	it("indexes only the four identity columns", () => {
		const index = buildIdentityIndex(
			createStructure([
				{
					full_name: "張三",
					pinyin: "Zhang San",
					initials: "ZS",
					community_nicknames: "めんやんに",
					official_nickname: "公式あだ名",
					official_english_name: "Official",
					primary_affiliation: "Team Z",
					generation: "SNH 4th",
				},
			]),
		);

		expect(termsOf(index)).toEqual([
			{ text: "張三", source: "full_name", personIndex: 0 },
			{ text: "zhangsan", source: "pinyin", personIndex: 0 },
			{ text: "zs", source: "initials", personIndex: 0 },
			{ text: "めんやんに", source: "community_nicknames", personIndex: 0 },
		]);
	});

	it("splits nicknames on every supported separator", () => {
		const index = buildIdentityIndex(
			createStructure([
				{
					full_name: "李四",
					community_nicknames:
						"あ1<br>あ2<BR/>あ3\nあ4/あ5／あ6,あ7，あ8、あ9;あ10；あ11|あ12",
				},
			]),
		);

		expect(
			index.terms
				.filter((term) => term.source === "community_nicknames")
				.map((term) => term.text),
		).toEqual(Array.from({ length: 12 }, (_, i) => `あ${i + 1}`));
	});

	it("drops blank and placeholder spellings and duplicate spellings", () => {
		const index = buildIdentityIndex(
			createStructure([
				{
					full_name: "王五",
					pinyin: "-",
					initials: "不明",
					community_nicknames: "赤 / / 赤 / Ｃ / c",
				},
				{ full_name: "-", community_nicknames: "無名" },
				{ full_name: "", community_nicknames: "空欄" },
			]),
		);

		expect(termsOf(index)).toEqual([
			{ text: "王五", source: "full_name", personIndex: 0 },
			{ text: "赤", source: "community_nicknames", personIndex: 0 },
			{ text: "c", source: "community_nicknames", personIndex: 0 },
		]);
	});

	it("keeps people with the same full name apart", () => {
		const index = buildIdentityIndex(
			createStructure([
				{ full_name: "同名", community_nicknames: "あだ名A" },
				{ full_name: "同名", community_nicknames: "あだ名B" },
			]),
		);

		expect(
			index.terms
				.filter((term) => term.source === "full_name")
				.map((term) => term.personIndex),
		).toEqual([0, 1]);
	});

	it("flags Latin and single-character spellings", () => {
		const index = buildIdentityIndex(
			createStructure([
				{
					full_name: "赵六",
					pinyin: "Zhao Liu",
					community_nicknames: "赤/c/you",
				},
			]),
		);
		const flags = Object.fromEntries(
			index.terms.map((term) => [
				term.text,
				[term.isLatin, term.isShortAmbiguous],
			]),
		);

		expect(flags).toEqual({
			赵六: [false, false],
			zhaoliu: [true, false],
			赤: [false, true],
			c: [true, true],
			you: [true, false],
		});
	});

	it("preserves nickname line breaks from a parsed source snapshot", () => {
		const rows = [0, 1, 2].map((row) => {
			const values = Array.from({ length: 48 }, () => "");
			for (const anchor of SHEET_SCHEMA_ANCHORS) {
				if (anchor.row === row) values[anchor.column] = anchor.value;
			}
			return values;
		});
		const person = Array.from({ length: 48 }, () => "");
		person[7] = "張三";
		person[11] = "めんやんに\nめんやん";
		rows.push(person);
		const csv = rows
			.map((row) =>
				row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","),
			)
			.join("\n");
		const structure = buildSheetStructure(csv);

		expect(structure.status).toBe("ready");
		if (structure.status !== "ready") return;
		expect(
			buildIdentityIndex(structure)
				.terms.filter((term) => term.source === "community_nicknames")
				.map((term) => term.text),
		).toEqual(["めんやんに", "めんやん"]);
	});
});
