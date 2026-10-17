import { DISCORD_CONTENT_LIMIT } from "../../discord/formatter";
import type {
	AggregateGroup,
	Field,
	GetArgs,
	SearchRecord,
	SearchResult,
	ToolArgs,
	ToolName,
	TypedCell,
} from "../search/types";
import {
	type AnswerFailure,
	type AnswerLimits,
	type AnswerSource,
	verifyAnswerSelection,
} from "./contracts";

export type Limits = Required<AnswerLimits>;
type Collected = {
	base: SearchResult;
	records: SearchRecord[];
	groups: AggregateGroup[];
};
export class AnswerError extends Error {
	constructor(readonly reason: AnswerFailure["reason"]) {
		super(reason);
	}
}
export function fail(reason: AnswerFailure["reason"]): never {
	throw new AnswerError(reason);
}
export function same(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}
export function unique(ids: readonly string[]) {
	return new Set(ids).size === ids.length;
}
export function requiredCell(
	cells: Partial<Record<Field, TypedCell>>,
	field: Field,
): TypedCell {
	const cell = cells[field];
	if (!cell) fail("invalid_result");
	return cell;
}
function envelope(result: SearchResult) {
	const {
		records: _r,
		groups: _g,
		returned_count: _c,
		next_cursor: _n,
		truncated: _t,
		...rest
	} = result;
	return rest;
}
export function limitsFor(options: AnswerLimits): Limits {
	const limits = {
		maxPages: options.maxPages ?? 100,
		maxResultBytes: options.maxResultBytes ?? 512 * 1024,
		maxChunks: options.maxChunks ?? 8,
		chunkLimit: options.chunkLimit ?? DISCORD_CONTENT_LIMIT,
	};
	if (
		Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
		limits.maxPages > 1000 ||
		limits.maxResultBytes > 2 * 1024 * 1024 ||
		limits.maxChunks > 100 ||
		limits.chunkLimit > DISCORD_CONTENT_LIMIT
	)
		fail("invalid_arguments");
	return limits;
}
export class Collection {
	private pages = 0;
	private bytes = 0;
	constructor(
		readonly source: AnswerSource,
		readonly limits: Limits,
	) {}
	async collect(name: ToolName, args: ToolArgs): Promise<Collected> {
		if (args.cursor !== null) fail("invalid_arguments");
		let cursor: string | null = null;
		let first: SearchResult | undefined;
		const seen = new Set<string>();
		const records: SearchRecord[] = [],
			groups: AggregateGroup[] = [];
		do {
			if (++this.pages > this.limits.maxPages) fail("budget_exceeded");
			const result = await this.source.execute(name, { ...args, cursor });
			if (result.status === "error") fail(result.reason);
			this.bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
			if (this.bytes > this.limits.maxResultBytes) fail("budget_exceeded");
			if (
				result.coverage !== "exact_set" ||
				result.truncated !== (result.next_cursor !== null)
			)
				fail("invalid_result");
			if (first && !same(envelope(first), envelope(result)))
				fail("invalid_result");
			first ??= result;
			if (
				result.records.some((r) => r.fragment || r.cell_fragment !== undefined)
			)
				fail("invalid_result");
			if (name === "aggregate_records") {
				if (
					result.records.length ||
					result.returned_count !== result.groups.length
				)
					fail("invalid_result");
			} else if (
				result.groups.length ||
				result.returned_count !== new Set(result.records.map((r) => r.id)).size
			)
				fail("invalid_result");
			if (
				result.next_cursor !== null &&
				((!result.records.length && !result.groups.length) ||
					seen.has(result.next_cursor))
			)
				fail("invalid_result");
			if (result.next_cursor !== null) seen.add(result.next_cursor);
			records.push(...result.records);
			groups.push(...result.groups);
			cursor = result.next_cursor;
		} while (cursor !== null);
		if (!first) fail("invalid_result");
		return { base: first, records, groups };
	}
	set(base: SearchResult, handle = base.result_set_id): string[] {
		const result = this.source.readResultSet(handle);
		if (result.status === "error") fail(result.reason);
		if (result.snapshot_id !== base.snapshot_id || !unique(result.ids))
			fail("invalid_result");
		return result.ids;
	}
	async members(
		base: SearchResult,
		ids: string[],
		fields: Field[],
	): Promise<SearchRecord[]> {
		const records: SearchRecord[] = [];
		for (let offset = 0; offset < ids.length; offset += 20) {
			const batch = ids.slice(offset, offset + 20);
			const args: GetArgs = {
				dataset: "members",
				ids: batch,
				fields,
				preset: null,
				calculation_context: base.calculation_context,
				cursor: null,
			};
			const result = await this.collect("get_records", args);
			if (
				result.base.snapshot_id !== base.snapshot_id ||
				!same(result.base.calculation_context, base.calculation_context)
			)
				fail("invalid_result");
			checkSelection(this.source, result.base, batch);
			const merged = new Map(
				batch.map((id) => [
					id,
					{ id, source_row: 0, cells: {} } as SearchRecord,
				]),
			);
			for (const row of result.records) {
				const target = merged.get(row.id);
				if (
					!target ||
					(target.source_row && target.source_row !== row.source_row)
				)
					fail("invalid_result");
				target.source_row = row.source_row;
				for (const field of Object.keys(row.cells) as Field[]) {
					if (!fields.includes(field) || target.cells[field])
						fail("invalid_result");
					target.cells[field] = row.cells[field];
				}
			}
			for (const row of merged.values()) {
				if (fields.some((field) => !row.cells[field])) fail("invalid_result");
				records.push(row);
			}
		}
		return records;
	}
}
export function checkSelection(
	source: AnswerSource,
	base: SearchResult,
	ids: string[],
) {
	if (ids.length !== base.selected_count) fail("invalid_result");
	const checked = verifyAnswerSelection(source, base.result_set_id, {
		snapshot_id: base.snapshot_id,
		ids,
		count: base.selected_count,
	});
	if (checked.status === "error") fail(checked.reason);
}
