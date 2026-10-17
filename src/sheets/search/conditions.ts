import { fieldType, operators } from "./catalog";
import { normalize, validDay } from "./cells";
import type { Atom, Field, TypedCell, Where } from "./types";

export type Truth = true | false | "unknown";
export function validateAtom(atom: Atom): boolean {
	if (!operators(atom.field).includes(atom.op)) return false;
	const { op, values } = atom;
	if (op === "is_missing" || op === "is_present") return values.length === 0;
	if (op === "in" || op === "not_in") {
		if (!values.length) return false;
	} else if (values.length !== 1) return false;
	const type = fieldType(atom.field);
	return values.every((value) =>
		type === "number"
			? typeof value === "number"
			: type === "date"
				? typeof value === "string" && validDay(value)
				: typeof value === "string" && !!normalize(value),
	);
}
export function testAtom(cell: TypedCell, atom: Atom): Truth {
	const { op, values } = atom;
	const missing =
		cell.field_state === "empty" || cell.field_state === "placeholder";
	if (op === "is_missing")
		return missing ? true : cell.field_state === "value" ? false : "unknown";
	if (op === "is_present")
		return cell.field_state === "value" ? true : missing ? false : "unknown";
	if (cell.field_state !== "value" || cell.value === null) return "unknown";
	if (fieldType(atom.field) === "date" && cell.precision !== "day")
		return "unknown";
	const current = Array.isArray(cell.value) ? cell.value : [cell.value];
	const equals = current.some((item) =>
		values.some((value) =>
			typeof item === "string" && typeof value === "string"
				? normalize(item) === normalize(value)
				: item === value,
		),
	);
	if (op === "eq" || op === "in") return equals;
	if (op === "not_in") return !equals;
	if (op === "contains" || op === "starts_with")
		return current.some(
			(item) =>
				typeof item === "string" &&
				(op === "contains"
					? normalize(item).includes(normalize(String(values[0])))
					: normalize(item).startsWith(normalize(String(values[0])))),
		);
	const left = cell.value as string | number;
	const right = values[0] as string | number;
	switch (op) {
		case "lt":
			return left < right;
		case "lte":
			return left <= right;
		case "gt":
			return left > right;
		case "gte":
			return left >= right;
		default:
			return "unknown";
	}
}
export function testWhere(
	where: Where,
	cell: (field: Field) => TypedCell,
): Truth {
	if (where === null) return true;
	const branches = where.any.map((branch) => {
		const results = branch.all.map((atom) => testAtom(cell(atom.field), atom));
		return results.includes(false)
			? false
			: results.includes("unknown")
				? "unknown"
				: true;
	});
	return branches.includes(true)
		? true
		: branches.includes("unknown")
			? "unknown"
			: false;
}
export function compareCell(
	a: TypedCell,
	b: TypedCell,
	direction: "asc" | "desc",
): number {
	const aValid =
		a.field_state === "value" &&
		(a.precision === undefined || a.precision === "day");
	const bValid =
		b.field_state === "value" &&
		(b.precision === undefined || b.precision === "day");
	if (aValid !== bValid) return aValid ? -1 : 1;
	if (!aValid) return 0;
	const left = a.value as string | number;
	const right = b.value as string | number;
	return (
		(left < right ? -1 : left > right ? 1 : 0) * (direction === "asc" ? 1 : -1)
	);
}
