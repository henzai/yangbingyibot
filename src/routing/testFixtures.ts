import {
	COLUMN_CATALOG_VERSION,
	SHEET_COLUMN_KEYS,
	type SheetColumnKey,
} from "../sheets/columnCatalog";
import {
	type ReadySheetStructure,
	SHEET_STRUCTURE_VERSION,
} from "../sheets/structuredSheet";

// Test-only helper. Every person is artificial; never add real sheet rows here.
export type FixturePerson = Partial<Record<SheetColumnKey, string>>;

function projectRow(values: FixturePerson): string[] {
	return SHEET_COLUMN_KEYS.map((key) => values[key] ?? "");
}

export function createStructure(people: FixturePerson[]): ReadySheetStructure {
	return {
		status: "ready",
		schemaVersion: SHEET_STRUCTURE_VERSION,
		catalogVersion: COLUMN_CATALOG_VERSION,
		columnKeys: [...SHEET_COLUMN_KEYS],
		headerRows: [projectRow({}), projectRow({}), projectRow({})],
		personRows: people.map(projectRow),
		availableYears: [],
		latestDataYear: null,
	};
}
