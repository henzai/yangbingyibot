import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findIdentityCandidates,
	hasNameContext,
	IDENTITY_CANDIDATE_LIMIT,
	type IdentityCandidate,
	isEnglishDominant,
} from "./identityCandidates";
import { buildIdentityIndex } from "./identityIndex";
import { createStructure, type FixturePerson } from "./testFixtures";

// Artificial people only. Spellings mirror the shapes in the Issue #469 cases.
const PEOPLE: FixturePerson[] = [
	{
		full_name: "星野一",
		pinyin: "Xing Yeyi",
		initials: "XYY",
		community_nicknames: "絶死",
	},
	{ full_name: "月見二", pinyin: "Yue Jianer", community_nicknames: "はずれ" },
	{ full_name: "花田三", community_nicknames: "めんやん" },
	{ full_name: "森川四", community_nicknames: "めんやんに" },
	{ full_name: "赤井五", pinyin: "Chi Jingwu", community_nicknames: "赤/you" },
	{ full_name: "空山六", initials: "C", community_nicknames: "c" },
	{
		full_name: "同名",
		pinyin: "Tong Ming",
		community_nicknames: "どうめいA",
		official_nickname: "顔パキ",
		official_english_name: "Kaopaki",
		primary_affiliation: "Team Z",
	},
	{ full_name: "同名", community_nicknames: "どうめいB" },
];

const INDEX = buildIdentityIndex(createStructure(PEOPLE));

function summarize(candidates: IdentityCandidate[]) {
	return candidates.map(
		({ matchedText, fullName, source, method, ambiguousShortForm }) => ({
			matchedText,
			fullName,
			source,
			method,
			ambiguousShortForm,
		}),
	);
}

function find(question: string) {
	return findIdentityCandidates(question, INDEX);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("findIdentityCandidates: exact matches", () => {
	it("finds an unusual nickname", () => {
		expect(summarize(find("絶死は？").candidates)).toEqual([
			{
				matchedText: "絶死",
				fullName: "星野一",
				source: "community_nicknames",
				method: "exact",
				ambiguousShortForm: false,
			},
		]);
	});

	it("finds a hiragana nickname", () => {
		expect(find("はずれしってる？").candidates.map((c) => c.fullName)).toEqual([
			"月見二",
		]);
	});

	it("prefers the longest overlapping spelling", () => {
		expect(
			summarize(find("めんやんにの誕生日").candidates).map((c) => c.fullName),
		).toEqual(["森川四"]);
		expect(find("めんやんの誕生日").candidates.map((c) => c.fullName)).toEqual([
			"花田三",
		]);
	});

	it("keeps a nickname after a Japanese particle in an English-looking question", () => {
		expect(summarize(find("youと赤").candidates)).toEqual([
			{
				matchedText: "you",
				fullName: "赤井五",
				source: "community_nicknames",
				method: "exact",
				ambiguousShortForm: false,
			},
			{
				matchedText: "赤",
				fullName: "赤井五",
				source: "community_nicknames",
				method: "exact",
				ambiguousShortForm: true,
			},
		]);
	});

	it("ignores common English words in an English sentence", () => {
		expect(find("can you explain why 16:9 is called 16:9?")).toEqual({
			candidates: [],
			overflowCount: 0,
		});
	});

	it("keeps a common English word when quoted or asked alone", () => {
		expect(find('who is "you"?').candidates.map((c) => c.fullName)).toEqual([
			"赤井五",
		]);
		expect(find("you?").candidates.map((c) => c.fullName)).toEqual(["赤井五"]);
	});

	it("flags a single kanji and requires a name context", () => {
		expect(summarize(find("赤の名前").candidates)).toEqual([
			{
				matchedText: "赤",
				fullName: "赤井五",
				source: "community_nicknames",
				method: "exact",
				ambiguousShortForm: true,
			},
		]);
		expect(find("赤と同期のメンバー").candidates).toHaveLength(1);
		expect(find("赤色が好きなメンバー").candidates).toEqual([]);
		expect(find("真っ赤な衣装").candidates).toEqual([]);
		expect(find("応援色が赤系の人").candidates).toEqual([]);
	});

	it("flags a single Latin letter and requires a boundary and context", () => {
		expect(summarize(find("cの誕生日").candidates)).toEqual([
			{
				matchedText: "c",
				fullName: "空山六",
				source: "community_nicknames",
				method: "exact",
				ambiguousShortForm: true,
			},
		]);
		expect(find("abcの意味").candidates).toEqual([]);
		expect(find("C言語").candidates).toEqual([]);
	});

	it("normalizes width and case before matching", () => {
		expect(find("ＸＹＹの身長").candidates.map((c) => c.source)).toEqual([
			"initials",
		]);
		expect(find("Xing Yeyiの身長").candidates.map((c) => c.source)).toEqual([
			"pinyin",
		]);
		expect(find("xingyeyiの身長").candidates.map((c) => c.source)).toEqual([
			"pinyin",
		]);
	});

	it("rejects Latin matches inside a longer word", () => {
		expect(find("youtubeの動画").candidates).toEqual([]);
		expect(find("xyyzの話").candidates).toEqual([]);
	});

	it("keeps both people who share a full name", () => {
		expect(
			find("同名について").candidates.map((c) => [c.fullName, c.personIndex]),
		).toEqual([
			["同名", 6],
			["同名", 7],
		]);
	});

	it("de-duplicates the same person, spelling and span", () => {
		const index = buildIdentityIndex(
			createStructure([{ full_name: "重複", community_nicknames: "重複" }]),
		);
		expect(
			summarize(findIdentityCandidates("重複の年齢", index).candidates),
		).toEqual([
			{
				matchedText: "重複",
				fullName: "重複",
				source: "full_name",
				method: "exact",
				ambiguousShortForm: false,
			},
		]);
	});

	it("does not resolve unknown spellings or non-identity columns", () => {
		expect(find("顔パキは？")).toEqual({ candidates: [], overflowCount: 0 });
		expect(find("kaopakiの誕生日").candidates).toEqual([]);
		expect(find("Team Zのメンバー").candidates).toEqual([]);
	});
});

describe("findIdentityCandidates: ordering and limit", () => {
	const many = Array.from({ length: 10 }, (_, i) => ({
		full_name: `人物${String.fromCharCode(0x30a2 + i * 2)}`,
		community_nicknames: `愛称${String.fromCharCode(0x30a2 + i * 2)}`,
	}));
	const question = many.map((person) => person.community_nicknames).join("と");

	it("truncates deterministically and reports overflow", () => {
		const result = findIdentityCandidates(
			question,
			buildIdentityIndex(createStructure(many)),
		);

		expect(result.candidates).toHaveLength(IDENTITY_CANDIDATE_LIMIT);
		expect(result.overflowCount).toBe(2);
		expect(result.candidates.map((c) => c.matchedText)).toEqual(
			many.slice(0, 8).map((person) => person.community_nicknames),
		);
	});

	it("does not depend on sheet row order", () => {
		const forward = findIdentityCandidates(
			question,
			buildIdentityIndex(createStructure(many)),
		);
		const reversed = findIdentityCandidates(
			question,
			buildIdentityIndex(createStructure([...many].reverse())),
		);

		expect(summarize(reversed.candidates)).toEqual(
			summarize(forward.candidates),
		);
		expect(reversed.overflowCount).toBe(forward.overflowCount);
	});

	it("orders full names before nicknames and ambiguous forms last", () => {
		expect(
			find("赤と月見二とはずれ").candidates.map((c) => [
				c.matchedText,
				c.source,
			]),
		).toEqual([
			["月見二", "full_name"],
			["はずれ", "community_nicknames"],
			["赤", "community_nicknames"],
		]);
	});

	it("completes without network access for a long question", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const longQuestion = `${"あ".repeat(5000)}絶死${"a b ".repeat(1000)}`;

		expect(find(longQuestion).candidates.map((c) => c.fullName)).toEqual([
			"星野一",
		]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("name context helpers", () => {
	it("detects English-dominant questions", () => {
		expect(isEnglishDominant("can you explain why 16:9 is called 16:9?")).toBe(
			true,
		);
		expect(isEnglishDominant("youの誕生日を教えて")).toBe(false);
		expect(isEnglishDominant("16:9?")).toBe(false);
	});

	it("accepts quotes, whole questions and trailing particles", () => {
		expect(hasNameContext("「赤」って誰", 1, 2)).toBe(true);
		expect(hasNameContext("赤って誰?", 0, 1)).toBe(true);
		expect(hasNameContext("赤さんの年齢", 0, 1)).toBe(true);
		expect(hasNameContext("赤色", 0, 1)).toBe(false);
		expect(hasNameContext("深紅赤の", 2, 3)).toBe(false);
	});
});
