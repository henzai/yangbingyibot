import type { SheetColumnKey } from "../columnCatalog";
import type { CellState } from "../memberRecords";

export type Dataset = "members" | "reference";
export const DERIVED_FIELDS = [
	"member_id",
	"generation_group",
	"generation_number",
	"current_group",
	"current_team",
	"state_flags",
	"election_history",
	"age_at",
	"tenure_completed_years",
	"tenure_ordinal_year",
	"days_until_birthday",
	"days_until_target_age",
	"reference_title",
	"reference_body",
] as const;
export type Field =
	| Exclude<SheetColumnKey, "sid" | "sort_tid">
	| (typeof DERIVED_FIELDS)[number];
export type FieldType = "text" | "set" | "number" | "date" | "history";
export type Operator =
	| "eq"
	| "in"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "contains"
	| "starts_with"
	| "not_in"
	| "is_missing"
	| "is_present";
export type Scalar = string | number | boolean;
export type Atom = { field: Field; op: Operator; values: Scalar[] };
export type Where = { any: { all: Atom[] }[] } | null;
export type CalculationContext = {
	as_of: string | null;
	target_age: number | null;
};
export type Sort = { field: Field; direction: "asc" | "desc" };
export type Metric = {
	op: "count" | "min" | "max" | "mean" | "best_rank" | "difference";
	field: Field | null;
	operands: { left_id: string; right_id: string } | null;
};
export type SearchArgs = {
	dataset: Dataset;
	query: string;
	mode: "identity" | "text";
	search_fields: Field[] | null;
	where: Where;
	page_size: number;
	cursor: string | null;
};
export type GetArgs = {
	dataset: Dataset;
	ids: string[];
	fields: Field[] | null;
	preset:
		| "overview"
		| "all_available"
		| "support_colors"
		| "election_history"
		| null;
	calculation_context: CalculationContext;
	cursor: string | null;
};
export type QueryArgs = {
	dataset: Dataset;
	where: Where;
	fields: Field[];
	sort: Sort[];
	exclude_previously_delivered: boolean;
	top_n: number | null;
	calculation_context: CalculationContext;
	page_size: number;
	cursor: string | null;
};
export type AggregateArgs = {
	dataset: Dataset;
	where: Where;
	metrics: Metric[];
	group_by: Field[];
	sort_metric_index: number | null;
	sort_direction: "asc" | "desc";
	top_n: number | null;
	calculation_context: CalculationContext;
	page_size: number;
	cursor: string | null;
};
export type ToolName =
	| "search_records"
	| "get_records"
	| "query_records"
	| "aggregate_records";
export type ToolArgs = SearchArgs | GetArgs | QueryArgs | AggregateArgs;
export type Rank = { year: number; rank: number };
export type TypedCell = {
	field_state: CellState | "invalid" | "unavailable";
	raw: string | null;
	value: string | number | string[] | Rank[] | null;
	unit?: string;
	precision?: "day" | "month" | "year" | "month_day";
	reason?: string;
	source_fields: string[];
	components?: Record<string, TypedCell>;
};
export type SearchRecord = {
	id: string;
	matches?: {
		field: Field;
		text: string;
		method: string;
		ambiguous_short_form?: boolean;
	}[];
	source_row: number;
	cells: Partial<Record<Field, TypedCell>>;
	cell_fragment?: string;
	fragment?: {
		field: Field;
		index: number;
		count: number;
		encoding: "typed_cell_json";
	};
};
export type SearchFailure = {
	status: "error";
	reason:
		| "invalid_arguments"
		| "field_unavailable"
		| "missing_context"
		| "unknown_id"
		| "snapshot_expired"
		| "source_error"
		| "budget_exceeded"
		| "invalid_cursor";
	snapshot_id: string;
};
export type MetricResult = {
	op: Metric["op"];
	field: Field | null;
	value: number | string | null;
	population_count: number;
	valid_count: number;
	unknown_count: number;
	missing_by_state: Record<string, number>;
	unit?: string;
	tied_ids?: string[];
	tied_count?: number;
	tied_set_id?: string;
	rank_match_count?: number;
	rank_set_id?: string;
	ranks?: { id: string; year: number; rank: number }[];
};
export type AggregateGroup = {
	key: string;
	group: Partial<Record<Field, TypedCell>>;
	population_count: number;
	metrics: MetricResult[];
};
export type SearchResult = {
	status: "ok";
	snapshot_id: string;
	schema_version: number;
	catalog_version: number;
	normalization_version: number;
	source_captured_at: number;
	calculation_context: CalculationContext;
	applied_filters: Where;
	matched_count: number;
	selected_count: number;
	returned_count: number;
	unknown_count: number;
	coverage: "exact_set" | "lexical_matches" | "candidate_only";
	result_set_id: string;
	next_cursor: string | null;
	truncated: boolean;
	records: SearchRecord[];
	groups: AggregateGroup[];
	ranking_unknown_count?: number;
	group_count?: number;
	selected_group_count?: number;
	unknown_group_count?: number;
	ranking_unknown_group_count?: number;
	matches?: {
		id: string;
		field: Field;
		text: string;
		method: string;
		ambiguous_short_form?: boolean;
	}[];
};
