import {
	type IdentityColumnKey,
	SHEET_COLUMN_KEYS,
} from "../sheets/columnCatalog";
import {
	isPlaceholder,
	type ReadySheetStructure,
} from "../sheets/structuredSheet";

/**
 * Local dictionary built only from the four identity columns. Official
 * nicknames, English names, affiliations and other attributes are never
 * indexed, so a candidate can only come from the identity contract.
 */
export type IdentitySource = IdentityColumnKey;

export type IdentityTerm = {
	/** Normalized dictionary spelling. */
	text: string;
	source: IdentitySource;
	/** Position in personRows. Distinguishes people who share a full name. */
	personIndex: number;
	fullName: string;
	/** Only a-z, 0-9 and single spaces after normalization. */
	isLatin: boolean;
	/** A single character, which is too short to identify a person alone. */
	isShortAmbiguous: boolean;
};

export type IdentityIndex = {
	readonly terms: readonly IdentityTerm[];
};

// Lower rank wins when the same person matches the same span from several
// identity columns, and orders candidates deterministically.
export const IDENTITY_SOURCE_RANK: Record<IdentitySource, number> = {
	full_name: 0,
	community_nicknames: 1,
	initials: 2,
	pinyin: 3,
};

const NICKNAME_SEPARATOR = /<br\s*\/?>|[\r\n/／,，、;；|｜]/iu;
const LATIN_TERM = /^[a-z0-9]+(?: [a-z0-9]+)*$/u;

const FULL_NAME_COLUMN = SHEET_COLUMN_KEYS.indexOf("full_name");
const PINYIN_COLUMN = SHEET_COLUMN_KEYS.indexOf("pinyin");
const INITIALS_COLUMN = SHEET_COLUMN_KEYS.indexOf("initials");
const NICKNAMES_COLUMN = SHEET_COLUMN_KEYS.indexOf("community_nicknames");

/**
 * NFKC, lower-case Latin letters, collapse whitespace (including full-width
 * spaces) and trim. The original question must be kept separately for the
 * answer prompt; this form is only used for matching.
 */
export function normalizeIdentityText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function spellings(source: IdentitySource, raw: string): string[] {
	const parts =
		source === "community_nicknames" ? raw.split(NICKNAME_SEPARATOR) : [raw];
	const normalized = parts
		.filter((part) => !isPlaceholder(part))
		.map(normalizeIdentityText)
		.filter((part) => part !== "");
	if (source !== "pinyin") return normalized;
	// Pinyin is written both as "zhang san" and "zhangsan" in questions.
	return normalized.flatMap((part) => [part, part.replaceAll(" ", "")]);
}

export function buildIdentityIndex(
	structure: ReadySheetStructure,
): IdentityIndex {
	const terms: IdentityTerm[] = [];
	structure.personRows.forEach((row, personIndex) => {
		const fullName = (row[FULL_NAME_COLUMN] ?? "").trim();
		if (isPlaceholder(fullName)) return;

		const columns: [IdentitySource, number][] = [
			["full_name", FULL_NAME_COLUMN],
			["pinyin", PINYIN_COLUMN],
			["initials", INITIALS_COLUMN],
			["community_nicknames", NICKNAMES_COLUMN],
		];
		const seen = new Set<string>();
		for (const [source, column] of columns) {
			for (const text of spellings(source, row[column] ?? "")) {
				const key = `${source}\u0000${text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				terms.push({
					text,
					source,
					personIndex,
					fullName,
					isLatin: LATIN_TERM.test(text),
					isShortAmbiguous: [...text].length === 1,
				});
			}
		}
	});
	return Object.freeze({ terms: Object.freeze(terms) });
}
