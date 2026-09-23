import {
	PRESERVED_HEADER_ROWS,
	parseCsv,
	shouldKeepSheetRow,
} from "../utils/compactSheet";
import {
	COLUMN_CATALOG_VERSION,
	ELECTION_COLUMN_CATALOG,
	ELECTION_YEARS,
	getSheetSourceIndex,
	SHEET_COLUMN_KEYS,
	SHEET_SOURCE_INDICES,
	type SheetColumnKey,
} from "./columnCatalog";

export const SHEET_STRUCTURE_VERSION = 1 as const;
const MINIMUM_SOURCE_COLUMN_COUNT = Math.max(...SHEET_SOURCE_INDICES) + 1;

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
	key: SheetColumnKey;
	matches: (value: string) => boolean;
};

function schemaAnchor(
	key: SheetColumnKey,
	row: SchemaAnchor["row"],
	value: string,
): SchemaAnchor {
	return { row, column: getSheetSourceIndex(key), value };
}

// These anchors are the stable metadata/header cells in the current sheet.
// Some source columns intentionally have blank headers; their source indexes
// remain part of the catalog and are protected by the value rules below.
export const SHEET_SCHEMA_ANCHORS: readonly SchemaAnchor[] = [
	schemaAnchor(
		"primary_affiliation",
		1,
		"メンバーの所属チームを示しています。",
	),
	schemaAnchor("secondary_affiliation", 1, "メンバーの所属チームその2です。"),
	schemaAnchor("newcomer_flag", 1, "新人組のメンバーか否かを表しています。"),
	schemaAnchor("full_name", 1, "メンバーの名前です。"),
	schemaAnchor("initials", 1, "メンバーのイニシャルです。"),
	schemaAnchor(
		"community_nicknames",
		1,
		"我々がメンバーに付けているあだ名を表します。",
	),
	schemaAnchor("nickname_origin", 1, "メンバーのあだ名の由来を示します。"),
	schemaAnchor(
		"generation",
		1,
		'メンバーが入団した期数を示します。例えば、"SNH 4th"はSNH48グループの4期生を示します。',
	),
	schemaAnchor("zodiac", 1, "メンバーの星座です。"),
	schemaAnchor(
		"birth_province",
		1,
		'メンバーの出身地です。ピンイン表記で書かれています。例: "Hebei", "Henan"',
	),
	schemaAnchor(
		"birth_city",
		1,
		'メンバーの出身地の市区を示します。ピンイン表記で書かれています。例: "Shijiazhuang", "Zhengzhou"',
	),
	schemaAnchor("skills", 1, "メンバーのスキルです。"),
	schemaAnchor("hobbies", 1, "メンバーの趣味です。"),
	schemaAnchor("catchphrase", 1, "メンバーのキャッチフレーズです。"),
	schemaAnchor(
		"official_nickname",
		1,
		"メンバーの公式ニックネームを示します。我々がつけた「あだ名」ではありません。",
	),
	schemaAnchor("official_english_name", 1, "メンバーの公式英語名を示します。"),
	schemaAnchor(
		"university",
		1,
		"メンバーが在籍している、もしくは卒業した大学を示します。",
	),
	schemaAnchor("blood_type", 1, "メンバーの血液型です。"),
	schemaAnchor("mbti", 1, "メンバーのMBTI（性格）です。"),
	schemaAnchor("support_color_1", 1, "メンバーの応援色です。"),
	schemaAnchor(
		"support_color_1_detail",
		1,
		"メンバーの応援色を詳しく言った場合です。",
	),
	schemaAnchor("support_color_2", 1, "メンバーの2つ目の応援色です。"),
	schemaAnchor(
		"support_color_2_detail",
		1,
		"メンバーの2つ目の応援色を詳しく言った場合です。",
	),
	schemaAnchor("career", 1, "メンバーの経歴です。"),
	schemaAnchor("primary_affiliation", 2, "本所属"),
	schemaAnchor("full_name", 2, "姓名"),
	schemaAnchor("community_nicknames", 2, "あだ名"),
	schemaAnchor("nickname_origin", 2, "あだ名の由来"),
	schemaAnchor("generation", 2, "期数"),
	schemaAnchor("zodiac", 2, "星座"),
	schemaAnchor("birth_province", 2, "出身省"),
	schemaAnchor("birth_city", 2, "出身市"),
	schemaAnchor("skills", 2, "特徴"),
	schemaAnchor("hobbies", 2, "趣味"),
	schemaAnchor("catchphrase", 2, "キャッチフレーズ"),
	schemaAnchor("official_nickname", 2, "公式ニックネーム"),
	schemaAnchor("official_english_name", 2, "公式英語名"),
	schemaAnchor("university", 2, "大学"),
	schemaAnchor("blood_type", 2, "血液型"),
	schemaAnchor("mbti", 2, "MBTI"),
	schemaAnchor("support_color_1", 2, "応援色1"),
	schemaAnchor("support_color_1_detail", 2, "応援色1詳細"),
	schemaAnchor("support_color_2", 2, "応援色2"),
	schemaAnchor("support_color_2_detail", 2, "応援色2詳細"),
	...ELECTION_COLUMN_CATALOG.map((column) => ({
		row: 2 as const,
		column: column.sourceIndex,
		value: String(column.year),
	})),
	schemaAnchor("career", 2, "経歴"),
];

const PLACEHOLDER_VALUE = /^(?:-|—|–|不明|不詳|非公開|未公開|unknown|#?n\/a)$/i;
const MIN_SCHEMA_VALUE_MATCH_RATIO = 0.8;

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
		key: "pinyin",
		matches: (value) =>
			/^[\p{Script=Latin}\p{Mark}\s.'’·-]+$/u.test(value.trim()),
	},
	{ key: "age", matches: (value) => isNumberInRange(value, 0, 120) },
	{ key: "height", matches: (value) => isNumberInRange(value, 120, 220) },
	{ key: "debut_age", matches: (value) => isNumberInRange(value, 0, 100) },
	{
		key: "pocket_followers",
		matches: (value) => /^(?:\d[\d,]*|\d+(?:\.\d+)?万)$/.test(value.trim()),
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

function matchesValueRule(
	personRows: string[][],
	rule: SchemaValueRule,
): boolean {
	const column = getSheetSourceIndex(rule.key);
	const values = personRows
		.map((row) => cell(row, column))
		.filter((value) => !isPlaceholder(value));
	if (values.length === 0) return true;
	const matches = values.filter(rule.matches).length;
	return matches / values.length >= MIN_SCHEMA_VALUE_MATCH_RATIO;
}

function matchesBirthdayDebutOrder(personRows: string[][]): boolean {
	const birthdayColumn = getSheetSourceIndex("birthday");
	const debutDateColumn = getSheetSourceIndex("debut_date");
	const comparableYears = personRows.flatMap((row) => {
		const birthYear = parseYear(cell(row, birthdayColumn));
		const debutYear = parseYear(cell(row, debutDateColumn));
		return birthYear === null || debutYear === null
			? []
			: [{ birthYear, debutYear }];
	});
	if (comparableYears.length === 0) return true;
	const matches = comparableYears.filter(
		({ birthYear, debutYear }) => birthYear <= debutYear,
	).length;
	return matches / comparableYears.length >= MIN_SCHEMA_VALUE_MATCH_RATIO;
}

function matchesSchema(
	rows: string[][],
	personRows: string[][],
	columnCount: number,
): boolean {
	if (
		columnCount < MINIMUM_SOURCE_COLUMN_COUNT ||
		rows.length < PRESERVED_HEADER_ROWS
	) {
		return false;
	}

	const anchorsMatch = SHEET_SCHEMA_ANCHORS.every(
		(anchor) => cell(rows[anchor.row], anchor.column).trim() === anchor.value,
	);
	if (!anchorsMatch) return false;

	const valueShapesMatch = SHEET_SCHEMA_VALUE_RULES.every((rule) =>
		matchesValueRule(personRows, rule),
	);
	if (!valueShapesMatch) return false;

	// Birthday and debut date have the same general shape, so validate their
	// relationship: when both years are present, birth cannot follow debut.
	return matchesBirthdayDebutOrder(personRows);
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
			rows.length < PRESERVED_HEADER_ROWS ||
				columnCount < MINIMUM_SOURCE_COLUMN_COUNT
				? "unsupported_schema"
				: "schema_mismatch",
		);
	}

	const projectRow = (row: string[]): string[] =>
		SHEET_SOURCE_INDICES.map((sourceIndex) => cell(row, sourceIndex));
	const headerRows = keptRows.slice(0, PRESERVED_HEADER_ROWS).map(projectRow);
	const personRows = sourcePersonRows.map(projectRow);
	const electionYears = ELECTION_COLUMN_CATALOG.flatMap((column) => {
		return sourcePersonRows.some((row) =>
			isPositiveRank(cell(row, column.sourceIndex)),
		)
			? [column.year]
			: [];
	});

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
				ELECTION_YEARS.includes(year),
		)
	) {
		return false;
	}
	return (
		value.latestDataYear === null ||
		value.availableYears.includes(value.latestDataYear)
	);
}
