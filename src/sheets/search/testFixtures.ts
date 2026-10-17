import type { SpreadsheetConfig } from "../../config";
import { SHEET_COLUMN_KEYS, type SheetColumnKey } from "../columnCatalog";
import { SheetSnapshotRepository } from "../snapshot";
import { memberFixture } from "../testFixtures";
import { SheetSearchEngine } from "./engine";
import type {
	AggregateArgs,
	GetArgs,
	QueryArgs,
	SearchArgs,
	SearchResult,
} from "./types";

export const SOURCE: SpreadsheetConfig = {
	id: "artificial-search-sheet",
	dataSheetName: "members",
	descriptionSheetName: "description",
};
export const NOW = Date.parse("2026-10-17T08:00:00Z");
export const defaultContext = { as_of: null, target_age: null };
export const queryArgs: QueryArgs = {
	dataset: "members",
	where: null,
	fields: ["full_name"],
	sort: [],
	exclude_previously_delivered: false,
	top_n: null,
	calculation_context: defaultContext,
	page_size: 50,
	cursor: null,
};
export const searchArgs: SearchArgs = {
	dataset: "members",
	query: "架空",
	mode: "identity",
	search_fields: null,
	where: null,
	page_size: 50,
	cursor: null,
};
export const aggregateArgs: AggregateArgs = {
	dataset: "members",
	where: null,
	metrics: [{ op: "count", field: null, operands: null }],
	group_by: [],
	sort_metric_index: null,
	sort_direction: "asc",
	top_n: null,
	calculation_context: defaultContext,
	page_size: 50,
	cursor: null,
};
export const getArgs: GetArgs = {
	dataset: "members",
	ids: [],
	fields: ["full_name"],
	preset: null,
	calculation_context: defaultContext,
	cursor: null,
};
export const artificialMembers: Partial<Record<SheetColumnKey, string>>[] = [
	{
		sid: "101",
		full_name: "架空甲",
		pinyin: "Jiǎ Xiāng",
		initials: "JX",
		community_nicknames: "絶死/めんやん/you/赤",
		official_nickname: "小甲",
		official_english_name: "Aurora",
		primary_affiliation: "TeamC",
		secondary_affiliation: "TeamX",
		status: "99",
		generation: "SNH48 二十三期生",
		age: "20",
		height: "165cm",
		birthday: "2006/10/17",
		debut_date: "2020/10/18",
		pocket_followers: "1.5万",
		election_2024: "3",
		election_2025: "0",
		latest_rank: "1",
		career: "架空の甲は上海で学び、演劇を経験した。",
	},
	{
		sid: "202",
		full_name: "架空乙",
		pinyin: "Yi Ren",
		community_nicknames: "はずれ/めんやんに/c",
		primary_affiliation: "TeamCII",
		status: "99",
		generation: "SNH48 24期生",
		age: "22",
		height: "165",
		birthday: "2004-02-29",
		debut_date: "2020-10-17",
		election_2024: "3",
		election_2025: "5",
		career: "架空の乙は上海で演劇を経験した。",
	},
	{
		sid: "303",
		full_name: "架空乙",
		community_nicknames: "秋野",
		primary_affiliation: "TeamC",
		secondary_affiliation: "暫休/退団",
		status: "99",
		generation: "BEJ48 23期生",
		age: "非公開",
		height: "#N/A",
		birthday: "10月17日",
		skills: "演劇",
		career: "架空の丙は北京で学んだ。",
	},
	{
		sid: "404",
		full_name: "#N/A",
		community_nicknames: "蝶舞丸",
		primary_affiliation: "TeamC",
		status: "44",
		generation: "SNH48 22期生",
		age: "—",
		height: "170",
		birthday: "2000-01",
		career: "上海で別の活動",
	},
	{
		sid: "505",
		full_name: "架空戊",
		pinyin: "Shen Xin",
		primary_affiliation: "TeamZ",
		status: "",
		generation: "不明",
		age: "#REF!",
		height: "",
		birthday: "2000-02-30",
		career: "",
	},
];
export async function fixture(
	members = artificialMembers,
	description = "人工の人格・回答規則と用語定義",
	clock: () => number = () => NOW,
	deliveredIds?: string[],
) {
	const structure = memberFixture();
	structure.personRows = members.map((member) =>
		SHEET_COLUMN_KEYS.map((field) => member[field] ?? ""),
	);
	structure.sourceRowNumbers = members.map((_, index) => 4 + index * 2);
	structure.availableYears = [2024, 2025].filter((year) =>
		members.some((member) =>
			/^[1-9]\d*$/.test(member[`election_${year}` as SheetColumnKey] ?? ""),
		),
	);
	structure.latestDataYear = structure.availableYears.at(-1) ?? null;
	const data = new Map<string, string>();
	const kv = {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
	} as unknown as KVNamespace;
	const repository = new SheetSnapshotRepository(kv, clock);
	const capture = await repository.capture(SOURCE, structure, description);
	if (capture.status !== "ready") throw new Error(capture.reason);
	const opened = await SheetSearchEngine.open(repository, SOURCE, capture.ref, {
		now: clock,
		deliveredIds,
	});
	if (opened.status !== "ready") throw new Error(opened.reason);
	return {
		engine: opened.engine,
		repository,
		ref: capture.ref,
		structure,
		data,
		kv,
	};
}
export function ok(result: unknown): asserts result is SearchResult {
	if (
		!result ||
		typeof result !== "object" ||
		!("status" in result) ||
		result.status !== "ok"
	)
		throw new Error(JSON.stringify(result));
}
