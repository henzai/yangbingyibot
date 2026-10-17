import {
	IDENTITY_COLUMN_CATALOG,
	SHEET_COLUMN_KEYS,
	type SheetColumnKey,
} from "./columnCatalog";
import type { ReadySheetStructure } from "./structuredSheet";

export const SHEET_NORMALIZATION_VERSION = 1 as const;
export type CellState =
	| "value"
	| "empty"
	| "placeholder"
	| "not_public"
	| "formula_error";

export function cellState(value: string): CellState {
	const text = value.trim();
	if (!text) return "empty";
	if (/^(?:非公開|未公開)$/u.test(text)) return "not_public";
	if (/^#(?:N\/A|REF!|VALUE!|DIV\/0!|ERROR!|NUM!|NAME\?|NULL!)$/i.test(text))
		return "formula_error";
	if (/^(?:[-—–－]+|不明|不詳|unknown|n\/a)$/i.test(text)) return "placeholder";
	return "value";
}

function generationNumber(value: string): number | null {
	if (/^[1-9]\d{0,3}$/.test(value)) return Number(value);
	const digits: Record<string, number> = {
		一: 1,
		二: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9,
	};
	const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
	let result = 0;
	let digit = 0;
	let previousUnit = 10000;
	for (const char of value) {
		if (digits[char]) {
			if (digit) return null;
			digit = digits[char];
		} else if (units[char] && units[char] < previousUnit) {
			const unit = units[char];
			if (!digit && (unit !== 10 || result !== 0)) return null;
			result += (digit || 1) * unit;
			previousUnit = unit;
			digit = 0;
		} else return null;
	}
	return result + digit > 0 ? result + digit : null;
}

export function readGeneration(raw: string): {
	raw: string;
	group: string | null;
	number: number | null;
} {
	const match = raw
		.normalize("NFKC")
		.trim()
		.match(/^([^\s]+)\s+([一二三四五六七八九十百千\d]+)期生$/u);
	const number = match ? generationNumber(match[2]) : null;
	return { raw, group: number === null || !match ? null : match[1], number };
}

export function readMemberState(
	status: string,
	primary: string,
	secondary: string,
) {
	const code = status.trim();
	const hasInactiveLabel = /暫休|暂休|退団|退团|卒業|毕业/u.test(
		`${primary}/${secondary}`,
	);
	const state: "active" | "inactive" | "conflicting" | "unknown" =
		code === "99"
			? hasInactiveLabel
				? "conflicting"
				: "active"
			: code === "44"
				? "inactive"
				: "unknown";
	return { state, statusCode: status, primary, secondary, hasInactiveLabel };
}

export type MemberRecord = {
	id: string;
	sid: string;
	sourceRow: number;
	values: Record<SheetColumnKey, string>;
	state: ReturnType<typeof readMemberState>;
	generation: ReturnType<typeof readGeneration>;
	/** G is not assigned the year of the last populated annual column. */
	latestRank: { raw: string; year: null };
};

export function readMemberRecords(
	structure: ReadySheetStructure,
	sourceId: string,
):
	| { status: "ready"; records: MemberRecord[]; excludedSourceRows: number[] }
	| {
			status: "unavailable";
			reason:
				| "invalid_source"
				| "missing_sid"
				| "invalid_sid"
				| "duplicate_sid";
	  } {
	if (!/^[0-9a-f]{64}$/.test(sourceId))
		return { status: "unavailable", reason: "invalid_source" };
	const seen = new Set<string>();
	const records: MemberRecord[] = [];
	const excludedSourceRows: number[] = [];
	for (const [index, row] of structure.personRows.entries()) {
		const values = Object.fromEntries(
			SHEET_COLUMN_KEYS.map((key, column) => [key, row[column]]),
		) as Record<SheetColumnKey, string>;
		const sid = values.sid.trim();
		// The CSV retains formula/template rows. Only wholly blank identity cells
		// without a SID are non-members; errors or aliases are not silently dropped.
		if (
			!sid &&
			IDENTITY_COLUMN_CATALOG.every(
				(column) => cellState(values[column.key]) === "empty",
			)
		) {
			excludedSourceRows.push(structure.sourceRowNumbers[index]);
			continue;
		}
		if (!sid) return { status: "unavailable", reason: "missing_sid" };
		if (!/^[1-9]\d{0,19}$/.test(sid))
			return { status: "unavailable", reason: "invalid_sid" };
		if (seen.has(sid))
			return { status: "unavailable", reason: "duplicate_sid" };
		seen.add(sid);
		records.push({
			id: `member:${sourceId}:${sid}`,
			sid,
			sourceRow: structure.sourceRowNumbers[index],
			values,
			state: readMemberState(
				values.status,
				values.primary_affiliation,
				values.secondary_affiliation,
			),
			generation: readGeneration(values.generation),
			latestRank: { raw: values.latest_rank, year: null },
		});
	}
	return { status: "ready", records, excludedSourceRows };
}
