import {
	PRESERVED_HEADER_ROWS,
	parseCsv,
	shouldKeepSheetRow,
} from "../utils/compactSheet";
import {
	COLUMN_CATALOG_VERSION,
	SHEET_COLUMN_KEYS,
	SHEET_SOURCE_INDICES,
	type SheetColumnKey,
} from "./columnCatalog";

export const SHEET_STRUCTURE_VERSION = 1 as const;

export type SheetStructureUnavailableReason =
	| "empty"
	| "unsupported_schema"
	| "schema_mismatch"
	| "invalid_snapshot";

export type ReadySheetStructure = {
	status: "ready";
	schemaVersion: typeof SHEET_STRUCTURE_VERSION;
	catalogVersion: typeof COLUMN_CATALOG_VERSION;
	columnKeys: SheetColumnKey[];
	headerRows: string[][];
	personRows: string[][];
	availableYears: number[];
	latestDataYear: number | null;
};

export type UnavailableSheetStructure = {
	status: "unavailable";
	schemaVersion: typeof SHEET_STRUCTURE_VERSION;
	catalogVersion: typeof COLUMN_CATALOG_VERSION;
	reason: SheetStructureUnavailableReason;
};

export type SheetStructure = ReadySheetStructure | UnavailableSheetStructure;

export type SchemaAnchor = {
	row: 1 | 2;
	column: number;
	value: string;
};

type SchemaValueRule = {
	column: number;
	matches: (value: string) => boolean;
};

// These anchors are the stable metadata/header cells in the current sheet.
// Some source columns intentionally have blank headers; their source indexes
// remain part of the catalog and are protected by the value rules below.
export const SHEET_SCHEMA_ANCHORS: readonly SchemaAnchor[] = [
	{ row: 1, column: 3, value: "メンバーの所属チームを示しています。" },
	{ row: 1, column: 4, value: "メンバーの所属チームその2です。" },
	{ row: 1, column: 5, value: "新人組のメンバーか否かを表しています。" },
	{ row: 1, column: 7, value: "メンバーの名前です。" },
	{ row: 1, column: 10, value: "メンバーのイニシャルです。" },
	{ row: 1, column: 11, value: "我々がメンバーに付けているあだ名を表します。" },
	{ row: 1, column: 12, value: "メンバーのあだ名の由来を示します。" },
	{
		row: 1,
		column: 15,
		value:
			'メンバーが入団した期数を示します。例えば、"SNH 4th"はSNH48グループの4期生を示します。',
	},
	{ row: 1, column: 17, value: "メンバーの星座です。" },
	{
		row: 1,
		column: 18,
		value:
			'メンバーの出身地です。ピンイン表記で書かれています。例: "Hebei", "Henan"',
	},
	{
		row: 1,
		column: 19,
		value:
			'メンバーの出身地の市区を示します。ピンイン表記で書かれています。例: "Shijiazhuang", "Zhengzhou"',
	},
	{ row: 1, column: 20, value: "メンバーのスキルです。" },
	{ row: 1, column: 21, value: "メンバーの趣味です。" },
	{ row: 1, column: 22, value: "メンバーのキャッチフレーズです。" },
	{
		row: 1,
		column: 23,
		value:
			"メンバーの公式ニックネームを示します。我々がつけた「あだ名」ではありません。",
	},
	{ row: 1, column: 24, value: "メンバーの公式英語名を示します。" },
	{
		row: 1,
		column: 25,
		value: "メンバーが在籍している、もしくは卒業した大学を示します。",
	},
	{ row: 1, column: 26, value: "メンバーの血液型です。" },
	{ row: 1, column: 27, value: "メンバーのMBTI（性格）です。" },
	{ row: 1, column: 30, value: "メンバーの応援色です。" },
	{ row: 1, column: 31, value: "メンバーの応援色を詳しく言った場合です。" },
	{ row: 1, column: 32, value: "メンバーの2つ目の応援色です。" },
	{
		row: 1,
		column: 33,
		value: "メンバーの2つ目の応援色を詳しく言った場合です。",
	},
	{ row: 1, column: 47, value: "メンバーの経歴です。" },
	{ row: 2, column: 3, value: "本所属" },
	{ row: 2, column: 7, value: "姓名" },
	{ row: 2, column: 11, value: "あだ名" },
	{ row: 2, column: 12, value: "あだ名の由来" },
	{ row: 2, column: 15, value: "期数" },
	{ row: 2, column: 17, value: "星座" },
	{ row: 2, column: 18, value: "出身省" },
	{ row: 2, column: 19, value: "出身市" },
	{ row: 2, column: 20, value: "特徴" },
	{ row: 2, column: 21, value: "趣味" },
	{ row: 2, column: 22, value: "キャッチフレーズ" },
	{ row: 2, column: 23, value: "公式ニックネーム" },
	{ row: 2, column: 24, value: "公式英語名" },
	{ row: 2, column: 25, value: "大学" },
	{ row: 2, column: 26, value: "血液型" },
	{ row: 2, column: 27, value: "MBTI" },
	{ row: 2, column: 30, value: "応援色1" },
	{ row: 2, column: 31, value: "応援色1詳細" },
	{ row: 2, column: 32, value: "応援色2" },
	{ row: 2, column: 33, value: "応援色2詳細" },
	...Array.from({ length: 13 }, (_, offset) => ({
		row: 2 as const,
		column: 34 + offset,
		value: String(2014 + offset),
	})),
	{ row: 2, column: 47, value: "経歴" },
];

const PLACEHOLDER_VALUE = /^(?:-|—|–|不明|不詳|unknown|#?n\/a)$/i;

function isPlaceholder(value: string): boolean {
	const trimmed = value.trim();
	return trimmed === "" || PLACEHOLDER_VALUE.test(trimmed);
}

function isNumberInRange(
	value: string,
	minimum: number,
	maximum: number,
): boolean {
	if (isPlaceholder(value)) return true;
	const number = Number(
		value.replaceAll(",", "").replace(/\s*(?:cm|歳)$/i, ""),
	);
	return Number.isFinite(number) && number >= minimum && number <= maximum;
}

function parseYear(value: string): number | null {
	const year = value.match(/(?:19|20)\d{2}/)?.[0];
	return year === undefined ? null : Number(year);
}

// Some live-sheet columns intentionally have blank metadata/header cells. They
// cannot be identified by a text anchor, so fail closed when their person-cell
// shapes no longer match the catalog meaning. This catches local swaps between
// blank-header columns instead of silently projecting them under the wrong key.
const SHEET_SCHEMA_VALUE_RULES: readonly SchemaValueRule[] = [
	{
		column: 8,
		matches: (value) =>
			isPlaceholder(value) ||
			/^[\p{Script=Latin}\p{Mark}\s.'’·-]+$/u.test(value.trim()),
	},
	{ column: 9, matches: (value) => isNumberInRange(value, 0, 120) },
	{ column: 16, matches: (value) => isNumberInRange(value, 120, 220) },
	{ column: 28, matches: (value) => isNumberInRange(value, 0, 100) },
	{
		column: 29,
		matches: (value) => isPlaceholder(value) || /^\d[\d,]*$/.test(value.trim()),
	},
];

export function createUnavailableSheetStructure(
	reason: SheetStructureUnavailableReason,
): UnavailableSheetStructure {
	return {
		status: "unavailable",
		schemaVersion: SHEET_STRUCTURE_VERSION,
		catalogVersion: COLUMN_CATALOG_VERSION,
		reason,
	};
}

function cell(row: string[] | undefined, column: number): string {
	return row?.[column] ?? "";
}

function matchesSchema(
	rows: string[][],
	personRows: string[][],
	columnCount: number,
): boolean {
	if (columnCount < 48 || rows.length < PRESERVED_HEADER_ROWS) {
		return false;
	}

	const anchorsMatch = SHEET_SCHEMA_ANCHORS.every(
		(anchor) => cell(rows[anchor.row], anchor.column).trim() === anchor.value,
	);
	if (!anchorsMatch) return false;

	const valueShapesMatch = SHEET_SCHEMA_VALUE_RULES.every((rule) =>
		personRows.every((row) => rule.matches(cell(row, rule.column))),
	);
	if (!valueShapesMatch) return false;

	// Birthday and debut date have the same general shape, so validate their
	// relationship: when both years are present, birth cannot follow debut.
	return personRows.every((row) => {
		const birthYear = parseYear(cell(row, 13));
		const debutYear = parseYear(cell(row, 14));
		return birthYear === null || debutYear === null || birthYear <= debutYear;
	});
}

function isPositiveRank(value: string): boolean {
	return /^[1-9]\d*$/.test(value.trim());
}

export function buildSheetStructureFromRows(rows: string[][]): SheetStructure {
	if (rows.length === 0) {
		return createUnavailableSheetStructure("empty");
	}

	const columnCount = Math.max(...rows.map((row) => row.length));
	const keptRows = rows.filter(shouldKeepSheetRow);
	const sourcePersonRows = keptRows.slice(PRESERVED_HEADER_ROWS);
	if (!matchesSchema(rows, sourcePersonRows, columnCount)) {
		return createUnavailableSheetStructure(
			rows.length < PRESERVED_HEADER_ROWS || columnCount < 48
				? "unsupported_schema"
				: "schema_mismatch",
		);
	}

	const projectRow = (row: string[]): string[] =>
		SHEET_SOURCE_INDICES.map((sourceIndex) => cell(row, sourceIndex));
	const headerRows = keptRows.slice(0, PRESERVED_HEADER_ROWS).map(projectRow);
	const personRows = sourcePersonRows.map(projectRow);
	const electionYears = Array.from({ length: 13 }, (_, offset) => {
		const sourceIndex = 34 + offset;
		return sourcePersonRows.some((row) =>
			isPositiveRank(cell(row, sourceIndex)),
		)
			? 2014 + offset
			: null;
	}).filter((year): year is number => year !== null);

	return {
		status: "ready",
		schemaVersion: SHEET_STRUCTURE_VERSION,
		catalogVersion: COLUMN_CATALOG_VERSION,
		columnKeys: [...SHEET_COLUMN_KEYS],
		headerRows,
		personRows,
		availableYears: electionYears,
		latestDataYear: electionYears.at(-1) ?? null,
	};
}

export function buildSheetStructure(csv: string): SheetStructure {
	return buildSheetStructureFromRows(parseCsv(csv));
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isSheetStructure(value: unknown): value is SheetStructure {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== SHEET_STRUCTURE_VERSION ||
		value.catalogVersion !== COLUMN_CATALOG_VERSION
	) {
		return false;
	}

	if (value.status === "unavailable") {
		return (
			typeof value.reason === "string" &&
			[
				"empty",
				"unsupported_schema",
				"schema_mismatch",
				"invalid_snapshot",
			].includes(value.reason)
		);
	}

	if (value.status !== "ready") return false;
	if (
		!Array.isArray(value.columnKeys) ||
		value.columnKeys.length !== SHEET_COLUMN_KEYS.length ||
		value.columnKeys.some((key, index) => key !== SHEET_COLUMN_KEYS[index])
	) {
		return false;
	}
	if (
		!Array.isArray(value.headerRows) ||
		value.headerRows.length !== PRESERVED_HEADER_ROWS ||
		!value.headerRows.every(
			(row) => isStringArray(row) && row.length === SHEET_COLUMN_KEYS.length,
		)
	) {
		return false;
	}
	if (
		!Array.isArray(value.personRows) ||
		!value.personRows.every(
			(row) => isStringArray(row) && row.length === SHEET_COLUMN_KEYS.length,
		)
	) {
		return false;
	}
	if (
		!Array.isArray(value.availableYears) ||
		!value.availableYears.every(
			(year) =>
				typeof year === "number" &&
				Number.isInteger(year) &&
				year >= 2014 &&
				year <= 2026,
		)
	) {
		return false;
	}
	return (
		value.latestDataYear === null ||
		value.availableYears.includes(value.latestDataYear)
	);
}
