import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SpreadsheetConfig } from "../../src/config";
import type { HistoryEntry } from "../../src/contracts";
import { normalizeHistory } from "../../src/repositories/conversationHistory";
import { SheetSearchEngine } from "../../src/sheets/search/engine";
import {
	type SheetSnapshotRef,
	SheetSnapshotRepository,
} from "../../src/sheets/snapshot";
import { buildSheetStructure } from "../../src/sheets/structuredSheet";
import { compactSheetRows, parseCsv } from "../../src/utils/compactSheet";
import { ExternalServiceError } from "../../src/utils/errors";
import type { OpenEngine } from "../../src/workflows/sheetTools/loop";

/** Fixed identity for the in-memory snapshot; never a real spreadsheet id. */
export const EVAL_SOURCE: SpreadsheetConfig = {
	id: "sheet-tools-eval-snapshot",
	dataSheetName: "data",
	descriptionSheetName: "description",
};

export type EvalQuestion = {
	id: string;
	category: string;
	question: string;
	history: HistoryEntry[];
};

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Production reads cell A1 of the description sheet as `cell.value?.toString()
 * || ""` (fetchSheetDescription). A Sheets API values response is converted the
 * same way; anything else is taken as the description text itself.
 */
export function parseDescription(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"values" in parsed &&
		Array.isArray(parsed.values)
	) {
		const first: unknown = parsed.values[0];
		const cell: unknown = Array.isArray(first) ? first[0] : undefined;
		return cell?.toString() || "";
	}
	return raw;
}

export function parseQuestions(raw: string): EvalQuestion[] {
	const questions: EvalQuestion[] = [];
	const seen = new Set<string>();
	for (const [index, line] of raw.split("\n").entries()) {
		if (!line.trim()) continue;
		const position = `questions line ${index + 1}`;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			throw new Error(`${position} is not valid JSON`);
		}
		if (typeof row !== "object" || row === null)
			throw new Error(`${position} is not an object`);
		const record = row as Record<string, unknown>;
		const { id, category, question, history } = record;
		if (typeof id !== "string" || !id)
			throw new Error(`${position} needs a string id`);
		if (typeof category !== "string" || !category)
			throw new Error(`${position} needs a string category`);
		if (typeof question !== "string" || !question.trim())
			throw new Error(`${position} needs a string question`);
		if (seen.has(id))
			throw new Error(`duplicate question id at line ${index + 1}`);
		seen.add(id);
		if (history !== undefined && !Array.isArray(history))
			throw new Error(`${position} history must be an array`);
		const entries = normalizeHistory(history ?? []);
		if (entries.length !== (history ?? []).length)
			throw new Error(`${position} has an invalid history entry`);
		questions.push({ id, category, question, history: entries });
	}
	if (questions.length === 0) throw new Error("questions file is empty");
	return questions;
}

export function selectQuestions(
	questions: EvalQuestion[],
	options: { ids?: string[]; limit?: number },
): EvalQuestion[] {
	let selected = questions;
	if (options.ids) {
		const known = new Set(questions.map(({ id }) => id));
		const missing = options.ids.filter((id) => !known.has(id));
		if (missing.length > 0)
			throw new Error(`unknown question ids: ${missing.join(",")}`);
		const wanted = new Set(options.ids);
		selected = questions.filter(({ id }) => wanted.has(id));
	}
	if (options.limit !== undefined) selected = selected.slice(0, options.limit);
	if (selected.length === 0) throw new Error("no questions selected");
	return selected;
}

export type EvalInputs = {
	csv: string;
	description: string;
	/** Production's CSV -> sheetInfo conversion (fetchSheetInfo). */
	sheetInfo: string;
	snapshotSha256: string;
};

export async function loadInputs(
	csvPath: string,
	descriptionPath: string,
): Promise<EvalInputs> {
	const csv = await readFile(csvPath, "utf8");
	const rawDescription = await readFile(descriptionPath, "utf8");
	if (!csv.trim()) throw new Error("csv is empty");
	const description = parseDescription(rawDescription);
	return {
		csv,
		description,
		sheetInfo: compactSheetRows(parseCsv(csv)),
		snapshotSha256: sha256Hex(
			JSON.stringify([sha256Hex(csv), sha256Hex(description)]),
		),
	};
}

export function memoryKv(): KVNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
	} as unknown as KVNamespace;
}

export type EvalSnapshot = {
	repository: SheetSnapshotRepository;
	ref: SheetSnapshotRef;
	/** Same shape and behavior as createSheetToolDeps' openEngine. */
	openEngine: OpenEngine;
};

export async function captureSnapshot(
	inputs: Pick<EvalInputs, "csv" | "description">,
): Promise<EvalSnapshot> {
	const structure = buildSheetStructure(inputs.csv);
	if (structure.status !== "ready")
		throw new Error(`sheet structure unavailable: ${structure.reason}`);
	const repository = new SheetSnapshotRepository(memoryKv());
	const captured = await repository.capture(
		EVAL_SOURCE,
		structure,
		inputs.description,
	);
	if (captured.status !== "ready")
		throw new Error(`snapshot capture failed: ${captured.reason}`);
	return {
		repository,
		ref: captured.ref,
		openEngine: async (prepared, { deliveredIds, signal }) => {
			const opened = await SheetSearchEngine.open(
				repository,
				EVAL_SOURCE,
				prepared.snapshotRef,
				{ questionDate: prepared.questionDate, deliveredIds, signal },
			);
			if (opened.status === "ready") return opened.engine;
			throw new ExternalServiceError({
				service: "sheets",
				operation: `open pinned sheet snapshot ${opened.reason}`,
				retryable: false,
				userMessage: "snapshot unavailable",
			});
		},
	};
}
