import { describe, expect, it, vi } from "vitest";
import type { SheetColumnKey } from "../columnCatalog";
import {
	aggregateArgs,
	artificialMembers,
	fixture,
	NOW,
	ok,
	queryArgs,
} from "../search/testFixtures";
import type { SearchResult, Where } from "../search/types";
import {
	type AnswerSource,
	PreparedSheetAnswer,
	verifyAnswerSelection,
} from "./contracts";
import {
	prepareAggregateAnswer,
	prepareGenerationAnswer,
	prepareQueryAnswer,
} from "./prepare";

type Member = Partial<Record<SheetColumnKey, string>>;
const roster: Member[] = [
	...Array.from({ length: 20 }, (_, index) => ({
		sid: String(100 + index),
		full_name: `人工23期${index}`,
		pinyin: `Person ${index}`,
		generation: index % 2 ? "SNH48 二十三期生" : "SNH48 ２３期生",
		primary_affiliation: index % 2 ? "TeamA" : "TeamB",
		secondary_affiliation: index >= 17 ? "暫休/退団" : "",
		status: index >= 17 ? "44" : "99",
		newcomer_flag: index === 16 ? "予備生" : "",
	})),
	...Array.from({ length: 9 }, (_, index) => ({
		sid: String(200 + index),
		full_name: `人工24期${index}`,
		generation: "SNH48 24期生",
		primary_affiliation: index === 8 ? "予備生" : "TeamA",
		secondary_affiliation: index === 8 ? "暫休/退団" : "",
		status: "99",
	})),
	{ sid: "301", full_name: "別期", generation: "SNH48 22期生" },
	{ sid: "302", full_name: "別グループ", generation: "BEJ48 23期生" },
];
function ready(value: unknown): asserts value is PreparedSheetAnswer {
	expect(value).toBeInstanceOf(PreparedSheetAnswer);
}
function text(answer: PreparedSheetAnswer) {
	return answer.chunks.map((c) => c.content).join("\n");
}
function displayed(answer: PreparedSheetAnswer) {
	return answer.chunks.flatMap((c) => c.ids);
}
function receipts(
	answer: PreparedSheetAnswer,
	indexes = answer.chunks.map((_, i) => i),
) {
	return indexes.map((index) => ({
		index,
		content: answer.chunks[index]?.content ?? "",
	}));
}
function suffix(ids: string[]) {
	return ids.map((id) => id.split(":").at(-1));
}
function condition(
	field: "height" | "age" | "state_flags",
	op: "eq" | "gte",
	value: number | string,
): Where {
	return { any: [{ all: [{ field, op, values: [value] }] }] };
}
function corrupt(
	source: AnswerSource,
	change: (result: SearchResult, call: number) => void,
): AnswerSource {
	let call = 0;
	return {
		readResultSet: (handle) => source.readResultSet(handle),
		execute: async (name, args) => {
			const result = await source.execute(name, args);
			if (result.status === "ok") change(result, ++call);
			return result;
		},
	};
}

describe("verified sheet answers", () => {
	it("renders exactly the artificial 23rd/24th generations: 20+9 people and all statuses", async () => {
		const { engine } = await fixture(roster);
		const answer = await prepareGenerationAnswer(engine, {
			group: "SNH48",
			generations: ["二十三期", "２４", 23],
		});
		ready(answer);
		expect(answer.metadata).toMatchObject({
			matched_count: 29,
			selected_count: 29,
			unknown_count: 0,
		});
		expect(suffix(displayed(answer))).toEqual([
			...Array.from({ length: 20 }, (_, i) => String(100 + i)),
			...Array.from({ length: 9 }, (_, i) => String(200 + i)),
		]);
		expect(text(answer)).toContain("SNH48 23期：20人");
		expect(text(answer)).toContain("SNH48 24期：9人");
		expect(text(answer)).toContain("予備生 / 兼任先：暫休 / 退団");
		expect(text(answer)).toContain("状態：状態矛盾");
		expect(text(answer)).not.toContain("別期");
		expect(text(answer)).not.toContain("別グループ");
		expect(answer.deliveryState()).toMatchObject({
			status: "unsent",
			delivered_ids: [],
		});
		expect(answer.confirmDelivered(receipts(answer))).toBe(true);
		expect(answer.deliveryState()).toMatchObject({
			status: "complete",
			undelivered_ids: [],
		});
		expect(answer.deliveryState().delivered_ids).toHaveLength(29);
	});
	it("uses typed AND/OR conditions for general sets, with deterministic page completion", async () => {
		const { engine } = await fixture();
		const where: Where = {
			any: [
				{
					all: [
						{ field: "generation_group", op: "eq", values: ["SNH48"] },
						{ field: "generation_number", op: "in", values: [23, 24] },
					],
				},
				{ all: [{ field: "generation_group", op: "eq", values: ["BEJ48"] }] },
			],
		};
		const a = await prepareQueryAnswer(engine, {
			...queryArgs,
			where,
			page_size: 1,
		});
		const b = await prepareQueryAnswer(engine, {
			...queryArgs,
			where,
			page_size: 100,
		});
		ready(a);
		ready(b);
		expect(suffix(displayed(a))).toEqual(["101", "202", "303"]);
		expect(text(a)).toBe(text(b));
		expect(text(a)).toContain("AND");
		expect(text(a)).toContain("OR");
	});
	it("requires an explicit group and preserves zero matches", async () => {
		const { engine } = await fixture(roster);
		expect(
			await prepareGenerationAnswer(engine, { group: null, generations: [23] }),
		).toMatchObject({ status: "error", reason: "missing_context" });
		expect(
			await prepareGenerationAnswer(engine, {
				group: "SNH48",
				generations: ["二三"],
			}),
		).toMatchObject({ status: "error", reason: "invalid_arguments" });
		const answer = await prepareGenerationAnswer(engine, {
			group: "SNH48",
			generations: [99],
		});
		ready(answer);
		expect(answer.metadata.selected_count).toBe(0);
		expect(text(answer)).toContain("条件一致は0人");
		expect(displayed(answer)).toEqual([]);
	});
	it("keeps different IDs with identical names and marks unknown filter/rank values incomplete", async () => {
		const { engine } = await fixture();
		const all = await prepareQueryAnswer(engine, queryArgs);
		ready(all);
		expect(text(all).match(/架空乙/g)).toHaveLength(2);
		const filtered = await prepareQueryAnswer(engine, {
			...queryArgs,
			where: condition("age", "gte", 20),
		});
		ready(filtered);
		expect(filtered.metadata.unknown_count).toBe(3);
		expect(filtered.selectionComplete).toBe(false);
		expect(text(filtered)).toContain("一部表示・未完了");
		const ranked = await prepareQueryAnswer(engine, {
			...queryArgs,
			sort: [{ field: "height", direction: "asc" }],
			top_n: 1,
			page_size: 1,
		});
		ready(ranked);
		expect(suffix(displayed(ranked))).toEqual(["101", "202"]);
		expect(text(ranked)).toContain("境界同値を1人追加");
		expect(text(ranked)).toContain("順位不明2人");
		expect(ranked.selectionComplete).toBe(false);
	});
	it("separates immutable prepared chunks from actual, possibly failed/out-of-order delivery", async () => {
		const { engine } = await fixture(roster);
		const answer = await prepareQueryAnswer(engine, queryArgs);
		ready(answer);
		expect(answer.chunks.length).toBeGreaterThan(1);
		const copy = answer.chunks;
		copy[0].content = "changed";
		copy[0].ids = [];
		expect(answer.chunks[0].content).not.toBe("changed");
		expect(answer.metadata).not.toHaveProperty("records");
		expect(answer.confirmDelivered(receipts(answer, [0, 999]))).toBe(false);
		expect(answer.deliveryState().confirmed_chunks).toEqual([]);
		expect(answer.confirmDelivered([{ index: 0, content: "changed" }])).toBe(
			false,
		);
		expect(answer.confirmDelivered(receipts(answer, [1, 1]))).toBe(true);
		expect(answer.deliveryState().delivered_ids).toEqual(answer.chunks[1].ids);
		expect(answer.deliveryState().status).toBe("partial");
		answer.confirmDelivered(receipts(answer));
		expect(answer.deliveryState().status).toBe("complete");
	});
	it("returns explicit partial chunks under display limits, never splitting a row or counting preview as delivered", async () => {
		const { engine } = await fixture(roster);
		const answer = await prepareQueryAnswer(engine, queryArgs, {
			maxChunks: 1,
			chunkLimit: 600,
		});
		ready(answer);
		expect(answer.omittedEntries).toBeGreaterThan(0);
		expect(text(answer)).toContain("一部表示・未完了");
		expect(answer.chunks.every((c) => c.content.length <= 600)).toBe(true);
		expect(answer.deliveryState().delivered_ids).toEqual([]);
		answer.confirmDelivered(receipts(answer, [0]));
		expect(answer.deliveryState().status).toBe("partial");
		expect(answer.deliveryState().undelivered_ids.length).toBeGreaterThan(0);
		expect(answer.omittedIds).toEqual(answer.deliveryState().undelivered_ids);
	});
	it("excludes only acknowledged IDs on the next question, rather than the entire selected set", async () => {
		const first = await fixture(roster);
		const answer = await prepareQueryAnswer(first.engine, queryArgs, {
			maxChunks: 1,
			chunkLimit: 800,
		});
		ready(answer);
		answer.confirmDelivered(receipts(answer, [0]));
		const delivered = answer.deliveryState().delivered_ids;
		expect(delivered.length).toBeGreaterThan(0);
		const next = await fixture(
			roster,
			"新版の説明",
			() => NOW + 1000,
			delivered,
		);
		const remaining = await prepareQueryAnswer(next.engine, {
			...queryArgs,
			exclude_previously_delivered: true,
		});
		ready(remaining);
		expect(remaining.metadata.snapshot_id).not.toBe(
			answer.metadata.snapshot_id,
		);
		expect(remaining.metadata.selected_count).toBe(
			roster.length - delivered.length,
		);
		expect(displayed(remaining).some((id) => delivered.includes(id))).toBe(
			false,
		);
	});
	it("checks structured IDs/counts/snapshot against the handle, without parsing names", async () => {
		const { engine } = await fixture();
		const result = await engine.execute("query_records", queryArgs);
		ok(result);
		const ids = result.records.map((r) => r.id);
		const proposal = {
			snapshot_id: result.snapshot_id,
			ids,
			count: ids.length,
		};
		expect(
			verifyAnswerSelection(engine, result.result_set_id, {
				...proposal,
				ids: [...ids].reverse(),
			}).status,
		).toBe("valid");
		for (const invalid of [
			{ ...proposal, count: 4 },
			{ ...proposal, ids: [ids[0], ...ids.slice(0, -1)] },
			{ ...proposal, snapshot_id: "other" },
			{ ...proposal, ids: [...ids.slice(1), "foreign"] },
			null,
			"text",
			{ ...proposal, ids: "not an array" },
			{ ...proposal, ids: [1] },
			{ ...proposal, count: 1.5 },
		])
			expect(
				verifyAnswerSelection(engine, result.result_set_id, invalid),
			).toMatchObject({ status: "error", reason: "selection_mismatch" });
	});
	it.each([
		"snapshot",
		"duplicate",
		"missing",
		"foreign",
		"count",
		"coverage",
		"truncation",
		"fragment",
		"filters",
	])(
		"rejects %s corruption instead of preparing a complete list",
		async (kind) => {
			const { engine } = await fixture();
			const source = corrupt(engine, (r) => {
				if (kind === "snapshot") r.snapshot_id = "other";
				if (kind === "duplicate") r.records[1] = r.records[0];
				if (kind === "missing") {
					r.records.pop();
					r.returned_count--;
				}
				if (kind === "foreign") r.records[0].id = "other";
				if (kind === "count") r.selected_count++;
				if (kind === "coverage") r.coverage = "candidate_only";
				if (kind === "truncation") r.truncated = true;
				if (kind === "fragment") r.records[0].cell_fragment = "partial";
				if (kind === "filters") r.applied_filters = condition("age", "gte", 99);
			});
			expect(await prepareQueryAnswer(source, queryArgs)).toMatchObject({
				status: "error",
			});
		},
	);
	it("rejects changed page metadata, page/byte exhaustion, non-first cursors and oversized rows", async () => {
		const { engine } = await fixture();
		const source = corrupt(engine, (r, call) => {
			if (call > 1) r.normalization_version++;
		});
		expect(
			await prepareQueryAnswer(source, { ...queryArgs, page_size: 1 }),
		).toMatchObject({ status: "error", reason: "invalid_result" });
		for (const limits of [{ maxPages: 1 }, { maxResultBytes: 1 }])
			expect(
				await prepareQueryAnswer(
					engine,
					{ ...queryArgs, page_size: 1 },
					limits,
				),
			).toMatchObject({ status: "error", reason: "budget_exceeded" });
		expect(
			await prepareQueryAnswer(engine, { ...queryArgs, cursor: "page2" }),
		).toMatchObject({ status: "error", reason: "invalid_arguments" });
		const huge = await fixture([
			{ ...roster[0], full_name: "😀".repeat(1200) },
		]);
		expect(await prepareQueryAnswer(huge.engine, queryArgs)).toMatchObject({
			status: "error",
			reason: "budget_exceeded",
		});
	});
	it("fails closed for unavailable/expired snapshots and missing prior-delivery context", async () => {
		let now = NOW;
		const { engine, ref } = await fixture(roster, "rules", () => now);
		expect(
			await prepareQueryAnswer(engine, {
				...queryArgs,
				exclude_previously_delivered: true,
			}),
		).toMatchObject({ status: "error", reason: "missing_context" });
		now = ref.expiresAt;
		expect(await prepareQueryAnswer(engine, queryArgs)).toMatchObject({
			status: "error",
			reason: "snapshot_expired",
		});
		const unavailable: AnswerSource = {
			execute: async () => ({
				status: "error",
				reason: "source_error",
				snapshot_id: "missing",
			}),
			readResultSet: () => ({
				status: "error",
				reason: "source_error",
				snapshot_id: "missing",
			}),
		};
		expect(await prepareQueryAnswer(unavailable, queryArgs)).toEqual({
			status: "error",
			reason: "source_error",
		});
	});
	it("treats malicious cell content as inline data, with no mentions or forged rows", async () => {
		const { engine } = await fixture([
			{
				...roster[0],
				full_name:
					"@everyone\n**偽ヘッダー** <@123> https://example.com discord.gg/invite 😀",
			},
		]);
		const answer = await prepareQueryAnswer(engine, queryArgs);
		ready(answer);
		expect(text(answer)).not.toContain("@everyone");
		expect(text(answer)).not.toContain("\n**偽");
		expect(text(answer)).not.toContain("https://");
		expect(text(answer)).not.toContain("discord.gg/");
		expect(text(answer)).toContain("😀");
		expect(displayed(answer)).toHaveLength(1);
	});
	it("collects 150 artificial rows at default limits and explicitly caps display", async () => {
		const members = Array.from({ length: 150 }, (_, i) => ({
			...roster[0],
			sid: String(1000 + i),
			full_name: `人工の大規模一覧メンバー${i}`,
		}));
		const { engine } = await fixture(members);
		const answer = await prepareQueryAnswer(engine, queryArgs);
		ready(answer);
		expect(answer.metadata.selected_count).toBe(150);
		expect(answer.chunks).toHaveLength(8);
		expect(answer.omittedIds.length).toBeGreaterThan(0);
		expect(text(answer)).toContain("一部表示・未完了");
	});
	it("includes unknown/unparsed generations in the same count breakdown", async () => {
		const { engine } = await fixture([
			{ ...roster[0] },
			{ ...roster[1], generation: "不明" },
			{ ...roster[2], generation: "" },
		]);
		const answer = await prepareQueryAnswer(engine, queryArgs);
		ready(answer);
		expect(text(answer)).toContain("SNH48 23期：1人");
		expect(text(answer)).toContain("期不明・未解析：2人");
		expect(displayed(answer)).toHaveLength(3);
	});
	it("keeps the pinned source and description despite a newer capture and caller changes", async () => {
		const { engine } = await fixture(roster, "旧版の回答規則");
		const args = structuredClone(queryArgs);
		const pending = prepareQueryAnswer(engine, args);
		args.where = condition("age", "gte", 99);
		await fixture([{ ...roster[0], full_name: "新版" }], "新ルール");
		const answer = await pending;
		ready(answer);
		expect(text(answer)).not.toContain("新版");
		expect(answer.metadata.applied_filters).toBe(null);
		expect(engine.description).toBe("旧版の回答規則");
	});
});

describe("deterministic aggregate answers", () => {
	it("retains an indeterminate difference when only unrelated population rows have valid values", async () => {
		const { engine } = await fixture([
			{ ...roster[0], height: "非公開" },
			{ ...roster[1], height: "" },
			{ ...roster[2], height: "160" },
		]);
		const result = await engine.execute("query_records", queryArgs);
		ok(result);
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [
				{
					op: "difference",
					field: "height",
					operands: {
						left_id: result.records[0].id,
						right_id: result.records[1].id,
					},
				},
			],
		});
		ready(answer);
		expect(answer.selectionComplete).toBe(false);
		expect(text(answer)).toContain("算出不能");
		expect(displayed(answer)).toHaveLength(2);
	});
	it("marks extrema over known values incomplete when hidden values may change the answer", async () => {
		const { engine } = await fixture([
			{ ...roster[0], height: "160" },
			{ ...roster[1], height: "非公開" },
		]);
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "min", field: "height", operands: null }],
		});
		ready(answer);
		expect(answer.selectionComplete).toBe(false);
		expect(text(answer)).toContain("一部表示・未完了");
		answer.confirmDelivered(receipts(answer));
		expect(answer.deliveryState().status).toBe("partial");
	});
	it.each(["foreign_group", "missing_tied_count"])(
		"rejects grouped tie %s",
		async (kind) => {
			const { engine } = await fixture([
				{ ...roster[0], height: "160", primary_affiliation: "TeamA" },
				{ ...roster[1], height: "160", primary_affiliation: "TeamB" },
			]);
			const source = corrupt(engine, (result, call) => {
				if (call !== 1) return;
				const metric = result.groups[0].metrics[0];
				if (kind === "missing_tied_count") delete metric.tied_count;
				else {
					metric.tied_set_id = result.groups[1].metrics[0].tied_set_id;
					metric.tied_ids = result.groups[1].metrics[0].tied_ids;
				}
			});
			expect(
				await prepareAggregateAnswer(source, {
					...aggregateArgs,
					metrics: [{ op: "min", field: "height", operands: null }],
					group_by: ["primary_affiliation"],
				}),
			).toMatchObject({ status: "error", reason: "invalid_result" });
		},
	);
	it("checks a difference against the same executor calculation over its retrieved operands", async () => {
		const { engine } = await fixture();
		const result = await engine.execute("query_records", queryArgs);
		ok(result);
		const source = corrupt(engine, (page, call) => {
			if (call === 1) page.groups[0].metrics[0].value = 999;
		});
		expect(
			await prepareAggregateAnswer(source, {
				...aggregateArgs,
				metrics: [
					{
						op: "difference",
						field: "debut_date",
						operands: {
							left_id: result.records[0].id,
							right_id: result.records[1].id,
						},
					},
				],
			}),
		).toMatchObject({ status: "error", reason: "invalid_result" });
	});
	it("counts the same population and shows mean denominators and unknown states", async () => {
		const { engine } = await fixture();
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [
				{ op: "count", field: null, operands: null },
				{ op: "mean", field: "age", operands: null },
			],
		});
		ready(answer);
		expect(text(answer)).toContain("人数：5");
		expect(text(answer)).toContain("平均：21");
		expect(text(answer)).toContain("母集団5、有効2、不明3");
		expect(text(answer)).toContain("非公開1");
		expect(displayed(answer)).toEqual([]);
		answer.confirmDelivered(receipts(answer));
		expect(answer.deliveryState()).toMatchObject({
			status: "partial",
			delivered_ids: [],
		});
	});
	it("fetches and renders all minimum ties beyond the 20-ID preview", async () => {
		const members = Array.from({ length: 25 }, (_, i) => ({
			...roster[0],
			sid: String(1000 + i),
			full_name: `同順位${i}`,
			height: "160",
		}));
		const { engine } = await fixture(members);
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "min", field: "height", operands: null }],
		});
		ready(answer);
		expect(displayed(answer)).toHaveLength(25);
		expect(new Set(displayed(answer)).size).toBe(25);
		expect(text(answer)).toContain("同値の対象25人");
		expect(answer.chunks.every((c) => c.content.length <= 2000)).toBe(true);
	});
	it("retains every tied top group and labels group counts separately from people", async () => {
		const members = [
			{ ...roster[0], age: "20", primary_affiliation: "TeamA" },
			{ ...roster[1], age: "20", primary_affiliation: "TeamB" },
			{ ...roster[2], age: "非公開", primary_affiliation: "TeamC" },
		];
		const { engine } = await fixture(members);
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "mean", field: "age", operands: null }],
			group_by: ["primary_affiliation"],
			sort_metric_index: 0,
			sort_direction: "desc",
			top_n: 1,
			page_size: 1,
		});
		ready(answer);
		expect(text(answer)).toContain("対象2組（全3組）");
		expect(text(answer)).toContain("境界同値を1組追加");
		expect(text(answer)).toContain("順位不明1組");
		expect(answer.selectionComplete).toBe(false);
	});
	it("renders multi-membership counts, extrema, best-rank years and signed date differences", async () => {
		const { engine } = await fixture();
		const grouped = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			group_by: ["primary_affiliation", "secondary_affiliation"],
			page_size: 1,
		});
		ready(grouped);
		expect(text(grouped)).toContain("合計と全体の人数は異なる");
		const best = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "best_rank", field: "election_history", operands: null }],
		});
		ready(best);
		expect(suffix(displayed(best))).toEqual(["101", "202"]);
		expect(text(best)).toContain("2024年 3位");
		expect(text(best)).not.toContain("2026年");
		const maximum = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "max", field: "height", operands: null }],
		});
		ready(maximum);
		expect(suffix(displayed(maximum))).toEqual(["404"]);
		const records = await engine.execute("query_records", queryArgs);
		ok(records);
		const difference = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [
				{
					op: "difference",
					field: "debut_date",
					operands: {
						left_id: records.records[0].id,
						right_id: records.records[1].id,
					},
				},
			],
		});
		ready(difference);
		expect(text(difference)).toContain("左−右の差：1 days");
		expect(text(difference)).toContain("左 ・架空甲");
		expect(text(difference)).toContain("右 ・架空乙");
	});
	it("does not fabricate results for null metrics, empty population or missing group values", async () => {
		const { engine } = await fixture([{ ...artificialMembers[4] }]);
		const answer = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			metrics: [{ op: "min", field: "height", operands: null }],
		});
		ready(answer);
		expect(text(answer)).toContain("算出不能");
		expect(displayed(answer)).toEqual([]);
		const zero = await prepareAggregateAnswer(engine, {
			...aggregateArgs,
			where: condition("height", "gte", 999),
		});
		ready(zero);
		expect(text(zero)).toContain("人数：0");
	});
	it.each([
		"missing_group",
		"duplicate_group",
		"metric_count",
		"tie_count",
		"tie_preview",
	])("rejects inconsistent aggregate %s", async (kind) => {
		const { engine } = await fixture();
		const source = corrupt(engine, (r, call) => {
			if (call !== 1) return;
			if (kind === "missing_group") {
				r.groups = [];
				r.returned_count = 0;
			}
			if (kind === "duplicate_group") {
				r.groups.push(r.groups[0]);
				r.returned_count++;
			}
			if (kind === "metric_count") r.groups[0].metrics[0].valid_count++;
			if (kind === "tie_count") r.groups[0].metrics[0].tied_count = 9;
			if (kind === "tie_preview") r.groups[0].metrics[0].tied_ids = ["foreign"];
		});
		expect(
			await prepareAggregateAnswer(source, {
				...aggregateArgs,
				metrics: [{ op: "min", field: "height", operands: null }],
			}),
		).toMatchObject({ status: "error" });
	});
	it("performs no external requests or model calls while preparing answers", async () => {
		const { engine } = await fixture(roster);
		const fetch = vi.spyOn(globalThis, "fetch");
		try {
			ready(await prepareQueryAnswer(engine, queryArgs));
			ready(await prepareAggregateAnswer(engine, aggregateArgs));
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	it.each(["count_value", "nonfinite", "missing_total"])(
		"rejects invalid numeric aggregate %s",
		async (kind) => {
			const { engine } = await fixture();
			const source = corrupt(engine, (result) => {
				const metric = result.groups[0].metrics[0];
				if (kind === "count_value") metric.value = 99;
				if (kind === "nonfinite") metric.value = Infinity;
				if (kind === "missing_total") metric.missing_by_state = { invalid: 1 };
			});
			expect(await prepareAggregateAnswer(source, aggregateArgs)).toMatchObject(
				{ status: "error", reason: "invalid_result" },
			);
		},
	);
});
