import { SHEET_COLUMN_CATALOG } from "../columnCatalog";
import type { Field, TypedCell, Where } from "../search/types";

const labels: Partial<Record<Field, string>> = {
	generation_group: "加入グループ",
	current_group: "現在の所属グループ",
	current_team: "現在の所属チーム",
	generation_number: "期",
	state_flags: "状態",
	age_at: "基準日の満年齢",
	tenure_completed_years: "加入満年数",
	tenure_ordinal_year: "加入何年目",
	days_until_birthday: "次の誕生日までの日数",
	days_until_target_age: "指定年齢までの日数",
	election_history: "年別順位",
};
export function label(field: Field): string {
	return (
		SHEET_COLUMN_CATALOG.find((column) => column.key === field)?.label ??
		labels[field] ??
		field
	);
}
/** Plain inline data: prevent mentions, links, markdown and forged line headers. */
export function literal(value: string): string {
	return value
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
		.replace(/([\\`*_~|<>[\]()#])/gu, "\\$1")
		.replace(/@/gu, "＠")
		.replace(/\./gu, ".\u200b")
		.replace(/:/gu, "：");
}
const states: Record<string, string> = {
	empty: "空欄",
	placeholder: "不明",
	not_public: "非公開",
	formula_error: "数式エラー",
	invalid: "不正値",
	unavailable: "取得不能",
	insufficient_date_precision: "日付精度不足",
	conflicting: "状態矛盾",
	unknown: "状態不明",
};
export function stateText(state: string): string {
	return states[state] ?? literal(state);
}
export function cellText(cell: TypedCell): string {
	if (cell.field_state !== "value")
		return stateText(
			cell.reason === "conflicting" || cell.reason === "unknown"
				? cell.reason
				: cell.field_state,
		);
	const value = cell.value;
	if (Array.isArray(value) && value.length === 0) return "なし";
	const text = Array.isArray(value)
		? value
				.map((item) =>
					typeof item === "string" ? item : `${item.year}年 ${item.rank}位`,
				)
				.join(" / ")
		: String(value);
	return `${literal(text)}${cell.unit ? ` ${literal(cell.unit)}` : ""}${cell.precision && cell.precision !== "day" ? `（精度 ${cell.precision}）` : ""}`;
}
export function filtersText(where: Where): string {
	if (!where) return "条件：全行・全状態";
	return `条件：${where.any
		.map(
			(branch) =>
				`(${branch.all
					.map(
						(atom) =>
							`${label(atom.field)} ${operatorLabels[atom.op]} ${atom.values.map((v) => literal(String(v))).join(" / ")}`,
					)
					.join(" AND ")})`,
		)
		.join(" OR ")}`;
}
const operatorLabels = {
	eq: "が等しい",
	in: "がいずれかに一致",
	not_in: "がいずれにも一致しない",
	lt: "が未満",
	lte: "が以下",
	gt: "が超過",
	gte: "が以上",
	contains: "を含む",
	starts_with: "で始まる",
	is_missing: "が空欄・不明",
	is_present: "に有効な値がある",
};
