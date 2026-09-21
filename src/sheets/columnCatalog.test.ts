import { describe, expect, it } from "vitest";
import {
	IDENTITY_COLUMN_CATALOG,
	SELECTABLE_COLUMN_CATALOG,
	SHEET_COLUMN_CATALOG,
	SHEET_SOURCE_INDICES,
} from "./columnCatalog";

describe("sheet column catalog", () => {
	it("defines four identity and forty selectable columns", () => {
		expect(IDENTITY_COLUMN_CATALOG).toHaveLength(4);
		expect(SELECTABLE_COLUMN_CATALOG).toHaveLength(40);
		expect(SHEET_COLUMN_CATALOG).toHaveLength(44);
	});

	it("keeps source indexes distinct from compacted TSV indexes", () => {
		expect(new Set(SHEET_SOURCE_INDICES).size).toBe(44);
		expect(SHEET_SOURCE_INDICES).toEqual([
			7,
			8,
			10,
			11,
			3,
			4,
			5,
			9,
			...Array.from({ length: 35 }, (_, i) => i + 12),
			47,
		]);
		expect(SHEET_SOURCE_INDICES).not.toContain(6);
	});

	it("keeps election years in source order", () => {
		expect(
			SELECTABLE_COLUMN_CATALOG.filter((column) =>
				column.key.startsWith("election_"),
			).map((column) => column.sourceIndex),
		).toEqual(Array.from({ length: 13 }, (_, i) => i + 34));
	});
});
