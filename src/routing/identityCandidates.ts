import {
	IDENTITY_SOURCE_RANK,
	type IdentityIndex,
	type IdentitySource,
	type IdentityTerm,
	normalizeIdentityText,
} from "./identityIndex";

/**
 * Local person-candidate search for the Jev B state. This is dictionary
 * matching against the identity index, not NER: unknown spellings produce no
 * candidate, and nothing here calls an external service or logs.
 */

export type IdentityMatchMethod = "exact" | "partial" | "approximate";

export type IdentityCandidate = {
	/** Normalized question text that matched. */
	matchedText: string;
	/** Identifier only; the answer LLM still decides the target rows. */
	fullName: string;
	source: IdentitySource;
	method: IdentityMatchMethod;
	ambiguousShortForm: boolean;
	/** Internal: separates people who share a full name. */
	personIndex: number;
	/** Internal: range in the normalized question, used for de-duplication. */
	span: { start: number; end: number };
};

export type IdentityCandidateResult = {
	candidates: IdentityCandidate[];
	/** Candidates dropped by the state limit. Diagnostic only. */
	overflowCount: number;
};

/** State candidate limit. It does not restrict the rows given to the answer LLM. */
export const IDENTITY_CANDIDATE_LIMIT = 8;

// Words that are ordinary English in an English sentence even when a member
// uses them as a nickname or initials.
export const COMMON_ENGLISH_WORDS: ReadonlySet<string> = new Set([
	"a",
	"am",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"do",
	"for",
	"he",
	"how",
	"i",
	"if",
	"in",
	"is",
	"it",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"she",
	"so",
	"that",
	"the",
	"this",
	"to",
	"up",
	"us",
	"we",
	"what",
	"who",
	"why",
	"you",
	"your",
]);

// Japanese particles and honorifics that mark the preceding word as a name.
const NAME_PARTICLES = [
	"って",
	"さん",
	"ちゃん",
	"くん",
	"の",
	"と",
	"は",
	"が",
	"も",
	"に",
	"を",
	"や",
] as const;

const OPENING_QUOTES = new Set(["「", "『", '"', "“", "'", "‘"]);
const CLOSING_QUOTES = new Set(["」", "』", '"', "”", "'", "’"]);

const LATIN_OR_DIGIT = /[a-z0-9]/u;
const HAN_OR_KATAKANA = /[\p{Script=Han}\p{Script=Katakana}]/u;
const PUNCTUATION_OR_SPACE = /[\s\p{P}\p{S}]/u;
const WHOLE_QUESTION_PREFIX = /^[\s\p{P}\p{S}]*$/u;
const WHOLE_QUESTION_SUFFIX = /^(?:って誰|は誰|って|は)?[\s\p{P}\p{S}]*$/u;

const METHOD_RANK: Record<IdentityMatchMethod, number> = {
	exact: 0,
	partial: 1,
	approximate: 2,
};

/** A question is English-dominant when at least half of its letters are Latin. */
export function isEnglishDominant(question: string): boolean {
	const letters = [...question].filter((char) => /\p{L}/u.test(char));
	if (letters.length === 0) return false;
	const latin = letters.filter((char) => /[a-z]/iu.test(char)).length;
	return latin / letters.length >= 0.5;
}

function followedByParticle(question: string, end: number): boolean {
	const rest = question.slice(end);
	return NAME_PARTICLES.some((particle) => rest.startsWith(particle));
}

function isQuoted(question: string, start: number, end: number): boolean {
	return (
		OPENING_QUOTES.has(question[start - 1] ?? "") &&
		CLOSING_QUOTES.has(question[end] ?? "")
	);
}

function isWholeQuestion(
	question: string,
	start: number,
	end: number,
): boolean {
	return (
		WHOLE_QUESTION_PREFIX.test(question.slice(0, start)) &&
		WHOLE_QUESTION_SUFFIX.test(question.slice(end))
	);
}

/**
 * Whether the span reads as a name in a normalized question: it is quoted,
 * it is the whole question, or it stands alone before a particle, punctuation
 * or the end of the question.
 */
export function hasNameContext(
	question: string,
	start: number,
	end: number,
): boolean {
	if (isQuoted(question, start, end) || isWholeQuestion(question, start, end)) {
		return true;
	}
	const before = question[start - 1];
	if (before !== undefined && HAN_OR_KATAKANA.test(before)) return false;
	const after = question[end];
	return (
		after === undefined ||
		PUNCTUATION_OR_SPACE.test(after) ||
		followedByParticle(question, end)
	);
}

function hasLatinBoundary(
	question: string,
	start: number,
	end: number,
): boolean {
	const before = question[start - 1];
	const after = question[end];
	return (
		(before === undefined || !LATIN_OR_DIGIT.test(before)) &&
		(after === undefined || !LATIN_OR_DIGIT.test(after))
	);
}

function isAcceptedExactMatch(
	question: string,
	term: IdentityTerm,
	start: number,
	end: number,
	englishDominant: boolean,
): boolean {
	if (term.isLatin && !hasLatinBoundary(question, start, end)) return false;
	if (term.isShortAmbiguous && !hasNameContext(question, start, end)) {
		return false;
	}
	if (englishDominant && COMMON_ENGLISH_WORDS.has(term.text)) {
		return (
			followedByParticle(question, end) ||
			isQuoted(question, start, end) ||
			isWholeQuestion(question, start, end)
		);
	}
	return true;
}

function toCandidate(
	term: IdentityTerm,
	question: string,
	start: number,
	end: number,
	method: IdentityMatchMethod,
): IdentityCandidate {
	return {
		matchedText: question.slice(start, end),
		fullName: term.fullName,
		source: term.source,
		method,
		ambiguousShortForm: term.isShortAmbiguous,
		personIndex: term.personIndex,
		span: { start, end },
	};
}

function compareCandidates(a: IdentityCandidate, b: IdentityCandidate): number {
	const aLength = a.span.end - a.span.start;
	const bLength = b.span.end - b.span.start;
	return (
		METHOD_RANK[a.method] - METHOD_RANK[b.method] ||
		Number(a.ambiguousShortForm) - Number(b.ambiguousShortForm) ||
		IDENTITY_SOURCE_RANK[a.source] - IDENTITY_SOURCE_RANK[b.source] ||
		bLength - aLength ||
		a.span.start - b.span.start ||
		(a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0) ||
		a.personIndex - b.personIndex
	);
}

function findExactMatches(
	question: string,
	index: IdentityIndex,
): IdentityCandidate[] {
	const englishDominant = isEnglishDominant(question);
	const matches: IdentityCandidate[] = [];
	for (const term of index.terms) {
		let start = question.indexOf(term.text);
		while (start !== -1) {
			const end = start + term.text.length;
			if (isAcceptedExactMatch(question, term, start, end, englishDominant)) {
				matches.push(toCandidate(term, question, start, end, "exact"));
			}
			start = question.indexOf(term.text, start + 1);
		}
	}
	return matches;
}

/**
 * Longest spans win over shorter overlapping spans (earlier start on a tie).
 * Matches on the identical span are all kept so that people sharing a name or
 * nickname are not dropped, then one entry per person/spelling/span remains.
 */
function resolveOverlaps(matches: IdentityCandidate[]): IdentityCandidate[] {
	const byLength = [...matches].sort(
		(a, b) =>
			b.span.end - b.span.start - (a.span.end - a.span.start) ||
			a.span.start - b.span.start ||
			IDENTITY_SOURCE_RANK[a.source] - IDENTITY_SOURCE_RANK[b.source] ||
			a.personIndex - b.personIndex,
	);
	const accepted: IdentityCandidate[] = [];
	const seen = new Set<string>();
	for (const match of byLength) {
		const { start, end } = match.span;
		const conflicts = accepted.some(
			(other) =>
				other.span.start < end &&
				start < other.span.end &&
				(other.span.start !== start || other.span.end !== end),
		);
		if (conflicts) continue;
		const key = `${match.personIndex}\u0000${match.matchedText}\u0000${start}`;
		if (seen.has(key)) continue;
		seen.add(key);
		accepted.push(match);
	}
	return accepted;
}

export function findIdentityCandidates(
	question: string,
	index: IdentityIndex,
): IdentityCandidateResult {
	const normalized = normalizeIdentityText(question);
	const candidates = resolveOverlaps(findExactMatches(normalized, index)).sort(
		compareCandidates,
	);
	return {
		candidates: candidates.slice(0, IDENTITY_CANDIDATE_LIMIT),
		overflowCount: Math.max(0, candidates.length - IDENTITY_CANDIDATE_LIMIT),
	};
}
