import { describe, expect, it } from "vitest";
import { compactSheetCsv } from "./compactSheet";

// 先頭3行はメタ行・列説明行・ヘッダ行として無条件に保持されるため、
// 行除去の検証にはダミーのヘッダを積んでからデータ行を並べる
const HEADER = [
	'"meta","",""',
	'"説明A","説明B","説明C"',
	'"id","name","team"',
].join("\n");

describe("compactSheetCsv", () => {
	it("converts CSV to TSV", () => {
		const result = compactSheetCsv(`${HEADER}\n"1","闫明筠","SII"`);

		expect(result.split("\n")).toEqual([
			"meta\t\t",
			"説明A\t説明B\t説明C",
			"id\tname\tteam",
			"1\t闫明筠\tSII",
		]);
	});

	it("drops columns that are empty in every row", () => {
		const csv = [
			'"meta","","",""',
			'"説明A","","説明C",""',
			'"id","","team",""',
			'"1","","SII",""',
		].join("\n");

		// 2列目と4列目は全行空なので消える
		expect(compactSheetCsv(csv).split("\n")).toEqual([
			"meta\t",
			"説明A\t説明C",
			"id\tteam",
			"1\tSII",
		]);
	});

	it("drops rows holding fewer than two non-empty cells", () => {
		const csv = [
			HEADER,
			'"1","闫明筠","SII"',
			'"","730",""',
			'"2","莫寒","TII"',
		].join("\n");

		const result = compactSheetCsv(csv);

		expect(result).not.toContain("730");
		expect(result.split("\n")).toHaveLength(5);
	});

	it("keeps the first three rows even when sparse", () => {
		const csv = [
			'"2026/07/26","",""',
			'"","",""',
			'"id","",""',
			'"","",""',
		].join("\n");

		const lines = compactSheetCsv(csv).split("\n");

		// 先頭3行は保持され、4行目のスカスカな行だけが落ちる
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("2026/07/26");
		expect(lines[2]).toContain("id");
	});

	it("preserves commas inside quoted fields", () => {
		const csv = `${HEADER}\n"1","Yan, MingJun","SII"`;

		expect(compactSheetCsv(csv).split("\n")[3]).toBe("1\tYan, MingJun\tSII");
	});

	it("unescapes doubled quotes inside quoted fields", () => {
		const csv = `${HEADER}\n"1","She said ""hi""","SII"`;

		expect(compactSheetCsv(csv).split("\n")[3]).toBe('1\tShe said "hi"\tSII');
	});

	it("replaces tabs inside cells so they cannot break the TSV layout", () => {
		const csv = `${HEADER}\n"1","Yan\tMingJun","SII"`;

		const columns = compactSheetCsv(csv).split("\n")[3].split("\t");

		expect(columns).toHaveLength(3);
		expect(columns[1]).toBe("Yan MingJun");
	});

	it("trims surrounding whitespace in cells", () => {
		const csv = `${HEADER}\n"1","  闫明筠  ","SII"`;

		expect(compactSheetCsv(csv).split("\n")[3]).toBe("1\t闫明筠\tSII");
	});

	it("handles a final row without a trailing newline", () => {
		const csv = `${HEADER}\n"1","闫明筠","SII"`;

		expect(compactSheetCsv(csv).split("\n")).toHaveLength(4);
	});

	it("returns an empty string for empty input", () => {
		expect(compactSheetCsv("")).toBe("");
	});
});
