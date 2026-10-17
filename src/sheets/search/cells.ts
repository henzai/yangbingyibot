import { ELECTION_COLUMN_CATALOG, type SheetColumnKey } from "../columnCatalog";
import { cellState, type MemberRecord } from "../memberRecords";
import type { SheetSnapshot } from "../snapshot";
import { available, fieldType } from "./catalog";
import { normalizeIdentityText } from "./identityIndex";
import type {
	CalculationContext,
	Dataset,
	Field,
	Rank,
	TypedCell,
} from "./types";

export const splitValues = (raw: string): string[] => [
	...new Set(
		raw
			.split(/<br\s*\/?>|[\r\n/／,，、;；|｜]/iu)
			.map((s) => s.trim())
			.filter(Boolean),
	),
];
export const normalize = normalizeIdentityText;
export function invalid(
	raw: string | null,
	fields: string[],
	reason: string,
): TypedCell {
	return {
		field_state: "invalid",
		raw,
		value: null,
		source_fields: fields,
		reason,
	};
}
export function dateCell(raw: string, field: string): TypedCell {
	const base: TypedCell = {
		raw,
		field_state: cellState(raw),
		value: null,
		source_fields: [field],
	};
	if (base.field_state !== "value") return base;
	const text = raw
		.normalize("NFKC")
		.trim()
		.replace(/^\?{4}[-/]/, "");
	const dayMatch = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
	const monthMatch = /^(\d{4})[-/年](\d{1,2})月?$/.exec(text);
	const yearMatch = /^(\d{4})年?$/.exec(text);
	const monthDayMatch = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
	if (dayMatch) {
		const iso = `${dayMatch[1]}-${dayMatch[2].padStart(2, "0")}-${dayMatch[3].padStart(2, "0")}`;
		if (validDay(iso)) return { ...base, value: iso, precision: "day" };
	} else if (monthMatch) {
		if (+monthMatch[2] >= 1 && +monthMatch[2] <= 12)
			return {
				...base,
				value: `${monthMatch[1]}-${monthMatch[2].padStart(2, "0")}`,
				precision: "month",
			};
	} else if (yearMatch)
		return { ...base, value: yearMatch[1], precision: "year" };
	else if (monthDayMatch) {
		const monthDay = `${monthDayMatch[1].padStart(2, "0")}-${monthDayMatch[2].padStart(2, "0")}`;
		if (validDay(`2000-${monthDay}`))
			return { ...base, value: monthDay, precision: "month_day" };
	}
	return invalid(raw, [field], "invalid_date");
}
export function validDay(iso: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
	const time = Date.parse(`${iso}T00:00:00Z`);
	return (
		Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso
	);
}
export function tokyoDay(timestamp: number): string {
	return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function numeric(raw: string, field: Field): TypedCell {
	const state = cellState(raw);
	const base: TypedCell = {
		raw,
		field_state: state,
		value: null,
		source_fields: [field],
	};
	if (state !== "value") return base;
	let text = raw.normalize("NFKC").trim();
	const unit =
		field === "height"
			? "cm"
			: field === "age" || field === "debut_age"
				? "years"
				: field === "pocket_followers"
					? "followers"
					: "rank";
	text = text.replace(
		field === "height"
			? /\s*cm$/i
			: field === "age" || field === "debut_age"
				? /\s*歳$/
				: /$^/,
		"",
	);
	const tenThousand = field === "pocket_followers" && text.endsWith("万");
	if (tenThousand) text = text.slice(0, -1);
	if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text))
		return invalid(raw, [field], "invalid_number");
	const value = Number(text.replaceAll(",", "")) * (tenThousand ? 10000 : 1);
	const bounds =
		field === "height"
			? [120, 220]
			: field === "age" || field === "debut_age"
				? [0, 120]
				: [0, Number.MAX_SAFE_INTEGER];
	if (
		!Number.isFinite(value) ||
		value < bounds[0] ||
		value > bounds[1] ||
		((field.startsWith("election_") || field === "latest_rank") &&
			(!Number.isInteger(value) || value <= 0))
	)
		return invalid(raw, [field], "invalid_number");
	return {
		...base,
		value,
		unit,
		...(field === "latest_rank" ? { reason: "year_unknown" } : {}),
	};
}
function derived(
	record: MemberRecord,
	field: Field,
	context: CalculationContext,
): TypedCell {
	const asOf = context.as_of as string;
	const source = field.startsWith("tenure_") ? "debut_date" : "birthday";
	const date = dateCell(record.values[source], source);
	if (date.field_state !== "value") return date;
	if (
		date.precision !== "day" &&
		!(field === "days_until_birthday" && date.precision === "month_day")
	)
		return invalid(date.raw, [source], "insufficient_date_precision");
	const value = date.value as string;
	const monthDay = value.slice(-5);
	const year = +asOf.slice(0, 4);
	const birthYear = +value.slice(0, 4);
	if (date.precision === "day" && value > asOf)
		return invalid(date.raw, [source], "outside_valid_interval");
	if (
		(field === "age_at" || field.startsWith("tenure_")) &&
		monthDay === "02-29" &&
		!validDay(`${year}-02-29`)
	)
		return invalid(date.raw, [source], "leap_day_policy_unresolved");

	const years = year - birthYear - Number(asOf.slice(5) < monthDay);
	if (field === "age_at" || field.startsWith("tenure_")) {
		if (value > asOf || (field === "age_at" && years > 120))
			return invalid(date.raw, [source], "outside_valid_interval");
		return {
			raw: date.raw,
			field_state: "value",
			value: years + Number(field === "tenure_ordinal_year"),
			unit: "years",
			source_fields: [source],
		};
	}
	let target: string;
	if (field === "days_until_target_age")
		target = `${birthYear + (context.target_age as number)}-${monthDay}`;
	else {
		target = `${year}-${monthDay}`;
		// Do not silently choose Feb 28 or March 1 for a leap-day birthday.
		if (!validDay(target))
			return invalid(date.raw, [source], "leap_day_policy_unresolved");
		if (target < asOf) target = `${year + 1}-${monthDay}`;
	}
	if (!validDay(target))
		return invalid(date.raw, [source], "leap_day_policy_unresolved");
	return {
		raw: date.raw,
		field_state: "value",
		value: (Date.parse(target) - Date.parse(asOf)) / 86400000,
		unit: "days",
		source_fields: [source],
	};
}
export const CALCULATED_FIELDS: Field[] = [
	"age_at",
	"tenure_completed_years",
	"tenure_ordinal_year",
	"days_until_birthday",
	"days_until_target_age",
];
export function readCell(
	record: MemberRecord | null,
	dataset: Dataset,
	field: Field,
	snapshot: SheetSnapshot,
	context: CalculationContext,
): TypedCell {
	if (!available(field, dataset))
		return {
			raw: null,
			value: null,
			field_state: "unavailable",
			source_fields: [],
			reason: "field_unavailable",
		};
	if (dataset === "reference")
		return {
			raw: field === "reference_title" ? "description" : snapshot.description,
			value: field === "reference_title" ? "description" : snapshot.description,
			field_state: "value",
			source_fields: ["description!A1"],
		};
	if (!record) throw new Error("Missing member record");
	if (CALCULATED_FIELDS.includes(field)) return derived(record, field, context);
	if (field === "member_id")
		return {
			raw: record.id,
			value: record.id,
			field_state: "value",
			source_fields: ["sid"],
		};
	if (field === "generation_group" || field === "generation_number") {
		const value =
			field === "generation_group"
				? record.generation.group
				: record.generation.number;
		return value === null
			? cellState(record.generation.raw) === "value"
				? invalid(record.generation.raw, ["generation"], "unparsed_generation")
				: {
						raw: record.generation.raw,
						value: null,
						field_state: cellState(record.generation.raw),
						source_fields: ["generation"],
					}
			: {
					raw: record.generation.raw,
					value,
					field_state: "value",
					source_fields: ["generation"],
				};
	}
	if (field === "state_flags") {
		const state = record.state.state;
		return state === "conflicting" || state === "unknown"
			? invalid(
					record.values.status,
					["status", "primary_affiliation", "secondary_affiliation"],
					state,
				)
			: {
					raw: record.values.status,
					value: [state],
					field_state: "value",
					source_fields: [
						"status",
						"primary_affiliation",
						"secondary_affiliation",
					],
				};
	}
	if (field === "election_history") {
		const ranks: Rank[] = ELECTION_COLUMN_CATALOG.flatMap((c) => {
			const parsed = numeric(record.values[c.key], c.key);
			return parsed.field_state === "value"
				? [{ year: c.year, rank: parsed.value as number }]
				: [];
		});
		return {
			raw: null,
			value: ranks,
			field_state: ranks.length
				? "value"
				: ELECTION_COLUMN_CATALOG.every((c) =>
							["empty", "placeholder"].includes(
								cellState(record.values[c.key]),
							),
						)
					? "empty"
					: "invalid",
			reason: "positive_year_labeled_ranks_only",
			source_fields: ELECTION_COLUMN_CATALOG.map((c) => c.key),
			components: Object.fromEntries(
				ELECTION_COLUMN_CATALOG.map((c) => [
					c.key,
					numeric(record.values[c.key], c.key),
				]),
			),
		};
	}
	const raw = record.values[field as SheetColumnKey];
	const type = fieldType(field);
	if (type === "number") return numeric(raw, field);
	if (type === "date") return dateCell(raw, field);
	const state = cellState(raw);
	return {
		raw,
		field_state: state,
		value:
			state === "value"
				? type === "set"
					? splitValues(raw)
					: raw.trim()
				: null,
		source_fields: [field],
	};
}
