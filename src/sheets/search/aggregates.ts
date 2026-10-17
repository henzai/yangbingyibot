import type { Field, Metric, MetricResult, Rank, TypedCell } from "./types";

export type RowAccess = { id: string; cell: (field: Field) => TypedCell };
export async function calculateMetric(
	rows: RowAccess[],
	metric: Metric,
	registerSet: (ids: string[]) => Promise<string>,
): Promise<MetricResult> {
	const result: MetricResult = {
		op: metric.op,
		field: metric.field,
		value: null,
		population_count: rows.length,
		valid_count: 0,
		unknown_count: 0,
		missing_by_state: {},
	};
	if (metric.op === "count")
		return { ...result, value: rows.length, valid_count: rows.length };
	const field = metric.field as Field;
	const cells = rows.map((row) => ({ id: row.id, cell: row.cell(field) }));
	const valid = cells.filter(
		({ cell }) =>
			cell.field_state === "value" &&
			(cell.precision === undefined || cell.precision === "day"),
	);
	for (const { cell } of cells) {
		if (
			cell.field_state === "value" &&
			(cell.precision === undefined || cell.precision === "day")
		)
			continue;
		const reason =
			cell.field_state === "value"
				? "insufficient_date_precision"
				: cell.field_state;
		result.missing_by_state[reason] =
			(result.missing_by_state[reason] ?? 0) + 1;
	}
	result.valid_count = valid.length;
	result.unknown_count = cells.length - valid.length;
	result.unit = valid[0]?.cell.unit;
	if (metric.op === "difference") {
		const left = cells.find((row) => row.id === metric.operands?.left_id)?.cell;
		const right = cells.find(
			(row) => row.id === metric.operands?.right_id,
		)?.cell;
		result.population_count = 2;
		const operands = [left, right];
		result.valid_count = operands.filter(
			(cell) =>
				cell?.field_state === "value" &&
				(cell.precision === undefined || cell.precision === "day"),
		).length;
		result.unknown_count = 2 - result.valid_count;
		result.missing_by_state = {};
		for (const cell of operands)
			if (
				cell?.field_state !== "value" ||
				(cell.precision && cell.precision !== "day")
			) {
				const state =
					cell?.field_state === "value"
						? "insufficient_date_precision"
						: (cell?.field_state ?? "unavailable");
				result.missing_by_state[state] =
					(result.missing_by_state[state] ?? 0) + 1;
			}
		if (!result.unknown_count && left && right) {
			if (typeof left.value === "number" && typeof right.value === "number")
				result.value = left.value - right.value;
			else if (left.precision === "day" && right.precision === "day") {
				result.value =
					(Date.parse(String(left.value)) - Date.parse(String(right.value))) /
					86400000;
				result.unit = "days";
			}
		}
		return result;
	}
	if (!valid.length) return result;
	if (metric.op === "best_rank") {
		const entries = valid.flatMap((row) =>
			(row.cell.value as Rank[]).map((rank) => ({ id: row.id, ...rank })),
		);
		const best = Math.min(...entries.map((rank) => rank.rank));
		result.value = best;
		const matched = entries.filter((rank) => rank.rank === best);
		result.rank_match_count = matched.length;
		result.rank_set_id = await registerSet([
			...new Set(matched.map((rank) => rank.id)),
		]);
		result.ranks = matched.length <= 20 ? matched : undefined;
		result.unit = "rank";
		return result;
	}
	if (metric.op === "mean") {
		result.value =
			valid.reduce((sum, row) => sum + (row.cell.value as number), 0) /
			valid.length;
		return result;
	}
	const sorted = [...valid].sort((a, b) => {
		const left = a.cell.value as number | string,
			right = b.cell.value as number | string;
		return (
			(left < right ? -1 : left > right ? 1 : 0) *
			(metric.op === "min" ? 1 : -1)
		);
	});
	result.value = sorted[0].cell.value as number | string;
	const ids = sorted
		.filter((row) => row.cell.value === result.value)
		.map((row) => row.id)
		.sort();
	result.tied_count = ids.length;
	result.tied_set_id = await registerSet(ids);
	// A handle represents the complete tie set; previews never imply completeness.
	result.tied_ids = ids.length <= 20 ? ids : undefined;
	return result;
}
