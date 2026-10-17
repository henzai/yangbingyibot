import { describe, expect, it } from "vitest";
import { dateCell } from "./cells";
import {
	aggregateArgs,
	artificialMembers,
	fixture,
	getArgs,
	ok,
	queryArgs,
	searchArgs,
} from "./testFixtures";
import type { Metric, SearchArgs } from "./types";

describe("identity rules adapted from PR #478", () => {
	it.each([
		["絶死は？", ["101"]],
		["はずれしってる？", ["202"]],
		["めんやんにの情報", ["202"]],
		["youと赤", ["101"]],
		["what do you know?", []],
		["赤", ["101"]],
		["c", ["202"]],
		["Team cのメンバー", []],
		["はずれabc", ["202"]],
		["superaurora", []],
		["ＡＵＲＯＲＡ", ["101"]],
		["小甲", ["101"]],
		["JIA XIANG", ["101"]],
		["ji a xi ang", ["101"]],
		["顔パキ", []],
		["架空乙", ["202", "303"]],
		["shenxiみたいな名前", ["505"]],
		["蝶舞みたいな名前", ["404"]],
		["秋野みたいな名前", ["303"]],
		["shenxiの年齢", []],
	])("%s produces candidates %j", async (query, expected) => {
		const { engine } = await fixture();
		const result = await engine.execute("search_records", {
			...searchArgs,
			query,
		});
		ok(result);
		expect(result.records.map((r) => r.id.split(":").at(-1))).toEqual(expected);
		expect(result.coverage).toBe("candidate_only");
	});
	it("paginates more than eight identities and retains stable matched sources", async () => {
		const members = Array.from({ length: 12 }, (_, i) => ({
			...artificialMembers[0],
			sid: String(100 + i),
			full_name: `架空${i}`,
			community_nicknames: "共通名/共通名",
		}));
		const { engine } = await fixture(members);
		const args: SearchArgs = { ...searchArgs, query: "共通名", page_size: 5 };
		let cursor: string | null = null;
		const seen = new Set<string>();
		do {
			const r = await engine.execute("search_records", { ...args, cursor });
			ok(r);
			expect(r.selected_count).toBe(12);
			for (const row of r.records) seen.add(row.id);
			cursor = r.next_cursor;
		} while (cursor);
		expect(seen.size).toBe(12);
	});
	it("supports explicit identity field selection without expanding to unrelated attributes", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("search_records", {
			...searchArgs,
			query: "Aurora",
			search_fields: ["full_name"],
		});
		ok(r);
		expect(r.matched_count).toBe(0);
		expect(
			await engine.execute("search_records", {
				...searchArgs,
				search_fields: ["career"],
			}),
		).toMatchObject({ reason: "invalid_arguments" });
	});
});

describe("typed aggregation and calendar calculations", () => {
	it("uses the same complete population for count/mean and preserves excluded states", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [
				{ op: "count", field: null, operands: null },
				{ op: "mean", field: "age", operands: null },
			],
		});
		ok(r);
		expect(r.groups[0].metrics[0]).toMatchObject({
			value: 5,
			population_count: 5,
			valid_count: 5,
		});
		expect(r.groups[0].metrics[1]).toMatchObject({
			value: 21,
			population_count: 5,
			valid_count: 2,
			unknown_count: 3,
			missing_by_state: { not_public: 1, placeholder: 1, formula_error: 1 },
			unit: "years",
		});
	});
	it("returns complete min/max ties via handles, including sets larger than preview", async () => {
		const members = Array.from({ length: 25 }, (_, i) => ({
			...artificialMembers[0],
			sid: String(100 + i),
		}));
		const { engine } = await fixture(members);
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [{ op: "min", field: "height", operands: null }],
		});
		ok(r);
		expect(r.groups[0].metrics[0]).toMatchObject({
			value: 165,
			tied_count: 25,
			tied_set_id: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(r.groups[0].metrics[0].tied_ids).toBeUndefined();
	});
	it("computes grouped means, keeps all boundary ties and pages groups", async () => {
		const members = [
			{ ...artificialMembers[0], primary_affiliation: "TeamA", age: "20" },
			{ ...artificialMembers[1], primary_affiliation: "TeamB", age: "20" },
			{ ...artificialMembers[2], primary_affiliation: "TeamC", age: "18" },
		];
		const { engine } = await fixture(members);
		const args = {
			...aggregateArgs,
			metrics: [{ op: "mean", field: "age", operands: null }],
			group_by: ["primary_affiliation"],
			sort_metric_index: 0,
			sort_direction: "desc",
			top_n: 1,
			page_size: 1,
		};
		const a = await engine.execute("aggregate_records", args);
		ok(a);
		expect(a).toMatchObject({
			matched_count: 3,
			selected_count: 3,
			group_count: 3,
			selected_group_count: 2,
			returned_count: 1,
			truncated: true,
		});
		const b = await engine.execute("aggregate_records", {
			...args,
			cursor: a.next_cursor,
		});
		ok(b);
		expect(b.groups[0].key).not.toBe(a.groups[0].key);
		expect(b.result_set_id).toBe(a.result_set_id);
	});
	it("keeps generation group and integer separate, with unknown groups counted", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			group_by: ["generation_group", "generation_number"],
		});
		ok(r);
		expect(r.group_count).toBe(4);
		expect(r.unknown_group_count).toBe(1);
		expect(r.groups.reduce((sum, g) => sum + g.population_count, 0)).toBe(4);
	});
	it("uses only positive annual ranks, never assigns a year to G", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [{ op: "best_rank", field: "election_history", operands: null }],
		});
		ok(r);
		expect(r.groups[0].metrics[0]).toMatchObject({
			value: 3,
			rank_match_count: 2,
			valid_count: 2,
			unknown_count: 3,
		});
		expect(r.groups[0].metrics[0].ranks?.map((rank) => rank.year)).toEqual([
			2024, 2024,
		]);
		const q = await engine.execute("query_records", queryArgs);
		ok(q);
		const record = await engine.execute("get_records", {
			...getArgs,
			ids: [q.records[0].id],
			fields: ["latest_rank", "election_history"],
		});
		ok(record);
		expect(record.records[0].cells.latest_rank).toMatchObject({
			value: 1,
			reason: "year_unknown",
		});
		const history = record.records[1].cells.election_history;
		expect(history?.value).toEqual([{ year: 2024, rank: 3 }]);
		expect(history?.components?.election_2025).toMatchObject({
			field_state: "invalid",
			raw: "0",
		});
	});
	it("computes left-minus-right numbers/days only for IDs in the condition set", async () => {
		const { engine } = await fixture();
		const q = await engine.execute("query_records", queryArgs);
		ok(q);
		const operands = { left_id: q.records[0].id, right_id: q.records[1].id };
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [
				{ op: "difference", field: "age", operands },
				{ op: "difference", field: "birthday", operands },
			],
		});
		ok(r);
		expect(r.groups[0].metrics[0].value).toBe(-2);
		expect(r.groups[0].metrics[1].value).toBe(
			(Date.parse("2006-10-17") - Date.parse("2004-02-29")) / 86400000,
		);
		expect(
			await engine.execute("aggregate_records", {
				...aggregateArgs,
				where: { any: [{ all: [{ field: "age", op: "eq", values: [20] }] }] },
				metrics: [{ op: "difference", field: "age", operands }],
			}),
		).toMatchObject({ reason: "unknown_id" });
	});
	it("retains date precision and leap-day uncertainty, computes ordinal years and signed target difference", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("query_records", {
			...queryArgs,
			fields: [
				"age_at",
				"tenure_completed_years",
				"tenure_ordinal_year",
				"days_until_birthday",
				"days_until_target_age",
			],
			calculation_context: { as_of: "2026-10-17", target_age: 18 },
		});
		ok(r);
		expect(r.records[0].cells).toMatchObject({
			age_at: { value: 20 },
			tenure_completed_years: { value: 5 },
			tenure_ordinal_year: { value: 6 },
			days_until_birthday: { value: 0 },
			days_until_target_age: { value: -730 },
		});
		expect(r.records[1].cells.days_until_birthday?.reason).toBe(
			"leap_day_policy_unresolved",
		);
		expect(r.records[2].cells.age_at?.reason).toBe(
			"insufficient_date_precision",
		);
		expect(r.records[2].cells.days_until_birthday?.value).toBe(0);
		expect(r.records[3].cells.age_at?.reason).toBe(
			"insufficient_date_precision",
		);
		expect(r.records[4].cells.age_at?.reason).toBe("invalid_date");
	});
	it("binds default calculation date to Tokyo at question start and supports next-year birthday", async () => {
		const { engine } = await fixture([
			{ ...artificialMembers[0], birthday: "2000-01-01" },
		]);
		const r = await engine.execute("query_records", {
			...queryArgs,
			fields: ["days_until_birthday"],
		});
		ok(r);
		expect(r.calculation_context.as_of).toBe("2026-10-17");
		expect(r.records[0].cells.days_until_birthday?.value).toBe(76);
	});
	it("returns unknown for partial dates in comparisons rather than inventing a day", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("query_records", {
			...queryArgs,
			where: {
				any: [
					{ all: [{ field: "birthday", op: "lt", values: ["2005-01-01"] }] },
				],
			},
		});
		ok(r);
		expect(r.records).toHaveLength(1);
		expect(r.unknown_count).toBe(3);
	});
	it.each([
		[{ op: "mean", field: "birthday", operands: null }],
		[{ op: "min", field: "full_name", operands: null }],
		[{ op: "count", field: "age", operands: null }],
		[{ op: "best_rank", field: "latest_rank", operands: null }],
		[{ op: "difference", field: "height", operands: null }],
	] as Metric[][])(
		"rejects invalid metric combinations %j",
		async (metrics) => {
			const { engine } = await fixture();
			expect(
				await engine.execute("aggregate_records", {
					...aggregateArgs,
					metrics,
				}),
			).toMatchObject({ reason: "invalid_arguments" });
		},
	);
});

describe("typed value boundaries", () => {
	it.each(["1,23", "12万", "200cmx", "0", "-1", "999"])(
		"does not silently repair invalid height %s",
		async (height) => {
			const { engine } = await fixture([{ ...artificialMembers[0], height }]);
			const r = await engine.execute("query_records", {
				...queryArgs,
				fields: ["height"],
			});
			ok(r);
			expect(r.records[0].cells.height?.field_state).toBe("invalid");
		},
	);
	it("returns no fabricated min/mean for a population with no valid values", async () => {
		const { engine } = await fixture([
			{ ...artificialMembers[0], age: "非公開" },
		]);
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [
				{ op: "mean", field: "age", operands: null },
				{ op: "min", field: "age", operands: null },
			],
		});
		ok(r);
		expect(
			r.groups[0].metrics.every(
				(metric) => metric.value === null && metric.unknown_count === 1,
			),
		).toBe(true);
	});
	it("keeps complete tie IDs accessible through the internal renderer boundary", async () => {
		const { engine } = await fixture();
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [{ op: "min", field: "height", operands: null }],
		});
		ok(r);
		const set = engine.readResultSet(r.groups[0].metrics[0].tied_set_id ?? "");
		expect(set).toMatchObject({ status: "ready", ids: expect.any(Array) });
		if (set.status === "ready") expect(set.ids).toHaveLength(2);
	});
});

describe("partial dates from the source contract", () => {
	it.each(["????-10-17", "10月17日", "10/17"])(
		"retains month/day without inventing a year for %s",
		(raw) => {
			expect(dateCell(raw, "birthday")).toMatchObject({
				raw,
				value: "10-17",
				precision: "month_day",
				field_state: "value",
			});
		},
	);
});

describe("grouped distinct populations and incomplete ranking values", () => {
	it("deduplicates one member within a normalized set group", async () => {
		const { engine } = await fixture([
			{
				...artificialMembers[0],
				primary_affiliation: "TeamC/teamc/ＴｅａｍＣ",
			},
		]);
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			group_by: ["primary_affiliation"],
		});
		ok(r);
		expect(r.groups).toHaveLength(1);
		expect(r.groups[0].metrics[0].value).toBe(1);
		expect(r.groups[0].population_count).toBe(1);
	});
	it("does not rank unknown group means as tied winners", async () => {
		const { engine } = await fixture([
			{ ...artificialMembers[0], age: "非公開" },
			{ ...artificialMembers[1], age: "" },
		]);
		const r = await engine.execute("aggregate_records", {
			...aggregateArgs,
			metrics: [{ op: "mean", field: "age", operands: null }],
			group_by: ["primary_affiliation"],
			sort_metric_index: 0,
			top_n: 1,
		});
		ok(r);
		expect(r.group_count).toBe(2);
		expect(r.selected_group_count).toBe(0);
		expect(r.ranking_unknown_group_count).toBe(2);
		expect(r.groups).toHaveLength(0);
	});
});
