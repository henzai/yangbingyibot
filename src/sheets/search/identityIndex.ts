import type { IdentityColumnKey } from "../columnCatalog";
import { cellState, type MemberRecord } from "../memberRecords";

/**
 * Local dictionary over six naming fields from the pinned snapshot.
 * Normalization and matching rules originate in PR #478; IDs are source + SID.
 */
export type IdentitySource =
	| IdentityColumnKey
	| "official_nickname"
	| "official_english_name";

export type IdentityTerm = {
	/** Normalized dictionary spelling. */
	text: string;
	source: IdentitySource;
	/** Stable source-bound member ID. */
	id: string;
	fullName: string;
	/** Only a-z, 0-9 and single spaces after normalization. */
	isLatin: boolean;
	/** A single character, which is too short to identify a person alone. */
	isShortAmbiguous: boolean;
	/**
	 * Pinyin is stored without spaces and matched with optional spaces between
	 * letters, because questions split syllables freely ("lin en tong").
	 */
	pattern?: RegExp;
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
	official_nickname: 4,
	official_english_name: 5,
};

const NICKNAME_SEPARATOR = /<br\s*\/?>|[\r\n/／,，、;；|｜]/iu;
const LATIN_TERM = /^[a-z0-9]+(?: [a-z0-9]+)*$/u;

/**
 * NFKC, strip tone/diacritic marks from Latin letters ("Zhāng" -> "zhang"),
 * lower-case, collapse whitespace (including full-width spaces) and trim.
 * Marks on kana are kept. The original question must be kept separately for
 * the answer prompt; this form is only used for matching.
 */
export function normalizeIdentityText(value: string): string {
	return value
		.normalize("NFKC")
		.normalize("NFD")
		.replace(/(?<=[A-Za-z])\p{M}+/gu, "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim();
}

function flexibleSpacePattern(text: string): RegExp {
	return new RegExp([...text].join(" ?"), "gu");
}

function spellings(source: IdentitySource, raw: string): string[] {
	const parts =
		source === "community_nicknames" || source === "official_nickname"
			? raw.split(NICKNAME_SEPARATOR)
			: [raw];
	const normalized = parts
		.filter((part) => cellState(part) === "value")
		.map(normalizeIdentityText)
		.filter((part) => part !== "");
	if (source !== "pinyin") return normalized;
	return normalized.map((part) => part.replaceAll(" ", ""));
}

export function buildIdentityIndex(
	records: readonly MemberRecord[],
): IdentityIndex {
	const terms: IdentityTerm[] = [];
	const sources = Object.keys(IDENTITY_SOURCE_RANK) as IdentitySource[];
	for (const record of records) {
		const seen = new Set<string>();
		for (const source of sources) {
			for (const text of spellings(source, record.values[source])) {
				const key = `${source}\u0000${text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const isLatin = LATIN_TERM.test(text);
				terms.push({
					text,
					source,
					id: record.id,
					fullName: record.values.full_name,
					isLatin,
					isShortAmbiguous: [...text].length === 1,
					...(source === "pinyin" && isLatin
						? { pattern: flexibleSpacePattern(text) }
						: {}),
				});
			}
		}
	}
	return Object.freeze({ terms: Object.freeze(terms) });
}
