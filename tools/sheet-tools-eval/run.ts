import {
	appendFile,
	mkdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	buildAnswerPrompt,
	buildSheetToolPrompt,
} from "../../src/llm/promptBuilder";
import { toOpenAIRequest } from "../../src/llm/providers/openaiPrompt";
import type { ILlmGateway } from "../../src/llm/types";
import { SHEET_TOOL_LIMITS } from "../../src/workflows/sheetTools/limits";
import { prepareSheetToolsStep } from "../../src/workflows/sheetTools/loop";
import { SHEET_TOOL_DEFINITIONS } from "../../src/workflows/sheetTools/tools";
import { assertFreshPricing, findPrice } from "../llm-eval/pricing";
import type { PriceCatalog } from "../llm-eval/types";
import {
	captureSnapshot,
	type EvalQuestion,
	loadInputs,
	parseQuestions,
	selectQuestions,
} from "./inputs";
import {
	LEGACY_RESERVED_OUTPUT_TOKENS,
	MAX_PROVIDER_ATTEMPTS,
	MeteredGateway,
	requestInputBytes,
	reservationUsd,
} from "./metered";
import {
	type AnswerPath,
	type PathResult,
	runLegacyPath,
	runToolsPath,
} from "./paths";
import { buildSummary } from "./summary";

export const EVAL_MODEL = "gpt-6-luna";
const MODES = ["tools", "legacy", "both"] as const;
type Mode = (typeof MODES)[number];

export type CliDeps = {
	repoRoot: string;
	/** Reads OPENAI_API_KEY from the gitignored .env.local; --execute only. */
	loadApiKey(): string;
	/** Builds the production OpenAI gateway; --execute only. */
	createGateway(apiKey: string): ILlmGateway;
	gitCommit(): Promise<string>;
	/** True when `git check-ignore` reports the path as ignored. */
	isIgnored(path: string): Promise<boolean>;
	now?: () => Date;
	print(line: string): void;
};

type Options = {
	csv: string;
	description: string;
	questions: string;
	out: string;
	mode: Mode;
	maxUsd: number;
	limit?: number;
	ids?: string[];
	execute: boolean;
};

export function parseOptions(argv: string[]): Options {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: {
			csv: { type: "string" },
			description: { type: "string" },
			questions: { type: "string" },
			out: { type: "string" },
			mode: { type: "string" },
			"max-usd": { type: "string" },
			limit: { type: "string" },
			ids: { type: "string" },
			execute: { type: "boolean", default: false },
		},
	});
	for (const required of [
		"csv",
		"description",
		"questions",
		"out",
		"mode",
	] as const)
		if (!values[required]) throw new Error(`--${required} is required`);
	const mode = values.mode as Mode;
	if (!MODES.includes(mode))
		throw new Error("--mode must be tools, legacy or both");
	const maxUsd = Number(values["max-usd"]);
	if (!values["max-usd"] || !Number.isFinite(maxUsd) || maxUsd <= 0)
		throw new Error("--max-usd must be a positive number");
	let limit: number | undefined;
	if (values.limit !== undefined) {
		limit = Number(values.limit);
		if (!Number.isInteger(limit) || limit < 1)
			throw new Error("--limit must be a positive integer");
	}
	return {
		csv: values.csv as string,
		description: values.description as string,
		questions: values.questions as string,
		out: values.out as string,
		mode,
		maxUsd,
		limit,
		ids: values.ids ? values.ids.split(",").filter(Boolean) : undefined,
		execute: values.execute === true,
	};
}

async function realpathOfExisting(path: string): Promise<string> {
	let current = resolve(path);
	const tail: string[] = [];
	for (;;) {
		try {
			return join(await realpath(current), ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			tail.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

/** Raw answers are local only: outside the repository, or gitignored. */
export async function assertSafeOutDir(
	out: string,
	deps: Pick<CliDeps, "repoRoot" | "isIgnored">,
): Promise<string> {
	const target = await realpathOfExisting(out);
	const root = await realpathOfExisting(deps.repoRoot);
	const inside = relative(root, target);
	const outside = inside.startsWith("..") || isAbsolute(inside);
	if (!outside && !(await deps.isIgnored(join(target, "raw.jsonl"))))
		throw new Error("--out is inside the repository and not gitignored");
	return target;
}

/** The adapter fixes these for gpt-6-luna; the harness asserts, never sets. */
export function assertProductionRequestShape(): void {
	const request = toOpenAIRequest({
		model: EVAL_MODEL,
		prompt: { systemInstruction: "x", messages: [] },
		tools: SHEET_TOOL_DEFINITIONS,
	});
	if (request.store !== false)
		throw new Error("adapter no longer sends store:false");
	if (request.reasoning?.effort !== "medium")
		throw new Error("adapter no longer fixes reasoning effort medium");
	if (!request.tools?.every((tool) => tool.type === "function" && tool.strict))
		throw new Error("adapter no longer sends strict function tools");
}

function orderFor(mode: Mode, index: number): AnswerPath[] {
	if (mode !== "both") return [mode];
	return index % 2 === 0 ? ["legacy", "tools"] : ["tools", "legacy"];
}

function stopResult(question: EvalQuestion, path: AnswerPath): PathResult {
	return {
		id: question.id,
		category: question.category,
		path,
		outcome: { kind: "harness_budget_stop" },
		finalText: "",
		deliveredChunks: [],
		progressEditCount: 0,
		rounds: [],
		toolCallCount: 0,
		toolOutcomes: { ok: 0, zero: 0, ambiguous: 0, missing: 0, error: 0 },
		usage: null,
		attempts: 0,
		costUsd: 0,
		costKind: "observed",
		totalMs: 0,
		firstFinalTextMs: null,
		questionDate: null,
		maxStateBytes: 0,
		maxToolResultBytes: 0,
		maxRoundOutputBytes: 0,
	};
}

function resultLine(result: PathResult): string {
	const outcome = result.outcome;
	const code =
		outcome.kind === "budget_exceeded"
			? `budget_exceeded(${outcome.reason})`
			: outcome.kind === "technical_failure"
				? `technical_failure(${outcome.service},${outcome.status ?? "none"})`
				: outcome.kind;
	return `${result.id} ${result.path} ${code} rounds=${result.rounds.length} toolCalls=${result.toolCallCount} costUsd=${result.costUsd.toFixed(6)} totalMs=${Math.round(result.totalMs)}`;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const options = parseOptions(argv);
	const out = await assertSafeOutDir(options.out, deps);
	const catalog = JSON.parse(
		await readFile(join(import.meta.dirname, "pricing.json"), "utf8"),
	) as PriceCatalog;
	assertFreshPricing(catalog, deps.now?.());
	const price = findPrice(catalog, "openai", EVAL_MODEL);
	assertProductionRequestShape();

	const inputs = await loadInputs(options.csv, options.description);
	const questions = selectQuestions(
		parseQuestions(await readFile(options.questions, "utf8")),
		{ ids: options.ids, limit: options.limit },
	);
	const snapshot = await captureSnapshot(inputs);
	const prepared = await prepareSheetToolsStep(snapshot, snapshot.ref);

	const legacyUsd = (question: EvalQuestion) =>
		reservationUsd(
			requestInputBytes({
				model: EVAL_MODEL,
				prompt: buildAnswerPrompt({
					description: inputs.description,
					knowledge: inputs.sheetInfo,
					history: question.history,
					question: question.question,
				}),
			}),
			LEGACY_RESERVED_OUTPUT_TOKENS,
			price,
		);
	const toolsUsd = (question: EvalQuestion) =>
		SHEET_TOOL_LIMITS.maxModelRounds *
		reservationUsd(
			requestInputBytes({
				model: EVAL_MODEL,
				prompt: buildSheetToolPrompt({
					description: prepared.description,
					questionDate: prepared.questionDate,
					catalog: prepared.catalog,
					maxToolCalls: SHEET_TOOL_LIMITS.maxToolCalls,
					history: question.history,
					question: question.question,
				}),
				tools: SHEET_TOOL_DEFINITIONS,
			}) +
				SHEET_TOOL_LIMITS.maxStateBytes +
				SHEET_TOOL_LIMITS.maxCumulativeToolResultBytes,
			SHEET_TOOL_LIMITS.maxOutputTokensPerRound,
			price,
		);

	const print = deps.print;
	print("Sheet tools evaluation plan (ids and numbers only)");
	print(`model: ${EVAL_MODEL} (reasoning effort and store:false asserted)`);
	print(`mode: ${options.mode}`);
	print(`questions: ${questions.length}`);
	print(`snapshot sha256: ${inputs.snapshotSha256}`);
	print(
		`price: ${catalog.version} effective ${catalog.effectiveDate} (${catalog.sources.join(", ")})`,
	);
	print(`max usd: ${options.maxUsd}`);
	print(`question date (this run, Asia/Tokyo): ${prepared.questionDate}`);
	print(
		`reservation: UTF-8 bytes as token ceiling, ${MAX_PROVIDER_ATTEMPTS} attempts, legacy output ceiling ${LEGACY_RESERVED_OUTPUT_TOKENS} tokens`,
	);
	let planned = 0;
	for (const [path, estimate] of [
		["legacy", legacyUsd],
		["tools", toolsUsd],
	] as const) {
		if (options.mode !== path && options.mode !== "both") continue;
		const values = questions.map(estimate);
		const total = values.reduce((sum, value) => sum + value, 0);
		planned += total;
		print(
			`worst case ${path}: max per question ${Math.max(...values).toFixed(4)} usd, total ${total.toFixed(4)} usd`,
		);
	}
	print(`worst case total: ${planned.toFixed(4)} usd`);
	if (planned > options.maxUsd)
		print(
			"note: the worst case exceeds --max-usd; per-request reservations will stop the run early",
		);
	if (!options.execute) {
		print("offline plan only; pass --execute to make real API calls");
		return 0;
	}

	const gateway = deps.createGateway(deps.loadApiKey());
	const meter = new MeteredGateway(gateway, price, options.maxUsd);
	const ctx = {
		snapshot,
		meter,
		model: EVAL_MODEL,
		description: inputs.description,
		sheetInfo: inputs.sheetInfo,
	};
	await mkdir(out, { recursive: true, mode: 0o700 });
	const rawPath = join(out, "raw.jsonl");
	await writeFile(rawPath, "", { mode: 0o600, flag: "wx" });
	const results: PathResult[] = [];
	let stopped = false;
	for (const [index, question] of questions.entries()) {
		for (const [position, path] of orderFor(options.mode, index).entries()) {
			const result = stopped
				? stopResult(question, path)
				: path === "tools"
					? await runToolsPath(ctx, question)
					: await runLegacyPath(ctx, question);
			if (result.outcome.kind === "harness_budget_stop") stopped = true;
			results.push(result);
			await appendFile(
				rawPath,
				`${JSON.stringify({ questionIndex: index, runOrder: position + 1, ...result })}\n`,
			);
			print(resultLine(result));
		}
	}
	const summary = buildSummary(results, {
		snapshotSha256: inputs.snapshotSha256,
		gitCommit: await deps.gitCommit(),
		model: EVAL_MODEL,
		priceVersion: catalog.version,
		priceEffectiveDate: catalog.effectiveDate,
		mode: options.mode,
		maxUsd: options.maxUsd,
		spentUsd: meter.spent,
		questionDate:
			results.find((result) => result.questionDate)?.questionDate ?? null,
	});
	await writeFile(
		join(out, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
		{ mode: 0o600 },
	);
	print(`spent estimate: ${meter.spent.toFixed(6)} usd of ${options.maxUsd}`);
	print(`local artifacts: ${out}/raw.jsonl, ${out}/summary.json`);
	return 0;
}
