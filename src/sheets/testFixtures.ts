import { getSheetSourceIndex } from "./columnCatalog";
import {
	buildSheetStructureFromRows,
	type ReadySheetStructure,
	SHEET_SCHEMA_ANCHORS,
} from "./structuredSheet";

/** Artificial members only; never copy live sheet rows into fixtures. */
export function memberFixture(): ReadySheetStructure {
	const rows = Array.from({ length: 5 }, () => Array<string>(48).fill(""));
	for (const anchor of SHEET_SCHEMA_ANCHORS)
		rows[anchor.row][anchor.column] = anchor.value;
	for (const [index, sid] of ["101", "202"].entries()) {
		const row = rows[index + 3];
		row[getSheetSourceIndex("sid")] = sid;
		row[getSheetSourceIndex("status")] = "99";
		row[getSheetSourceIndex("full_name")] = "架空同名";
		row[getSheetSourceIndex("generation")] =
			index === 0 ? "SNH48 二十三期生" : "BEJ48 二十三期生";
		row[getSheetSourceIndex("latest_rank")] = "5";
		row[getSheetSourceIndex("election_2025")] = "8";
	}
	const result = buildSheetStructureFromRows(rows);
	if (result.status !== "ready")
		throw new Error("Invalid artificial member fixture");
	return result;
}
