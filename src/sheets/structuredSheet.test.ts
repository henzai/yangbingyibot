import { describe, expect, it } from "vitest";
import {
	buildSheetStructure,
	isSheetStructure,
	SHEET_SCHEMA_ANCHORS,
} from "./structuredSheet";

function csvCell(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function schemaRow(row: 0 | 1 | 2): string[] {
	const values = Array.from({ length: 48 }, () => "");
	for (const anchor of SHEET_SCHEMA_ANCHORS) {
		if (anchor.row === row) values[anchor.column] = anchor.value;
	}
	return values;
}

function createCsv(options?: {
	includeRanks?: boolean;
	mutate?: (rows: string[][]) => void;
}): string {
	const rows = [schemaRow(0), schemaRow(1), schemaRow(2)];
	const first = Array.from({ length: 48 }, () => "");
	first[6] = "source-only-column";
	first[7] = "張三";
	first[8] = "Zhang San";
	first[10] = "ZS";
	first[11] = "めんやんに<br>めんやん";
	if (options?.includeRanks !== false) first[45] = "12";
	rows.push(first);
	const sparse = Array.from({ length: 48 }, () => "");
	sparse[7] = "この行は1セルだけ";
	rows.push(sparse);
	const second = Array.from({ length: 48 }, () => "");
	second[7] = "李四";
	if (options?.includeRanks !== false) second[45] = "8";
	rows.push(second);
	options?.mutate?.(rows);
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

describe("structured sheet snapshot", () => {
	it("preserves raw identity cells and filters rows before projection", () => {
		const result = buildSheetStructure(createCsv());

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.columnKeys).toHaveLength(44);
		expect(result.headerRows).toHaveLength(3);
		expect(result.personRows).toHaveLength(2);
		expect(result.personRows[0][3]).toBe("めんやんに<br>めんやん");
		expect(result.availableYears).toEqual([2025]);
		expect(result.latestDataYear).toBe(2025);
	});

	it("ignores a year heading when all data cells are empty or dummy values", () => {
		const result = buildSheetStructure(
			createCsv({
				includeRanks: false,
				mutate: (rows) => {
					rows[3][46] = "-";
				},
			}),
		);

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.availableYears).toEqual([]);
		expect(result.latestDataYear).toBeNull();
	});

	it("rejects a moved or renamed anchored column", () => {
		const result = buildSheetStructure(
			createCsv({
				mutate: (rows) => {
					rows[2][3] = "移動した列";
				},
			}),
		);

		expect(result).toEqual({
			status: "unavailable",
			schemaVersion: 1,
			catalogVersion: 1,
			reason: "schema_mismatch",
		});
	});

	it("rejects an unsupported short schema", () => {
		expect(buildSheetStructure('"meta"\n"説明"\n"見出し"')).toEqual({
			status: "unavailable",
			schemaVersion: 1,
			catalogVersion: 1,
			reason: "unsupported_schema",
		});
	});

	it("validates cache snapshots without accepting malformed rows", () => {
		const result = buildSheetStructure(createCsv());
		expect(isSheetStructure(result)).toBe(true);
		if (result.status !== "ready") return;
		expect(
			isSheetStructure({
				...result,
				personRows: [["wrong"]],
			}),
		).toBe(false);
	});
});
