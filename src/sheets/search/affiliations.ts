import { cellState, type MemberRecord } from "../memberRecords";
import type { TypedCell } from "./types";

/**
 * User-verified affiliation dictionary. Keys are exact trimmed values of the
 * primary/secondary affiliation cells. Changing any entry requires user
 * verification and a version bump.
 */
export const AFFILIATION_DICTIONARY_VERSION = 1;
type Entry = Readonly<{ group: string; team: string }>;
const entry = (group: string, team: string): Entry =>
	Object.freeze({ group, team });
export const AFFILIATION_DICTIONARY: Readonly<Record<string, Entry>> =
	Object.freeze({
		SII: entry("SNH48", "SII"),
		NII: entry("SNH48", "NII"),
		HII: entry("SNH48", "HII"),
		X: entry("SNH48", "X"),
		SNH预备生: entry("SNH48", "预备生"),
		G: entry("GNZ48", "G"),
		NIII: entry("GNZ48", "NIII"),
		Z: entry("GNZ48", "Z"),
		GNZ预备生: entry("GNZ48", "预备生"),
		B: entry("BEJ48", "B"),
		E: entry("BEJ48", "E"),
		BEJ预备生: entry("BEJ48", "预备生"),
		C: entry("CKG48", "C"),
		K: entry("CKG48", "K"),
		CKG预备生: entry("CKG48", "预备生"),
		CII: entry("CGT48", "CII"),
		CGT预备生: entry("CGT48", "预备生"),
		IDFT: entry("IDFT", "IDFT"),
	});
const NOT_CURRENT = /暫休|暂休|退団|退团|卒業|毕业|荣誉毕业生/u;
const SOURCES = ["status", "primary_affiliation", "secondary_affiliation"];

/**
 * Search-time derivation of current_group / current_team.
 * Inactive members yield an empty set with field_state "value": eq/in never
 * match and are not unknown, not_in/is_missing match.
 */
export function affiliationCell(
	record: MemberRecord,
	field: "current_group" | "current_team",
): TypedCell {
	const raw = record.values.status;
	const state = record.state.state;
	if (state === "conflicting" || state === "unknown")
		return {
			field_state: "invalid",
			raw,
			value: null,
			source_fields: SOURCES,
			reason: state,
		};
	if (state === "inactive")
		return { field_state: "value", raw, value: [], source_fields: SOURCES };
	const entries: Entry[] = [];
	for (const cell of [
		record.values.primary_affiliation,
		record.values.secondary_affiliation,
	]) {
		const status = cellState(cell);
		if (status === "empty" || status === "placeholder") continue;
		const label = cell.trim();
		const found = Object.hasOwn(AFFILIATION_DICTIONARY, label)
			? AFFILIATION_DICTIONARY[label]
			: undefined;
		if (found) entries.push(found);
		else if (!NOT_CURRENT.test(label))
			return {
				field_state: "invalid",
				raw,
				value: null,
				source_fields: SOURCES,
				reason: "unmapped_affiliation",
			};
	}
	if (!entries.length)
		return {
			field_state: "invalid",
			raw,
			value: null,
			source_fields: SOURCES,
			reason: "no_current_affiliation",
		};
	const value =
		field === "current_group"
			? [...new Set(entries.map((e) => e.group))].sort()
			: [...new Set(entries.map((e) => e.team))];
	return { field_state: "value", raw, value, source_fields: SOURCES };
}
