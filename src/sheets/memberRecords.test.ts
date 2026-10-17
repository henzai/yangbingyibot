import { describe, expect, it } from "vitest";
import { SHEET_COLUMN_KEYS } from "./columnCatalog";
import {
	cellState,
	readGeneration,
	readMemberRecords,
	readMemberState,
} from "./memberRecords";
import { memberFixture } from "./testFixtures";

const SOURCE = "a".repeat(64);

describe("member reading contract", () => {
	it("keeps same-name people distinct, source-bound and linked to original rows", () => {
		const sheet = memberFixture();
		sheet.sourceRowNumbers = [4, 19];
		const result = readMemberRecords(sheet, SOURCE);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.records.map((record) => record.id)).toEqual([
			`member:${SOURCE}:101`,
			`member:${SOURCE}:202`,
		]);
		expect(result.records.map((record) => record.sourceRow)).toEqual([4, 19]);
		expect(result.records[0].latestRank).toEqual({ raw: "5", year: null });
		expect(result.records.map((record) => record.generation.group)).toEqual([
			"SNH48",
			"BEJ48",
		]);
	});

	it.each([
		["", "missing_sid"],
		["1.0", "invalid_sid"],
		["0", "invalid_sid"],
		["101", "duplicate_sid"],
	])("rejects unsafe SID %s", (sid, reason) => {
		const sheet = memberFixture();
		sheet.personRows[1][SHEET_COLUMN_KEYS.indexOf("sid")] = sid;
		expect(readMemberRecords(sheet, SOURCE)).toEqual({
			status: "unavailable",
			reason,
		});
	});

	it("retains SID rows with formula-error names and separately counts empty-identity templates", () => {
		const sheet = memberFixture();
		sheet.personRows[0][SHEET_COLUMN_KEYS.indexOf("full_name")] = "#N/A";
		const template = SHEET_COLUMN_KEYS.map(() => "");
		template[SHEET_COLUMN_KEYS.indexOf("age")] = "#N/A";
		template[SHEET_COLUMN_KEYS.indexOf("secondary_affiliation")] = "template";
		sheet.personRows.push(template);
		sheet.sourceRowNumbers.push(99);
		const result = readMemberRecords(sheet, SOURCE);
		if (result.status !== "ready") throw new Error(result.reason);
		expect(result.records).toHaveLength(2);
		expect(cellState(result.records[0].values.full_name)).toBe("formula_error");
		expect(result.excludedSourceRows).toEqual([99]);
	});

	it.each([
		["SNH48 二十四期生", "SNH48", 24],
		["SNH48 ２４期生", "SNH48", 24],
		["旧GROUP 十二期生", "旧GROUP", 12],
		["SNH48 二二期生", null, null],
		["SNH48 新人", null, null],
		["", null, null],
	])("reads generation %s conservatively", (raw, group, number) => {
		expect(readGeneration(String(raw))).toEqual({ raw, group, number });
	});

	it("keeps conflicting status out of active and does not infer status from team alone", () => {
		expect(readMemberState("99", "TeamX", "暫休/退団").state).toBe(
			"conflicting",
		);
		expect(readMemberState("44", "TeamX", "").state).toBe("inactive");
		expect(readMemberState("", "TeamX", "").state).toBe("unknown");
		expect(readMemberState("99", "TeamX", "").state).toBe("active");
	});

	it.each([
		["", "empty"],
		[" — ", "placeholder"],
		["非公開", "not_public"],
		["#N/A", "formula_error"],
		["#REF!", "formula_error"],
		["0", "value"],
	])("distinguishes cell state for %s", (raw, state) => {
		expect(cellState(raw)).toBe(state);
	});
});
