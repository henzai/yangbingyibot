import { readGeneration } from "../memberRecords";
import { calculateMetric } from "../search/aggregates";
import { normalize } from "../search/cells";
import type {
	AggregateArgs,
	AggregateGroup,
	Field,
	Metric,
	MetricResult,
	QueryArgs,
	SearchRecord,
	SearchResult,
} from "../search/types";
import { validArguments } from "../search/validation";
import {
	AnswerError,
	Collection,
	checkSelection,
	fail,
	type Limits,
	limitsFor,
	requiredCell,
	same,
	unique,
} from "./collection";
import {
	type AnswerChunk,
	type AnswerFailure,
	type AnswerLimits,
	type AnswerSource,
	PreparedSheetAnswer,
} from "./contracts";
import { cellText, filtersText, label, literal, stateText } from "./format";

type Entry = { text: string; ids: string[] };
const ROSTER_FIELDS: Field[] = [
	"full_name",
	"pinyin",
	"generation",
	"primary_affiliation",
	"secondary_affiliation",
	"newcomer_flag",
	"state_flags",
];
function recordEntry(row: SearchRecord, fields: Field[]): Entry {
	if (fields.some((field) => !row.cells[field])) fail("invalid_result");
	const name = row.cells.full_name;
	if (!name) fail("invalid_result");
	const sid = row.id.split(":").at(-1) ?? row.id;
	return {
		text: `・${cellText(name)}（SID ${literal(sid)}）${fields
			.filter((f) => f !== "full_name")
			.map((f) => ` / ${label(f)}：${cellText(requiredCell(row.cells, f))}`)
			.join("")}`,
		ids: [row.id],
	};
}
function pack(
	base: SearchResult,
	entries: Entry[],
	summary: string,
	ids: string[],
	complete: boolean,
	limits: Limits,
): PreparedSheetAnswer {
	const context = `取得 ${new Date(base.source_captured_at).toISOString()} / 計算基準 ${base.calculation_context.as_of}`;
	// Reserve a fixed header budget so the final partial/range label never overflows.
	const header = `${summary}\n${context}`;
	const reserve = `${header}\n一部表示・未完了（表示上限／条件不明あり） / 100/100\n`;
	const capacity = limits.chunkLimit - reserve.length;
	if (capacity < 1) fail("budget_exceeded");
	const pages: Entry[][] = [[]];
	let used = 0;
	for (const entry of entries) {
		if (entry.text.length > capacity) fail("budget_exceeded");
		if (used + entry.text.length + (used ? 1 : 0) > capacity) {
			pages.push([]);
			used = 0;
		}
		pages[pages.length - 1].push(entry);
		used += entry.text.length + (used ? 1 : 0);
	}
	const selected = pages.slice(0, limits.maxChunks);
	const omitted = pages
		.slice(limits.maxChunks)
		.reduce((n, page) => n + page.length, 0);
	const chunks: AnswerChunk[] = selected.map((page, index) => ({
		content: `${header}\n${omitted || !complete ? "一部表示・未完了（表示上限／条件不明あり）" : "確定した対象範囲"} / ${index + 1}/${selected.length}\n${page.map((e) => e.text).join("\n")}`,
		ids: [...new Set(page.flatMap((e) => e.ids))],
	}));
	return new PreparedSheetAnswer(base, chunks, ids, complete, omitted);
}
async function attempt(
	action: () => Promise<PreparedSheetAnswer>,
): Promise<PreparedSheetAnswer | AnswerFailure> {
	try {
		return await action();
	} catch (error) {
		return {
			status: "error",
			reason:
				error instanceof AnswerError
					? error.reason
					: error instanceof Error && error.name === "AbortError"
						? "budget_exceeded"
						: "invalid_result",
		};
	}
}

/** Exact typed conditions only. Natural-language interpretation belongs to E/F. */
export async function prepareQueryAnswer(
	source: AnswerSource,
	input: QueryArgs,
	options: AnswerLimits = {},
) {
	return attempt(async () => {
		if (!validArguments("query_records", input) || input.dataset !== "members")
			fail("invalid_arguments");
		const args: QueryArgs = structuredClone(input);
		args.fields = [
			...new Set([
				...ROSTER_FIELDS,
				...args.fields,
				...args.sort.map((s) => s.field),
			]),
		];
		if (args.fields.length > 20) fail("invalid_arguments");
		const collection = new Collection(source, limitsFor(options));
		const { base, records } = await collection.collect("query_records", args);
		if (!same(base.applied_filters, args.where)) fail("invalid_result");
		const ids = records.map((r) => r.id);
		checkSelection(source, base, ids);
		if (!same(ids, collection.set(base))) fail("invalid_result");
		const unknown = base.ranking_unknown_count ?? 0;
		const entries: Entry[] = [
			{ text: filtersText(base.applied_filters), ids: [] },
		];
		if (args.exclude_previously_delivered)
			entries.push({ text: "直前の実配信済みIDを除外", ids: [] });
		if (args.top_n !== null)
			entries.push({
				text: `上位${args.top_n}人（${args.sort.map((s) => `${label(s.field)} ${s.direction}`).join(" / ")}）、境界同値を${Math.max(0, base.selected_count - args.top_n)}人追加。順位値不明${unknown}人は除外。`,
				ids: [],
			});
		const generationCounts = new Map<string, number>();
		let unknownGenerations = 0;
		for (const row of records) {
			const cell = row.cells.generation;
			if (cell?.field_state === "value") {
				const parsed = readGeneration(String(cell.value));
				if (parsed.number === null) {
					unknownGenerations++;
					continue;
				}
				const generation = `${literal(parsed.group ?? "")} ${parsed.number}期`;
				generationCounts.set(
					generation,
					(generationCounts.get(generation) ?? 0) + 1,
				);
			} else unknownGenerations++;
		}
		for (const [generation, count] of [...generationCounts].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		))
			entries.push({ text: `${generation}：${count}人`, ids: [] });
		if (unknownGenerations)
			entries.push({
				text: `期不明・未解析：${unknownGenerations}人`,
				ids: [],
			});
		entries.push(...records.map((r) => recordEntry(r, args.fields)));
		if (!records.length)
			entries.push({
				text: "確定した条件一致は0人。条件不明がある場合は不存在の断定はできません。",
				ids: [],
			});
		return pack(
			base,
			entries,
			`一覧：対象${base.selected_count}人 / 条件一致${base.matched_count}人 / 条件不明${base.unknown_count}人 / 順位不明${unknown}人`,
			ids,
			base.unknown_count === 0 && unknown === 0,
			collection.limits,
		);
	});
}

/** Reuses snapshot generation parsing; missing group requires clarification. */
export async function prepareGenerationAnswer(
	source: AnswerSource,
	request: { group: string | null; generations: (string | number)[] },
	options: AnswerLimits = {},
) {
	if (!request.group?.trim())
		return { status: "error", reason: "missing_context" } as AnswerFailure;
	if (!request.generations.length || request.generations.length > 20)
		return { status: "error", reason: "invalid_arguments" } as AnswerFailure;
	const group = request.group.normalize("NFKC").trim();
	const numbers = request.generations.map(
		(value) =>
			readGeneration(`${group} ${String(value).replace(/期(?:生)?$/u, "")}期生`)
				.number,
	);
	if (numbers.some((n) => n === null))
		return { status: "error", reason: "invalid_arguments" } as AnswerFailure;
	return prepareQueryAnswer(
		source,
		{
			dataset: "members",
			where: {
				any: [
					{
						all: [
							{ field: "generation_group", op: "eq", values: [group] },
							{
								field: "generation_number",
								op: "in",
								values: [...new Set(numbers as number[])].sort((a, b) => a - b),
							},
						],
					},
				],
			},
			fields: ["full_name"],
			sort: [{ field: "generation_number", direction: "asc" }],
			exclude_previously_delivered: false,
			top_n: null,
			calculation_context: { as_of: null, target_age: null },
			page_size: 50,
			cursor: null,
		},
		options,
	);
}

const operations: Record<MetricResult["op"], string> = {
	count: "人数",
	min: "最小",
	max: "最大",
	mean: "平均",
	best_rank: "年別最良順位",
	difference: "左−右の差",
};
async function metricEntries(
	collection: Collection,
	base: SearchResult,
	metric: MetricResult,
	request: Metric,
	group: AggregateGroup,
	groupBy: Field[],
): Promise<Entry[]> {
	if (
		metric.valid_count + metric.unknown_count !== metric.population_count ||
		[
			metric.population_count,
			metric.valid_count,
			metric.unknown_count,
			...Object.values(metric.missing_by_state),
		].some((n) => !Number.isSafeInteger(n) || n < 0) ||
		Object.values(metric.missing_by_state).reduce((sum, n) => sum + n, 0) !==
			metric.unknown_count ||
		(typeof metric.value === "number" && !Number.isFinite(metric.value)) ||
		(metric.op === "count" &&
			(metric.value !== metric.population_count || metric.unknown_count !== 0))
	)
		fail("invalid_result");
	const field = metric.field ? `${label(metric.field)} ` : "";
	const entries: Entry[] = [
		{
			text: `${field}${operations[metric.op]}：${metric.value === null ? "算出不能" : literal(String(metric.value))}${metric.unit ? ` ${literal(metric.unit)}` : ""}（母集団${metric.population_count}、有効${metric.valid_count}、不明${metric.unknown_count}）${
				Object.keys(metric.missing_by_state).length
					? ` 欠損内訳 ${Object.entries(metric.missing_by_state)
							.map(([state, count]) => `${stateText(state)}${count}`)
							.join(" / ")}`
					: ""
			}`,
			ids: [],
		},
	];
	if (metric.op === "difference") {
		if (!request.operands || !metric.field) fail("invalid_result");
		const { left_id, right_id } = request.operands;
		const fields: Field[] = ["full_name", metric.field];
		const records = await collection.members(
			base,
			[...new Set([left_id, right_id])],
			fields,
		);
		const recomputed = await calculateMetric(
			records.map((row) => ({
				id: row.id,
				cell: (field) => requiredCell(row.cells, field),
			})),
			request,
			async () => fail("invalid_result"),
		);
		for (const field of [
			"value",
			"population_count",
			"valid_count",
			"unknown_count",
			"missing_by_state",
		] as const)
			if (!same(recomputed[field], metric[field])) fail("invalid_result");
		if (metric.value !== null && recomputed.unit !== metric.unit)
			fail("invalid_result");
		for (const [index, id] of [left_id, right_id].entries()) {
			const row = records.find((r) => r.id === id);
			if (!row) fail("invalid_result");
			const entry = recordEntry(row, fields);
			entries.push({
				...entry,
				text: `${index === 0 ? "左" : "右"} ${entry.text}`,
			});
		}
		return entries;
	}
	if (metric.value === null) return entries;
	const handle =
		metric.op === "best_rank" ? metric.rank_set_id : metric.tied_set_id;
	if (!handle) {
		if (["min", "max", "best_rank"].includes(metric.op)) fail("invalid_result");
		return entries;
	}
	const ids = collection.set(base, handle);
	const population = new Set(collection.set(base));
	if (
		!ids.length ||
		ids.length > group.population_count ||
		ids.some((id) => !population.has(id)) ||
		(metric.op !== "best_rank" && metric.tied_count !== ids.length)
	)
		fail("invalid_result");
	if (
		metric.tied_ids &&
		(!unique(metric.tied_ids) ||
			metric.tied_ids.length !== ids.length ||
			metric.tied_ids.some((id) => !ids.includes(id)))
	)
		fail("invalid_result");
	if (!metric.field) fail("invalid_result");
	const metricField = metric.field;
	const fields: Field[] = [
		...new Set<Field>(["full_name", metricField, ...groupBy]),
	];
	const records = await collection.members(base, [...ids].sort(), fields);
	let rankMatches = 0;
	for (const row of records) {
		for (const field of groupBy) {
			const expected = requiredCell(group.group, field),
				actual = requiredCell(row.cells, field);
			const values = Array.isArray(actual.value)
				? actual.value
				: [actual.value];
			if (
				actual.field_state !== "value" ||
				actual.precision !== expected.precision ||
				!values.some((v) =>
					typeof v === "string" && typeof expected.value === "string"
						? normalize(v) === normalize(expected.value)
						: v === expected.value,
				)
			)
				fail("invalid_result");
		}
		const cell = row.cells[metricField];
		if (cell?.field_state !== "value") fail("invalid_result");
		if (metric.op === "best_rank") {
			if (!Array.isArray(cell.value)) fail("invalid_result");
			const ranks = cell.value.filter(
				(v) => typeof v !== "string" && v.rank === metric.value,
			);
			if (!ranks.length) fail("invalid_result");
			rankMatches += ranks.length;
		} else if (cell.value !== metric.value) fail("invalid_result");
	}
	if (metric.op === "best_rank" && metric.rank_match_count !== rankMatches)
		fail("invalid_result");
	entries.push({ text: `同値の対象${ids.length}人`, ids: [] });
	entries.push(...records.map((row) => recordEntry(row, fields)));
	return entries;
}
export async function prepareAggregateAnswer(
	source: AnswerSource,
	input: AggregateArgs,
	options: AnswerLimits = {},
) {
	return attempt(async () => {
		if (
			!validArguments("aggregate_records", input) ||
			input.dataset !== "members"
		)
			fail("invalid_arguments");
		const args: AggregateArgs = structuredClone(input);
		const collection = new Collection(source, limitsFor(options));
		const { base, groups } = await collection.collect(
			"aggregate_records",
			args,
		);
		const population = collection.set(base);
		checkSelection(source, base, population);
		if (
			base.matched_count !== population.length ||
			!same(base.applied_filters, args.where) ||
			groups.length !== base.selected_group_count ||
			!unique(groups.map((g) => g.key))
		)
			fail("invalid_result");
		const entries: Entry[] = [
			{ text: filtersText(base.applied_filters), ids: [] },
		];
		if (args.top_n !== null)
			entries.push({
				text: `上位${args.top_n}組（${args.metrics[args.sort_metric_index ?? 0].field ? label(args.metrics[args.sort_metric_index ?? 0].field as Field) : ""} ${operations[args.metrics[args.sort_metric_index ?? 0].op]} ${args.sort_direction}）・境界同値を${Math.max(0, groups.length - args.top_n)}組追加。順位不明${base.ranking_unknown_group_count ?? 0}組は除外。`,
				ids: [],
			});
		if (args.group_by.length)
			entries.push({
				text: `グループ化：${args.group_by.map(label).join(" / ")}。複数所属の人物は複数組に含まれるため、組別人数の合計と全体の人数は異なる場合があります。`,
				ids: [],
			});
		for (const group of groups) {
			if (
				group.metrics.length !== args.metrics.length ||
				args.group_by.some((f) => !group.group[f])
			)
				fail("invalid_result");
			entries.push({
				text: `集計対象：${args.group_by.length ? args.group_by.map((f) => `${label(f)} ${cellText(requiredCell(group.group, f))}`).join(" / ") : "条件一致全体"}（${group.population_count}人）`,
				ids: [],
			});
			for (const [index, metric] of group.metrics.entries()) {
				if (
					metric.op !== args.metrics[index].op ||
					metric.field !== args.metrics[index].field ||
					(metric.op !== "difference" &&
						metric.population_count !== group.population_count)
				)
					fail("invalid_result");
				entries.push(
					...(await metricEntries(
						collection,
						base,
						metric,
						args.metrics[index],
						group,
						args.group_by,
					)),
				);
			}
		}
		if (!groups.length) entries.push({ text: "集計可能な組は0組。", ids: [] });
		const ids = [...new Set(entries.flatMap((entry) => entry.ids))];
		return pack(
			base,
			entries,
			`集計：母集団${population.length}人 / 対象${groups.length}組（全${base.group_count}組） / 条件不明${base.unknown_count}人 / 分類不明${base.unknown_group_count ?? 0}人`,
			ids,
			base.unknown_count === 0 &&
				(base.unknown_group_count ?? 0) === 0 &&
				(base.ranking_unknown_group_count ?? 0) === 0 &&
				groups.every((group) =>
					group.metrics.every((metric) => metric.unknown_count === 0),
				),
			collection.limits,
		);
	});
}
