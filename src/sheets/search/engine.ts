import type { SpreadsheetConfig } from "../../config";
import { type MemberRecord, readMemberRecords } from "../memberRecords";
import type {
	SheetSnapshot,
	SheetSnapshotRef,
	SheetSnapshotRepository,
} from "../snapshot";
import { sha256 } from "../sourceFingerprint";
import { calculateMetric, type RowAccess } from "./aggregates";
import {
	available,
	fieldType,
	PRESETS,
	SEARCH_FIELDS,
	SEARCH_NORMALIZATION_VERSION,
	searchCatalog,
} from "./catalog";
import {
	CALCULATED_FIELDS,
	normalize,
	readCell,
	tokyoDay,
	validDay,
} from "./cells";
import { compareCell, testWhere, validateAtom } from "./conditions";
import { findIdentityCandidates } from "./identityCandidates";
import { buildIdentityIndex, type IdentityIndex } from "./identityIndex";
import type {
	AggregateArgs,
	AggregateGroup,
	CalculationContext,
	Dataset,
	Field,
	GetArgs,
	QueryArgs,
	SearchArgs,
	SearchFailure,
	SearchRecord,
	SearchResult,
	ToolArgs,
	ToolName,
	TypedCell,
	Where,
} from "./types";
import { validArguments } from "./validation";

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_SCAN_RECORDS = 10000;
export type SearchOptions = {
	/** Injected once at question start. Reuse on Workflow replay. */
	questionDate?: string;
	deliveredIds?: readonly string[];
	signal?: AbortSignal;
	now?: () => number;
};
class SearchError extends Error {
	constructor(readonly reason: SearchFailure["reason"]) {
		super(reason);
	}
}
function fail(reason: SearchFailure["reason"]): never {
	throw new SearchError(reason);
}
function bytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
type Row = { id: string; sourceRow: number; member: MemberRecord | null };

/** Request-local, read-only executor. No Sheets refresh, model call or logging. */
export class SheetSearchEngine {
	private readonly resultSets = new Map<string, readonly string[]>();
	private setBytes = 0;
	private readonly records: MemberRecord[];
	private readonly index: IdentityIndex;
	private readonly ref: SheetSnapshotRef;
	private readonly options: SearchOptions;
	private readonly questionDate: string;
	private readonly now: () => number;
	private constructor(
		private readonly snapshot: SheetSnapshot,
		ref: SheetSnapshotRef,
		options: SearchOptions,
	) {
		this.ref = { ...ref };
		this.options = {
			...options,
			deliveredIds: options.deliveredIds
				? [...options.deliveredIds]
				: undefined,
		};
		this.now = options.now ?? Date.now;
		this.questionDate = options.questionDate ?? tokyoDay(this.now());
		if (!validDay(this.questionDate)) fail("invalid_arguments");
		const result = readMemberRecords(
			snapshot.structuredSheet,
			snapshot.sourceFingerprint,
		);
		if (result.status !== "ready") fail("source_error");
		this.records = result.records;
		this.index = buildIdentityIndex(this.records);
	}
	static async open(
		repository: SheetSnapshotRepository,
		source: SpreadsheetConfig,
		ref: SheetSnapshotRef,
		options: SearchOptions = {},
	): Promise<{ status: "ready"; engine: SheetSearchEngine } | SearchFailure> {
		const reference = { ...ref };
		const loaded = await repository.get(source, reference);
		if (loaded.status !== "ready")
			return {
				status: "error",
				reason:
					loaded.reason === "expired" ? "snapshot_expired" : "source_error",
				snapshot_id: reference.snapshotId,
			};
		try {
			return {
				status: "ready",
				engine: new SheetSearchEngine(loaded.snapshot, reference, options),
			};
		} catch (error) {
			return {
				status: "error",
				reason: error instanceof SearchError ? error.reason : "source_error",
				snapshot_id: reference.snapshotId,
			};
		}
	}
	catalog(dataset: Dataset) {
		return searchCatalog(dataset);
	}
	/** Raw pinned rules for E/F prompt assembly; ordinary cells remain tool data. */
	get description(): string {
		return this.snapshot.description;
	}
	/** Internal D renderer boundary. Handles never authorize a different snapshot. */
	readResultSet(
		handle: string,
	): { status: "ready"; snapshot_id: string; ids: string[] } | SearchFailure {
		try {
			this.guard();
			const ids = this.resultSets.get(handle);
			if (!ids) fail("unknown_id");
			return {
				status: "ready",
				snapshot_id: this.ref.snapshotId,
				ids: [...ids],
			};
		} catch (error) {
			return {
				status: "error",
				reason: error instanceof SearchError ? error.reason : "source_error",
				snapshot_id: this.ref.snapshotId,
			};
		}
	}
	private async registerSet(ids: string[], salt = "ids"): Promise<string> {
		const handle = await sha256(canonical([this.ref.snapshotId, salt, ids]));
		if (!this.resultSets.has(handle)) {
			const size = bytes(ids);
			if (this.setBytes + size > 2 * 1024 * 1024) fail("budget_exceeded");
			this.setBytes += size;
			this.resultSets.set(handle, [...ids]);
		}
		return handle;
	}

	private guard() {
		if (this.now() >= this.ref.expiresAt) fail("snapshot_expired");
		if (this.options.signal?.aborted) fail("budget_exceeded");
		if (this.records.length > MAX_SCAN_RECORDS) fail("budget_exceeded");
	}
	async execute(
		name: ToolName,
		input: unknown,
	): Promise<SearchResult | SearchFailure> {
		try {
			this.guard();
			if (bytes(input) > MAX_ARGUMENT_BYTES || !validArguments(name, input))
				fail("invalid_arguments");
			// Detach before awaits; caller changes cannot alter a pending operation/cursor.
			const args = JSON.parse(JSON.stringify(input)) as ToolArgs;
			this.validate(name, args);
			let result: SearchResult;
			if (name === "search_records")
				result = await this.search(args as SearchArgs);
			else if (name === "get_records") result = await this.get(args as GetArgs);
			else if (name === "query_records")
				result = await this.query(args as QueryArgs);
			else result = await this.aggregate(args as AggregateArgs);
			this.guard();
			if (bytes(result) > MAX_RESULT_BYTES) fail("budget_exceeded");
			return result;
		} catch (error) {
			return {
				status: "error",
				reason:
					error instanceof SearchError ? error.reason : "invalid_arguments",
				snapshot_id: this.ref.snapshotId,
			};
		}
	}
	private fields(name: ToolName, args: ToolArgs): Field[] {
		const fields: Field[] = [];
		if ("where" in args && args.where)
			for (const branch of args.where.any)
				fields.push(...branch.all.map((atom) => atom.field));
		if (name === "search_records")
			fields.push(...((args as SearchArgs).search_fields ?? []));
		if (name === "get_records") fields.push(...this.getFields(args as GetArgs));
		if (name === "query_records") {
			const a = args as QueryArgs;
			fields.push(...a.fields, ...a.sort.map((s) => s.field));
		}
		if (name === "aggregate_records") {
			const a = args as AggregateArgs;
			fields.push(
				...a.group_by,
				...a.metrics.flatMap((m) => (m.field ? [m.field] : [])),
			);
		}
		return [...new Set(fields)];
	}
	private getFields(args: GetArgs): Field[] {
		if ((args.fields === null) === (args.preset === null))
			fail("invalid_arguments");
		if (args.fields) return args.fields;
		if (args.preset === "all_available")
			return SEARCH_FIELDS.filter(
				(field) =>
					available(field, args.dataset) && field !== "days_until_target_age",
			);
		if (args.dataset === "reference") fail("invalid_arguments");
		return PRESETS[args.preset as string];
	}
	private context(args: ToolArgs): CalculationContext {
		return "calculation_context" in args
			? {
					...args.calculation_context,
					as_of: args.calculation_context.as_of ?? this.questionDate,
				}
			: { as_of: this.questionDate, target_age: null };
	}
	private validate(name: ToolName, args: ToolArgs) {
		const fields = this.fields(name, args);
		if (fields.some((field) => !available(field, args.dataset)))
			fail("field_unavailable");
		if (
			"where" in args &&
			args.where?.any.some((branch) =>
				branch.all.some((atom) => !validateAtom(atom)),
			)
		)
			fail("invalid_arguments");
		const context = this.context(args);
		if (!validDay(context.as_of as string)) fail("invalid_arguments");
		if (
			fields.includes("days_until_target_age") !==
			(context.target_age !== null)
		)
			fail("invalid_arguments");
		if (name === "search_records") {
			const a = args as SearchArgs;
			if (!normalize(a.query)) fail("invalid_arguments");
			const searched =
				a.search_fields ?? this.defaultSearchFields(a.dataset, a.mode);
			if (
				a.mode === "identity" &&
				(a.dataset !== "members" ||
					searched.some(
						(field) => !Object.hasOwn(this.identityFields(), field),
					))
			)
				fail("invalid_arguments");
			if (searched.some((field) => !["text", "set"].includes(fieldType(field))))
				fail("invalid_arguments");
		}
		if (name === "get_records") {
			const a = args as GetArgs;
			if (
				new Set(a.ids).size !== a.ids.length ||
				(a.fields && new Set(a.fields).size !== a.fields.length)
			)
				fail("invalid_arguments");
		}
		if (name === "query_records") {
			const a = args as QueryArgs;
			if (a.top_n !== null && !a.sort.length) fail("invalid_arguments");
			if (
				a.sort.some(
					(s) => !["text", "number", "date"].includes(fieldType(s.field)),
				)
			)
				fail("invalid_arguments");
			if (a.exclude_previously_delivered && !this.options.deliveredIds)
				fail("missing_context");
		}
		if (name === "aggregate_records") {
			const a = args as AggregateArgs;
			if (
				(a.sort_metric_index !== null &&
					a.sort_metric_index >= a.metrics.length) ||
				(a.top_n !== null && a.sort_metric_index === null)
			)
				fail("invalid_arguments");
			for (const m of a.metrics) {
				if (m.op === "count") {
					if (m.field !== null || m.operands !== null)
						fail("invalid_arguments");
					continue;
				}
				if (!m.field) fail("invalid_arguments");
				const type = fieldType(m.field);
				if (m.op === "best_rank") {
					if (m.field !== "election_history") fail("invalid_arguments");
				} else if (type !== "number" && (type !== "date" || m.op === "mean"))
					fail("invalid_arguments");
				if (
					(m.op === "difference") !== (m.operands !== null) ||
					(m.op === "difference" && a.group_by.length)
				)
					fail("invalid_arguments");
			}
			if (
				new Set(a.group_by).size !== a.group_by.length ||
				a.group_by.some((field) => fieldType(field) === "history")
			)
				fail("invalid_arguments");
		}
		// Search where cannot carry hidden derived-date settings.
		if (
			name === "search_records" &&
			fields.some((f) => CALCULATED_FIELDS.includes(f))
		)
			fail("invalid_arguments");
	}
	private identityFields() {
		return {
			full_name: true,
			pinyin: true,
			initials: true,
			community_nicknames: true,
			official_nickname: true,
			official_english_name: true,
		};
	}
	private defaultSearchFields(
		dataset: Dataset,
		mode: SearchArgs["mode"],
	): Field[] {
		if (dataset === "reference") return ["reference_title", "reference_body"];
		return mode === "identity"
			? (Object.keys(this.identityFields()) as Field[])
			: SEARCH_FIELDS.filter(
					(f) =>
						available(f, dataset) && ["text", "set"].includes(fieldType(f)),
				);
	}
	private rows(dataset: Dataset): Row[] {
		return dataset === "reference"
			? [
					{
						id: `reference:${this.snapshot.sourceFingerprint}:description`,
						sourceRow: 1,
						member: null,
					},
				]
			: this.records.map((member) => ({
					id: member.id,
					sourceRow: member.sourceRow,
					member,
				}));
	}
	private cell(
		row: Row,
		dataset: Dataset,
		field: Field,
		context: CalculationContext,
	) {
		return readCell(row.member, dataset, field, this.snapshot, context);
	}
	private filtered(
		dataset: Dataset,
		where: Where,
		context: CalculationContext,
	): { rows: Row[]; unknown: number } {
		const rows: Row[] = [];
		let unknown = 0;
		for (const row of this.rows(dataset)) {
			const matches = testWhere(where, (field) =>
				this.cell(row, dataset, field, context),
			);
			if (matches === true) rows.push(row);
			if (matches === "unknown") unknown++;
		}
		return { rows, unknown };
	}
	private project(
		row: Row,
		dataset: Dataset,
		fields: Field[],
		context: CalculationContext,
	): SearchRecord {
		return {
			id: row.id,
			source_row: row.sourceRow,
			cells: Object.fromEntries(
				fields.map((field) => [field, this.cell(row, dataset, field, context)]),
			),
		};
	}
	private async base(
		args: ToolArgs,
		matched: number,
		ids: string[],
		unknown: number,
		coverage: SearchResult["coverage"],
		salt: string,
	): Promise<SearchResult> {
		return {
			status: "ok",
			snapshot_id: this.ref.snapshotId,
			schema_version: this.snapshot.structuredSheet.schemaVersion,
			catalog_version: this.snapshot.structuredSheet.catalogVersion,
			normalization_version: SEARCH_NORMALIZATION_VERSION,
			source_captured_at: this.snapshot.capturedAt,
			calculation_context: this.context(args),
			applied_filters: "where" in args ? args.where : null,
			matched_count: matched,
			selected_count: ids.length,
			returned_count: 0,
			unknown_count: unknown,
			coverage,
			result_set_id: await this.registerSet(
				ids,
				canonical([salt, { ...args, cursor: null }, this.context(args)]),
			),
			next_cursor: null,
			truncated: false,
			records: [],
			groups: [],
		};
	}
	private async page<T extends SearchRecord | AggregateGroup>(
		name: ToolName,
		args: ToolArgs,
		items: T[],
		base: SearchResult,
		pageSize: number,
		kind: "records" | "groups",
	): Promise<SearchResult> {
		const { cursor, ...query } = args;
		const binding = await sha256(
			canonical([
				this.ref.snapshotId,
				SEARCH_NORMALIZATION_VERSION,
				name,
				query,
				this.context(args),
				this.options.deliveredIds ?? null,
			]),
		);
		let offset = 0;
		if (cursor !== null) {
			try {
				const parsed = JSON.parse(cursor);
				if (
					!Array.isArray(parsed) ||
					parsed.length !== 3 ||
					parsed[0] !== binding ||
					!Number.isSafeInteger(parsed[1]) ||
					parsed[1] <= 0 ||
					parsed[1] >= items.length ||
					parsed[2] !== (await sha256(canonical([binding, parsed[1]])))
				)
					fail("invalid_cursor");
				offset = parsed[1];
			} catch {
				fail("invalid_cursor");
			}
		}
		const selected: T[] = [];
		const result = { ...base };
		const end = Math.min(items.length, offset + pageSize);
		for (let index = offset; index < end; index++) {
			selected.push(items[index]);
			// Reserve enough bytes for cursor + envelope before admitting an item.
			const probe = {
				...result,
				[kind]: selected,
				next_cursor: "x".repeat(256),
			};
			if (bytes(probe) > MAX_RESULT_BYTES) {
				selected.pop();
				break;
			}
		}
		if (offset < items.length && !selected.length) fail("budget_exceeded");
		const next = offset + selected.length;
		if (kind === "records") {
			result.records = selected as SearchRecord[];
			result.returned_count = new Set(result.records.map((row) => row.id)).size;
		} else {
			result.groups = selected as AggregateGroup[];
			result.returned_count = selected.length;
		}
		result.truncated = next < items.length;
		result.next_cursor = result.truncated
			? JSON.stringify([
					binding,
					next,
					await sha256(canonical([binding, next])),
				])
			: null;
		return result;
	}
	private async search(args: SearchArgs): Promise<SearchResult> {
		const context = this.context(args);
		const { rows, unknown } = this.filtered(args.dataset, args.where, context);
		const fields =
			args.search_fields ?? this.defaultSearchFields(args.dataset, args.mode);
		let matches: NonNullable<SearchResult["matches"]>;
		if (args.mode === "identity") {
			const allowed = new Set(rows.map((r) => r.id));
			const index = {
				terms: this.index.terms.filter(
					(term) => allowed.has(term.id) && fields.includes(term.source),
				),
			};
			matches = findIdentityCandidates(args.query, index).candidates.map(
				(c) => ({
					id: c.id,
					field: c.source,
					text: c.matchedText,
					method: c.method,
					ambiguous_short_form: c.ambiguousShortForm,
				}),
			);
		} else {
			const query = normalize(args.query);
			matches = rows.flatMap((row) =>
				fields.flatMap((field) => {
					const cell = this.cell(row, args.dataset, field, context);
					if (cell.field_state !== "value") return [];
					const values = Array.isArray(cell.value) ? cell.value : [cell.value];
					return values.some(
						(value) =>
							typeof value === "string" && normalize(value).includes(query),
					)
						? [{ id: row.id, field, text: args.query, method: "literal" }]
						: [];
				}),
			);
		}
		const byId = new Map(matches.map((match) => [match.id, true]));
		const selected = rows
			.filter((row) => byId.has(row.id))
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const outputFields: Field[] =
			args.dataset === "members"
				? ["full_name", "pinyin", "community_nicknames"]
				: ["reference_title"];
		const base = await this.base(
			args,
			selected.length,
			selected.map((r) => r.id),
			unknown,
			args.mode === "identity" ? "candidate_only" : "lexical_matches",
			"search",
		);
		const result = await this.page(
			"search_records",
			args,
			selected.map((row) => ({
				...this.project(row, args.dataset, outputFields, context),
				matches: matches
					.filter((match) => match.id === row.id)
					.map(({ id: _id, ...match }) => match),
			})),
			base,
			args.page_size,
			"records",
		);
		return result;
	}
	private async get(args: GetArgs): Promise<SearchResult> {
		const byId = new Map(this.rows(args.dataset).map((row) => [row.id, row]));
		const rows = args.ids.map((id) => {
			const row = byId.get(id);
			if (!row) fail("unknown_id");
			return row;
		});
		const context = this.context(args);
		const items: SearchRecord[] = [];
		for (const row of rows)
			for (const field of this.getFields(args)) {
				const cell = this.cell(row, args.dataset, field, context);
				// Long text is losslessly paged, including raw and normalized value. The
				// fragment metadata must be reassembled before claiming a complete record.
				const encoded = [...JSON.stringify(cell)];
				const count = Math.ceil(encoded.length / 2000);
				if (count <= 1)
					items.push({
						id: row.id,
						source_row: row.sourceRow,
						cells: { [field]: cell },
					});
				else
					for (let index = 0; index < count; index++)
						items.push({
							id: row.id,
							source_row: row.sourceRow,
							cells: {},
							cell_fragment: encoded
								.slice(index * 2000, (index + 1) * 2000)
								.join(""),
							fragment: { field, index, count, encoding: "typed_cell_json" },
						});
			}
		const base = await this.base(
			args,
			rows.length,
			rows.map((row) => row.id),
			0,
			"exact_set",
			canonical(["get", args.ids]),
		);
		return this.page("get_records", args, items, base, 100, "records");
	}
	private async query(args: QueryArgs): Promise<SearchResult> {
		const context = this.context(args);
		const filtered = this.filtered(args.dataset, args.where, context);
		const excluded = args.exclude_previously_delivered
			? new Set(this.options.deliveredIds)
			: new Set<string>();
		const rows = filtered.rows.filter((row) => !excluded.has(row.id));
		const compare = (a: Row, b: Row) => {
			for (const sort of args.sort) {
				const value = compareCell(
					this.cell(a, args.dataset, sort.field, context),
					this.cell(b, args.dataset, sort.field, context),
					sort.direction,
				);
				if (value) return value;
			}
			return 0;
		};
		rows.sort(
			(a, b) => compare(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		const ranked =
			args.top_n === null
				? rows
				: rows.filter((row) =>
						args.sort.every((sort) => {
							const cell = this.cell(row, args.dataset, sort.field, context);
							return (
								cell.field_state === "value" &&
								(!cell.precision || cell.precision === "day")
							);
						}),
					);
		let selected = ranked;
		if (args.top_n !== null && ranked.length > args.top_n) {
			const boundary = ranked[args.top_n - 1];
			selected = ranked.filter(
				(row, index) =>
					index < (args.top_n ?? 0) || compare(row, boundary) === 0,
			);
		}
		const rankingUnknown =
			args.top_n === null
				? 0
				: rows.filter((row) =>
						args.sort.some((sort) => {
							const cell = this.cell(row, args.dataset, sort.field, context);
							return (
								cell.field_state !== "value" ||
								(cell.precision && cell.precision !== "day")
							);
						}),
					).length;
		const base = await this.base(
			args,
			rows.length,
			selected.map((row) => row.id),
			filtered.unknown,
			"exact_set",
			canonical([
				"query",
				args.where,
				args.sort,
				args.top_n,
				args.exclude_previously_delivered,
			]),
		);
		base.ranking_unknown_count = rankingUnknown;
		return this.page(
			"query_records",
			args,
			selected.map((row) =>
				this.project(row, args.dataset, args.fields, context),
			),
			base,
			args.page_size,
			"records",
		);
	}
	private async aggregate(args: AggregateArgs): Promise<SearchResult> {
		const context = this.context(args);
		const { rows, unknown } = this.filtered(args.dataset, args.where, context);
		for (const metric of args.metrics)
			if (
				metric.operands &&
				(!rows.some((row) => row.id === metric.operands?.left_id) ||
					!rows.some((row) => row.id === metric.operands?.right_id))
			)
				fail("unknown_id");
		const buckets = new Map<
			string,
			{ group: Partial<Record<Field, TypedCell>>; rows: Map<string, Row> }
		>();
		let unknownGroups = 0;
		if (!args.group_by.length)
			buckets.set("[]", { group: {}, rows: new Map() });
		for (const row of rows) {
			let variants: Partial<Record<Field, TypedCell>>[] = [{}];
			let unavailable = false;
			for (const field of args.group_by) {
				const cell = this.cell(row, args.dataset, field, context);
				if (cell.field_state !== "value") {
					unavailable = true;
					break;
				}
				const values = Array.isArray(cell.value) ? cell.value : [cell.value];
				if (!values.length) {
					unavailable = true;
					break;
				}
				variants = variants.flatMap((group) =>
					values.map((value) => ({ ...group, [field]: { ...cell, value } })),
				);
				if (variants.length > 100) fail("budget_exceeded");
			}
			if (unavailable) {
				unknownGroups++;
				continue;
			}
			for (const group of variants) {
				const key = canonical(
					args.group_by.map((field) => {
						const cell = group[field];
						return [
							field,
							cell?.precision,
							typeof cell?.value === "string"
								? normalize(cell.value)
								: cell?.value,
						];
					}),
				);
				let bucket = buckets.get(key);
				if (!bucket) {
					bucket = { group, rows: new Map() };
					buckets.set(key, bucket);
				}
				bucket.rows.set(row.id, row);
			}
		}
		const groups: AggregateGroup[] = [];
		for (const [key, bucket] of buckets) {
			const access: RowAccess[] = [...bucket.rows.values()].map((row) => ({
				id: row.id,
				cell: (field) => this.cell(row, args.dataset, field, context),
			}));
			groups.push({
				key,
				group: bucket.group,
				population_count: bucket.rows.size,
				metrics: await Promise.all(
					args.metrics.map((metric) =>
						calculateMetric(access, metric, (ids) => this.registerSet(ids)),
					),
				),
			});
		}
		const compare = (a: AggregateGroup, b: AggregateGroup) => {
			if (args.sort_metric_index === null) return 0;
			const left = a.metrics[args.sort_metric_index].value,
				right = b.metrics[args.sort_metric_index].value;
			if (left === null || right === null)
				return left === right ? 0 : left === null ? 1 : -1;
			return (
				(left < right ? -1 : left > right ? 1 : 0) *
				(args.sort_direction === "asc" ? 1 : -1)
			);
		};
		groups.sort(
			(a, b) => compare(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
		);
		const rankedGroups =
			args.top_n === null
				? groups
				: groups.filter(
						(group) =>
							group.metrics[args.sort_metric_index as number].value !== null,
					);
		const selected =
			args.top_n !== null && rankedGroups.length > args.top_n
				? rankedGroups.filter(
						(group, index) =>
							index < (args.top_n ?? 0) ||
							compare(group, rankedGroups[(args.top_n ?? 0) - 1]) === 0,
					)
				: rankedGroups;
		const base = await this.base(
			args,
			rows.length,
			rows.map((row) => row.id),
			unknown,
			"exact_set",
			canonical(["aggregate", selected.map((group) => group.key)]),
		);
		base.group_count = groups.length;
		base.selected_group_count = selected.length;
		base.unknown_group_count = unknownGroups;
		base.ranking_unknown_group_count = groups.length - rankedGroups.length;
		return this.page(
			"aggregate_records",
			args,
			selected,
			base,
			args.page_size,
			"groups",
		);
	}
}
