import { describe, expect, it, vi } from "vitest";
import { SheetSearchEngine } from "./engine";
import {
	artificialMembers,
	fixture,
	getArgs,
	NOW,
	ok,
	queryArgs,
	SOURCE,
	searchArgs,
} from "./testFixtures";
import type { Field, QueryArgs, SearchResult, Where } from "./types";

const where = (
	field: Field,
	op: "eq" | "in" | "is_missing" | "is_present" | "contains" | "not_in",
	...values: (string | number)[]
): Where => ({ any: [{ all: [{ field, op, values }] }] });
async function ids(result: Promise<unknown>) {
	const r = await result;
	ok(r);
	return r.records.map((row) => row.id.split(":").at(-1));
}

describe("snapshot-bound sheet search", () => {
	it("reads the same pinned members and instructions after caller mutation and a new snapshot", async () => {
		const f = await fixture();
		f.structure.personRows[0][0] = "modified";
		const b = await fixture(
			[{ ...artificialMembers[0], full_name: "更新版" }],
			"新しい説明",
		);
		expect(f.engine.description).toBe("人工の人格・回答規則と用語定義");
		const aResult = await f.engine.execute("query_records", queryArgs);
		ok(aResult);
		expect(aResult.records[0].cells.full_name?.value).toBe("架空甲");
		const bResult = await b.engine.execute("query_records", queryArgs);
		ok(bResult);
		expect(bResult.records[0].cells.full_name?.value).toBe("更新版");
		expect(aResult.snapshot_id).not.toBe(bResult.snapshot_id);
	});
	it("separates exact generation/group sets, all states, and conflicting active status", async () => {
		const { engine } = await fixture();
		const conditions: Where = {
			any: [
				{
					all: [
						{ field: "generation_group", op: "eq", values: ["SNH48"] },
						{ field: "generation_number", op: "in", values: [23, 24] },
					],
				},
			],
		};
		expect(
			await ids(
				engine.execute("query_records", { ...queryArgs, where: conditions }),
			),
		).toEqual(["101", "202"]);
		expect(
			await ids(
				engine.execute("query_records", {
					...queryArgs,
					where: where("primary_affiliation", "eq", "TeamC"),
				}),
			),
		).toEqual(["101", "303", "404"]);
		const active = await engine.execute("query_records", {
			...queryArgs,
			where: where("state_flags", "eq", "active"),
		});
		ok(active);
		expect(active.records).toHaveLength(2);
		expect(active.unknown_count).toBe(2);
	});
	it("distinguishes empty, placeholder, non-public, error and invalid numbers", async () => {
		const { engine } = await fixture();
		const missing = await engine.execute("query_records", {
			...queryArgs,
			where: where("age", "is_missing"),
		});
		ok(missing);
		expect(missing.records.map((r) => r.id.split(":").at(-1))).toEqual(["404"]);
		expect(missing.unknown_count).toBe(2);
		const height = await engine.execute("query_records", {
			...queryArgs,
			fields: ["height", "pocket_followers"],
		});
		ok(height);
		expect(height.records[0].cells.pocket_followers).toMatchObject({
			value: 15000,
			unit: "followers",
		});
		expect(height.records[2].cells.height?.field_state).toBe("formula_error");
	});
	it("keeps all ties before paging and binds cursors/result handles to the complete query", async () => {
		const { engine } = await fixture();
		const args: QueryArgs = {
			...queryArgs,
			fields: ["height"],
			sort: [{ field: "height", direction: "asc" }],
			top_n: 1,
			page_size: 1,
		};
		const first = await engine.execute("query_records", args);
		ok(first);
		expect(first).toMatchObject({
			matched_count: 5,
			selected_count: 2,
			returned_count: 1,
			truncated: true,
			ranking_unknown_count: 2,
		});
		const second = await engine.execute("query_records", {
			...args,
			cursor: first.next_cursor,
		});
		ok(second);
		expect(second.records[0].id).not.toBe(first.records[0].id);
		expect(second.result_set_id).toBe(first.result_set_id);
		expect(second.next_cursor).toBeNull();
		expect(
			await engine.execute("query_records", {
				...args,
				fields: ["age"],
				cursor: first.next_cursor,
			}),
		).toMatchObject({ reason: "invalid_cursor" });
		expect(
			await engine.execute("query_records", {
				...args,
				cursor: first.next_cursor?.replace(/.$/, "x"),
			}),
		).toMatchObject({ reason: "invalid_cursor" });
		const other = await fixture([{ ...artificialMembers[0], height: "155" }]);
		expect(
			await other.engine.execute("query_records", {
				...args,
				cursor: first.next_cursor,
			}),
		).toMatchObject({ reason: "invalid_cursor" });
	});
	it("pages full conditions independently of top_n and preserves stable same-name IDs", async () => {
		const { engine } = await fixture();
		const all: SearchResult[] = [];
		let cursor: string | null = null;
		do {
			const r = await engine.execute("query_records", {
				...queryArgs,
				page_size: 2,
				cursor,
			});
			ok(r);
			all.push(r);
			cursor = r.next_cursor;
		} while (cursor);
		const records = all.flatMap((r) => r.records);
		expect(new Set(records.map((r) => r.id)).size).toBe(5);
		expect(new Set(all.map((r) => r.result_set_id)).size).toBe(1);
		expect(
			records.filter((r) => r.cells.full_name?.value === "架空乙"),
		).toHaveLength(2);
	});
	it("provides literal career search and description reference without claiming semantic recall", async () => {
		const { engine } = await fixture();
		const text = await engine.execute("search_records", {
			...searchArgs,
			mode: "text",
			query: "上海",
			search_fields: ["career"],
			page_size: 1,
		});
		ok(text);
		expect(text).toMatchObject({
			matched_count: 3,
			selected_count: 3,
			coverage: "lexical_matches",
			truncated: true,
		});
		const next = await engine.execute("search_records", {
			...searchArgs,
			mode: "text",
			query: "上海",
			search_fields: ["career"],
			page_size: 1,
			cursor: text.next_cursor,
		});
		ok(next);
		expect(next.result_set_id).toBe(text.result_set_id);
		const none = await engine.execute("search_records", {
			...searchArgs,
			mode: "text",
			query: "舞台役者",
			search_fields: ["career"],
		});
		ok(none);
		expect(none.matched_count).toBe(0);
		expect(none.coverage).toBe("lexical_matches");
		const reference = await engine.execute("search_records", {
			...searchArgs,
			dataset: "reference",
			mode: "text",
			query: "用語",
		});
		ok(reference);
		expect(reference.matched_count).toBe(1);
		const content = await engine.execute("get_records", {
			...getArgs,
			dataset: "reference",
			ids: [reference.records[0].id],
			fields: ["reference_body"],
		});
		ok(content);
		expect(content.records[0].cells.reference_body?.value).toBe(
			engine.description,
		);
	});
	it("gets all available fields and losslessly fragments very long cells", async () => {
		const long = "長文の根拠😀".repeat(8000);
		const { engine } = await fixture([
			{ ...artificialMembers[0], career: long },
		]);
		const queried = await engine.execute("query_records", queryArgs);
		ok(queried);
		const args = {
			...getArgs,
			ids: [queried.records[0].id],
			fields: null,
			preset: "all_available",
		};
		let cursor: string | null = null;
		const parts: string[] = [];
		const fields = new Set<string>();
		let pages = 0;
		do {
			const r = await engine.execute("get_records", { ...args, cursor });
			ok(r);
			pages++;
			expect(
				new TextEncoder().encode(JSON.stringify(r)).byteLength,
			).toBeLessThanOrEqual(32768);
			for (const record of r.records) {
				for (const field of Object.keys(record.cells)) fields.add(field);
				if (record.fragment?.field === "career") {
					expect(record.fragment.index).toBe(parts.length);
					parts.push(record.cell_fragment ?? "");
				}
			}
			cursor = r.next_cursor;
		} while (cursor && pages < 100);
		expect(pages).toBeGreaterThan(1);
		expect(cursor).toBeNull();
		expect(JSON.parse(parts.join("")).value).toBe(long);
		expect(fields.has("height")).toBe(true);
		expect(fields.has("election_2025")).toBe(true);
	});
	it("excludes only supplied delivered IDs and refuses missing conversation context", async () => {
		const f = await fixture();
		expect(
			await f.engine.execute("query_records", {
				...queryArgs,
				exclude_previously_delivered: true,
			}),
		).toMatchObject({ reason: "missing_context" });
		const r = await f.engine.execute("query_records", queryArgs);
		ok(r);
		const f2 = await fixture(artificialMembers, undefined, undefined, [
			r.records[0].id,
		]);
		const excluded = await f2.engine.execute("query_records", {
			...queryArgs,
			exclude_previously_delivered: true,
		});
		ok(excluded);
		expect(excluded.matched_count).toBe(4);
	});
	it("refuses snapshot loss, expiration and abort without refreshing the source", async () => {
		let now = NOW;
		const f = await fixture(artificialMembers, undefined, () => now);
		f.data.clear();
		const missing = await SheetSearchEngine.open(f.repository, SOURCE, f.ref, {
			now: () => now,
		});
		expect(missing).toMatchObject({ reason: "source_error" });
		now = f.ref.expiresAt;
		expect(await f.engine.execute("query_records", queryArgs)).toMatchObject({
			reason: "snapshot_expired",
		});
		const b = await fixture();
		const controller = new AbortController();
		const open = await SheetSearchEngine.open(b.repository, SOURCE, b.ref, {
			now: () => NOW,
			signal: controller.signal,
		});
		if (open.status !== "ready") throw new Error(open.reason);
		controller.abort();
		expect(await open.engine.execute("query_records", queryArgs)).toMatchObject(
			{ reason: "budget_exceeded" },
		);
	});
	it("uses no external API and writes no logs for successful or invalid searches", async () => {
		const { engine } = await fixture();
		const fetch = vi.spyOn(globalThis, "fetch");
		const log = vi.spyOn(console, "log");
		const error = vi.spyOn(console, "error");
		await engine.execute("query_records", queryArgs);
		await engine.execute("query_records", { ...queryArgs, sql: "select *" });
		expect(fetch).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		fetch.mockRestore();
		log.mockRestore();
		error.mockRestore();
	});
	it.each([
		["extra property", { ...queryArgs, extra: true }, "invalid_arguments"],
		["non integer page", { ...queryArgs, page_size: 1.2 }, "invalid_arguments"],
		["empty OR", { ...queryArgs, where: { any: [] } }, "invalid_arguments"],
		[
			"too many branches",
			{
				...queryArgs,
				where: {
					any: Array.from({ length: 9 }, () => ({
						all: [{ field: "height", op: "eq", values: [160] }],
					})),
				},
			},
			"invalid_arguments",
		],
		[
			"number contains",
			{ ...queryArgs, where: where("height", "contains", "16") },
			"invalid_arguments",
		],
		[
			"number string",
			{ ...queryArgs, where: where("height", "eq", "160") },
			"invalid_arguments",
		],
		[
			"invalid date",
			{ ...queryArgs, where: where("birthday", "eq", "2000-02-30") },
			"invalid_arguments",
		],
		[
			"unknown field",
			{ ...queryArgs, fields: ["password"] },
			"invalid_arguments",
		],
		[
			"unavailable field",
			{ ...queryArgs, fields: ["current_group"] },
			"field_unavailable",
		],
		[
			"wrong dataset field",
			{ ...queryArgs, dataset: "reference" },
			"field_unavailable",
		],
		[
			"bad reference date",
			{
				...queryArgs,
				calculation_context: { as_of: "today", target_age: null },
			},
			"invalid_arguments",
		],
		[
			"missing target age",
			{ ...queryArgs, fields: ["days_until_target_age"] },
			"invalid_arguments",
		],
		[
			"extraneous target age",
			{ ...queryArgs, calculation_context: { as_of: null, target_age: 18 } },
			"invalid_arguments",
		],
		["missing sort for top", { ...queryArgs, top_n: 1 }, "invalid_arguments"],
	])("rejects %s", async (_label, args, reason) => {
		const { engine } = await fixture();
		expect(await engine.execute("query_records", args)).toMatchObject({
			status: "error",
			reason,
		});
	});
	it("rejects unknown IDs and conflicting fields/preset", async () => {
		const { engine } = await fixture();
		expect(
			await engine.execute("get_records", { ...getArgs, ids: ["unknown"] }),
		).toMatchObject({ reason: "unknown_id" });
		expect(
			await engine.execute("get_records", {
				...getArgs,
				ids: ["unknown"],
				preset: "overview",
			}),
		).toMatchObject({ reason: "invalid_arguments" });
		expect(
			await engine.execute("search_records", {
				...searchArgs,
				query: "x".repeat(513),
			}),
		).toMatchObject({ reason: "invalid_arguments" });
	});
});

describe("execution limits and set replay", () => {
	it("resolves complete immutable sets and rejects handles from other snapshots", async () => {
		const f = await fixture();
		const result = await f.engine.execute("query_records", {
			...queryArgs,
			page_size: 1,
		});
		ok(result);
		const set = f.engine.readResultSet(result.result_set_id);
		expect(set.status).toBe("ready");
		if (set.status !== "ready") return;
		expect(set.ids).toHaveLength(5);
		set.ids.length = 0;
		expect(f.engine.readResultSet(result.result_set_id)).toMatchObject({
			ids: expect.arrayContaining([result.records[0].id]),
		});
		const reopened = await SheetSearchEngine.open(f.repository, SOURCE, f.ref, {
			now: () => NOW,
		});
		if (reopened.status !== "ready") throw new Error(reopened.reason);
		const replay = await reopened.engine.execute("query_records", {
			...queryArgs,
			page_size: 1,
		});
		ok(replay);
		expect(replay.result_set_id).toBe(result.result_set_id);
		expect(reopened.engine.readResultSet(replay.result_set_id)).toMatchObject({
			status: "ready",
		});
		const other = await fixture([
			{ ...artificialMembers[0], full_name: "別版" },
		]);
		expect(other.engine.readResultSet(result.result_set_id)).toMatchObject({
			reason: "unknown_id",
		});
	});
	it("treats a finite OR as true even when a different branch has unknown data", async () => {
		const { engine } = await fixture();
		const result = await engine.execute("query_records", {
			...queryArgs,
			where: {
				any: [
					{ all: [{ field: "age", op: "eq", values: [20] }] },
					{ all: [{ field: "generation_group", op: "eq", values: ["BEJ48"] }] },
				],
			},
		});
		ok(result);
		expect(result.matched_count).toBe(2);
		expect(result.unknown_count).toBe(2);
	});
	it("rejects oversized arguments and explicit unsupported datasets", async () => {
		const { engine } = await fixture();
		expect(
			await engine.execute("query_records", {
				...queryArgs,
				cursor: "x".repeat(65536),
			}),
		).toMatchObject({ reason: "invalid_arguments" });
		expect(
			await engine.execute("query_records", {
				...queryArgs,
				dataset: "performances",
			}),
		).toMatchObject({ reason: "invalid_arguments" });
	});
	it("rejects a query projection over the result budget and allows explicit long-field retrieval", async () => {
		const { engine } = await fixture([
			{ ...artificialMembers[0], career: "長い根拠".repeat(15000) },
		]);
		expect(
			await engine.execute("query_records", {
				...queryArgs,
				fields: ["career"],
			}),
		).toMatchObject({ reason: "budget_exceeded" });
	});
});
