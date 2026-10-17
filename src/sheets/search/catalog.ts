import { SHEET_COLUMN_CATALOG } from "../columnCatalog";
import {
	type Dataset,
	DERIVED_FIELDS,
	type Field,
	type FieldType,
	type Operator,
} from "./types";

export const SEARCH_NORMALIZATION_VERSION = 1;
const numbers = new Set<Field>([
	"age",
	"height",
	"debut_age",
	"pocket_followers",
	"latest_rank",
	"generation_number",
	"age_at",
	"tenure_completed_years",
	"tenure_ordinal_year",
	"days_until_birthday",
	"days_until_target_age",
]);
const sets = new Set<Field>([
	"primary_affiliation",
	"secondary_affiliation",
	"community_nicknames",
	"official_nickname",
	"state_flags",
]);
const dates = new Set<Field>(["birthday", "debut_date"]);
const references = new Set<Field>(["reference_title", "reference_body"]);
const unavailable = new Set<Field>(["current_group", "current_team"]);
export function fieldType(field: Field): FieldType {
	if (field === "election_history") return "history";
	if (numbers.has(field) || field.startsWith("election_")) return "number";
	if (dates.has(field)) return "date";
	return sets.has(field) ? "set" : "text";
}
export function operators(field: Field): Operator[] {
	const common: Operator[] = ["is_missing", "is_present"];
	const type = fieldType(field);
	if (type === "history") return common;
	common.push("eq", "in", "not_in");
	return type === "number" || type === "date"
		? [...common, "lt", "lte", "gt", "gte"]
		: [...common, "contains", "starts_with"];
}
export const SEARCH_FIELDS = [
	...SHEET_COLUMN_CATALOG.filter(
		(c) => c.key !== "sid" && c.key !== "sort_tid",
	).map((c) => c.key as Field),
	...DERIVED_FIELDS,
];
export function available(field: Field, dataset: Dataset): boolean {
	return (
		!unavailable.has(field) &&
		(dataset === "reference" ? references.has(field) : !references.has(field))
	);
}
export function searchCatalog(dataset: Dataset) {
	return SEARCH_FIELDS.map((field) => ({
		field,
		type: fieldType(field),
		operators: operators(field),
		available: available(field, dataset),
		unavailable_reason: available(field, dataset)
			? null
			: unavailable.has(field)
				? "verified_current_affiliation_dictionary_not_integrated"
				: "not_in_dataset",
		source: references.has(field)
			? "description!A1"
			: (SHEET_COLUMN_CATALOG.find((c) => c.key === field)?.description ??
				"derived_from_snapshot"),
	}));
}
export const PRESETS: Record<string, Field[]> = {
	overview: [
		"full_name",
		"pinyin",
		"initials",
		"community_nicknames",
		"primary_affiliation",
		"secondary_affiliation",
		"age",
		"birthday",
		"debut_date",
		"generation",
		"birth_province",
		"birth_city",
		"skills",
		"hobbies",
		"official_nickname",
		"official_english_name",
		"career",
	],
	support_colors: [
		"support_color_1",
		"support_color_1_detail",
		"support_color_2",
		"support_color_2_detail",
	],
	election_history: ["election_history"],
};
