import { describe, expect, it } from "vitest";
import { catalogText } from "../../workflows/sheetTools/tools";
import {
	AFFILIATION_DICTIONARY,
	AFFILIATION_DICTIONARY_VERSION,
} from "./affiliations";
import { artificialMembers, fixture, ok, queryArgs } from "./testFixtures";
import type { Field, Operator, Where } from "./types";

const member = (
	sid: string,
	primary: string,
	secondary: string,
	status = "99",
) => ({
	...artificialMembers[0],
	sid,
	full_name: `所属${sid}`,
	primary_affiliation: primary,
	secondary_affiliation: secondary,
	status,
});
const where = (field: Field, op: Operator, ...values: string[]): Where => ({
	any: [{ all: [{ field, op, values }] }],
});
const FIELDS: Field[] = [
	"current_group",
	"current_team",
	"primary_affiliation",
	"secondary_affiliation",
];

describe("current affiliation dictionary v1", () => {
	it("is frozen and versioned", () => {
		expect(AFFILIATION_DICTIONARY_VERSION).toBe(1);
		expect(Object.isFrozen(AFFILIATION_DICTIONARY)).toBe(true);
		expect(Object.isFrozen(AFFILIATION_DICTIONARY.B)).toBe(true);
	});
	const cases: [string, string, string][] = [
		["SII", "SNH48", "SII"],
		["NII", "SNH48", "NII"],
		["HII", "SNH48", "HII"],
		["X", "SNH48", "X"],
		["SNH预备生", "SNH48", "预备生"],
		["G", "GNZ48", "G"],
		["NIII", "GNZ48", "NIII"],
		["Z", "GNZ48", "Z"],
		["GNZ预备生", "GNZ48", "预备生"],
		["B", "BEJ48", "B"],
		["E", "BEJ48", "E"],
		["BEJ预备生", "BEJ48", "预备生"],
		["C", "CKG48", "C"],
		["K", "CKG48", "K"],
		["CKG预备生", "CKG48", "预备生"],
		["CII", "CGT48", "CII"],
		["CGT预备生", "CGT48", "预备生"],
		["IDFT", "IDFT", "IDFT"],
	];
	it.each(cases)("maps %s", async (label, group, team) => {
		const { engine } = await fixture([member("1", label, "")]);
		const result = await engine.execute("query_records", {
			...queryArgs,
			fields: FIELDS,
		});
		ok(result);
		const cells = result.records[0].cells;
		expect(cells.current_group?.value).toEqual([group]);
		expect(cells.current_team?.value).toEqual([team]);
		expect(cells.current_group?.source_fields).toEqual([
			"status",
			"primary_affiliation",
			"secondary_affiliation",
		]);
	});
	it("derives from secondary affiliation with primary team first", async () => {
		const { engine } = await fixture([member("1", "IDFT", "E")]);
		const result = await engine.execute("query_records", {
			...queryArgs,
			fields: FIELDS,
		});
		ok(result);
		const cells = result.records[0].cells;
		expect(cells.current_group?.value).toEqual(["BEJ48", "IDFT"]);
		expect(cells.current_team?.value).toEqual(["IDFT", "E"]);
		expect(cells.secondary_affiliation?.value).toEqual(["E"]);
	});
	it("treats inactive as an empty set: not matched, not unknown, missing", async () => {
		const { engine } = await fixture([
			member("1", "B", ""),
			member("2", "暫休/退団", "", "44"),
		]);
		const eq = await engine.execute("query_records", {
			...queryArgs,
			where: where("current_group", "eq", "BEJ48"),
		});
		ok(eq);
		expect(eq.records.map((r) => r.id.split(":").at(-1))).toEqual(["1"]);
		expect(eq.unknown_count).toBe(0);
		const missing = await engine.execute("query_records", {
			...queryArgs,
			where: where("current_group", "is_missing"),
		});
		ok(missing);
		expect(missing.records.map((r) => r.id.split(":").at(-1))).toEqual(["2"]);
		expect(missing.unknown_count).toBe(0);
	});
	it("counts conflicting, unknown-status and unmapped records as unknown", async () => {
		const { engine } = await fixture([
			member("1", "B", ""),
			member("2", "SNH荣誉毕业生", ""),
			member("3", "ZZZ", "B"),
			member("4", "", ""),
			member("5", "B", "", ""),
		]);
		const result = await engine.execute("query_records", {
			...queryArgs,
			fields: ["current_group"],
			where: where("current_group", "eq", "BEJ48"),
		});
		ok(result);
		expect(result.records.map((r) => r.id.split(":").at(-1))).toEqual(["1"]);
		expect(result.unknown_count).toBe(4);
		const all = await engine.execute("query_records", {
			...queryArgs,
			fields: ["current_group"],
		});
		ok(all);
		const reasons = Object.fromEntries(
			all.records.map((r) => [
				r.id.split(":").at(-1),
				r.cells.current_group?.reason,
			]),
		);
		expect(reasons).toMatchObject({
			"2": "conflicting",
			"3": "unmapped_affiliation",
			"4": "no_current_affiliation",
			"5": "unknown",
		});
	});
	it("returns the exact set of active BEJ48 members", async () => {
		const { engine } = await fixture([
			member("1", "B", ""),
			member("2", "E", "IDFT"),
			member("3", "IDFT", "B"),
			member("4", "BEJ预备生", ""),
			member("5", "C", ""),
			member("6", "B", "", "44"),
		]);
		const result = await engine.execute("query_records", {
			...queryArgs,
			where: {
				any: [
					{
						all: [
							{ field: "state_flags", op: "eq", values: ["active"] },
							{ field: "current_group", op: "eq", values: ["BEJ48"] },
						],
					},
				],
			},
		});
		ok(result);
		expect(result.coverage).toBe("exact_set");
		expect(result.matched_count).toBe(4);
		expect(result.records.map((r) => r.id.split(":").at(-1)).sort()).toEqual([
			"1",
			"2",
			"3",
			"4",
		]);
	});
	it("shows both fields as available in the catalog", async () => {
		const { engine } = await fixture();
		const catalog = engine.catalog("members");
		for (const field of ["current_group", "current_team"]) {
			const entry = catalog.find((e) => e.field === field);
			expect(entry).toMatchObject({
				type: "set",
				available: true,
				unavailable_reason: null,
			});
			expect(entry?.source).toContain("現在の所属");
		}
		const text = catalogText(engine);
		expect(text).toContain("- current_group (set): 現在の所属グループ");
		expect(text).toContain("- current_team (set): 現在の所属チーム");
		expect(text).toContain("- generation_group (text)");
	});
});
