import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ILlmGateway,
	LlmRequest,
	LlmStreamEvent,
	LlmUsage,
} from "../../src/llm/types";
import { getSheetSourceIndex } from "../../src/sheets/columnCatalog";
import { searchArgs } from "../../src/sheets/search/testFixtures";
import { SHEET_SCHEMA_ANCHORS } from "../../src/sheets/structuredSheet";
import { ExternalServiceError } from "../../src/utils/errors";
import { type CliDeps, runCli } from "./run";

const NOW = new Date("2026-10-18T12:00:00Z");
const repoRoot = resolve(import.meta.dirname, "../..");
const SENTINELS = [
	"SENTINEL_QUESTION",
	"SENTINEL_ANSWER",
	"SENTINEL_HISTORY",
	"SENTINEL_DESCRIPTION",
	"架空同名",
];

function syntheticCsv(): string {
	const rows = Array.from({ length: 5 }, () => Array<string>(48).fill(""));
	for (const anchor of SHEET_SCHEMA_ANCHORS)
		rows[anchor.row][anchor.column] = anchor.value;
	for (const [index, sid] of ["101", "202"].entries()) {
		const row = rows[index + 3];
		row[getSheetSourceIndex("sid")] = sid;
		row[getSheetSourceIndex("status")] = "99";
		row[getSheetSourceIndex("full_name")] = "架空同名";
		row[getSheetSourceIndex("generation")] = "SNH48 二十三期生";
		row[getSheetSourceIndex("latest_rank")] = "5";
		row[getSheetSourceIndex("election_2025")] = "8";
	}
	return rows
		.map((row) =>
			row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","),
		)
		.join("\n");
}

const USAGE: LlmUsage = {
	inputTokens: 1000,
	cachedInputTokens: 200,
	outputTokens: 50,
	reasoningTokens: 30,
	totalTokens: 1080,
};

const toolRound: LlmStreamEvent[] = [
	{
		type: "tool_calls",
		calls: [
			{
				callId: "call-1",
				name: "search_records",
				arguments: {
					ok: true,
					value: searchArgs as unknown as Record<string, unknown>,
				},
			},
		],
		state: {
			provider: "openai",
			items: [{ opaque: 1 }],
			pendingCallIds: ["call-1"],
		},
	},
	{ type: "usage", usage: USAGE },
	{ type: "finish", finish: { reason: "tool_calls" } },
];
const finalRound = (text = "SENTINEL_ANSWER です"): LlmStreamEvent[] => [
	{ type: "text", delta: text },
	{ type: "usage", usage: USAGE },
	{ type: "finish", finish: { reason: "stop" } },
];

type Script = (request: LlmRequest, call: number) => LlmStreamEvent[] | Error;

function fakeGateway(script: Script) {
	const requests: LlmRequest[] = [];
	const gateway: ILlmGateway = {
		provider: "openai",
		capabilities: { reasoningSummary: true, tools: true },
		generateStream: async function* (request) {
			requests.push(request);
			request.telemetry?.onAttempt();
			const events = script(request, requests.length);
			if (events instanceof Error) throw events;
			for (const event of events) {
				if (event.type === "text") request.telemetry?.onFirstText?.();
				yield event;
			}
		},
		generateText: vi.fn(),
	};
	return { gateway, requests };
}

/** tool_calls -> continuation -> stop for tools; one final answer for legacy. */
const happyScript: Script = (request) =>
	request.tools
		? request.continuation
			? finalRound()
			: toolRound
		: finalRound();

let dir: string;
let paths: { csv: string; description: string; questions: string };

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "sheet-tools-eval-test-"));
	paths = {
		csv: join(dir, "sheet.csv"),
		description: join(dir, "description.json"),
		questions: join(dir, "questions.jsonl"),
	};
	await writeFile(paths.csv, syntheticCsv());
	await writeFile(
		paths.description,
		JSON.stringify({
			range: "description!A1",
			majorDimension: "ROWS",
			values: [["SENTINEL_DESCRIPTION ルール"]],
		}),
	);
	await writeFile(
		paths.questions,
		[
			{
				id: "q1",
				category: "list",
				question: "SENTINEL_QUESTION 1",
				history: [{ role: "user", text: "SENTINEL_HISTORY" }],
				extra: "ignored",
			},
			{ id: "q2", category: "count", question: "SENTINEL_QUESTION 2" },
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
});

function harness(gateway?: ILlmGateway, overrides: Partial<CliDeps> = {}) {
	const lines: string[] = [];
	const loadApiKey = vi.fn(() => "test-key");
	const createGateway = vi.fn(() => {
		if (!gateway) throw new Error("no gateway expected");
		return gateway;
	});
	const deps: CliDeps = {
		repoRoot,
		loadApiKey,
		createGateway,
		gitCommit: async () => "abc123",
		isIgnored: async () => false,
		now: () => NOW,
		print: (line) => lines.push(line),
		...overrides,
	};
	return { deps, lines, loadApiKey, createGateway };
}

async function execute(
	gateway: ILlmGateway,
	extra: string[] = [],
	mode = "tools",
	maxUsd = "5",
) {
	const out = await mkdtemp(join(tmpdir(), "sheet-tools-eval-out-"));
	const h = harness(gateway);
	const code = await runCli(
		[
			"--csv",
			paths.csv,
			"--description",
			paths.description,
			"--questions",
			paths.questions,
			"--out",
			out,
			"--mode",
			mode,
			"--max-usd",
			maxUsd,
			"--execute",
			...extra,
		],
		h.deps,
	);
	const raw = (await readFile(join(out, "raw.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const summaryText = await readFile(join(out, "summary.json"), "utf8");
	return { code, raw, summaryText, summary: JSON.parse(summaryText), h };
}

describe("sheet tools evaluation harness", () => {
	it("completes tool_calls -> continuation -> stop with per-round usage", async () => {
		const { gateway, requests } = fakeGateway(happyScript);
		const { code, raw, summary } = await execute(gateway, ["--ids", "q1"]);
		expect(code).toBe(0);
		expect(raw).toHaveLength(1);
		const [result] = raw;
		expect(result.outcome).toEqual({ kind: "answered" });
		expect(result.finalText).toContain("SENTINEL_ANSWER");
		expect(result.deliveredChunks.join("")).toContain("SENTINEL_ANSWER");
		expect(
			result.rounds.map((r: { finishReason: string }) => r.finishReason),
		).toEqual(["tool_calls", "stop"]);
		expect(result.rounds[0].usage).toEqual(USAGE);
		expect(result.rounds[0].calls).toEqual([
			expect.objectContaining({ name: "search_records" }),
		]);
		expect(result.rounds[0].stateBytes).toBeGreaterThan(0);
		expect(result.rounds[0].roundOutputBytes).toBeGreaterThan(0);
		expect(result.costUsd).toBeGreaterThan(0);
		expect(requests[1].continuation?.results).toHaveLength(1);
		expect(requests[0].tools?.length).toBeGreaterThan(0);
		expect(summary.g1Acceptance).toEqual({
			schemaAccepted: true,
			continuationObserved: true,
			usageAlwaysPresent: true,
		});
		expect(summary.paths.tools.tokens.cachedInputTokens).toBe(400);
	});

	it("distinguishes budget exhaustion from a technical failure", async () => {
		const length = fakeGateway(() => [
			{ type: "text", delta: "partial" },
			{ type: "usage", usage: USAGE },
			{ type: "finish", finish: { reason: "length" } },
		]);
		const budget = await execute(length.gateway, ["--ids", "q1"]);
		expect(budget.raw[0].outcome).toEqual({
			kind: "budget_exceeded",
			reason: "output_tokens",
		});

		const failing = fakeGateway(
			() =>
				new ExternalServiceError({
					service: "llm",
					operation: "openai request",
					status: 400,
					retryable: false,
					userMessage: "x",
				}),
		);
		const technical = await execute(failing.gateway, ["--ids", "q1"]);
		expect(technical.raw[0].outcome).toEqual({
			kind: "technical_failure",
			service: "llm",
			operation: "openai request",
			status: 400,
		});
		expect(technical.summary.g1Acceptance.schemaAccepted).toBe(false);
	});

	it("stops before sending when the reservation exceeds --max-usd", async () => {
		const { gateway, requests } = fakeGateway(happyScript);
		const { raw, summary } = await execute(gateway, [], "tools", "0.0001");
		expect(requests).toHaveLength(0);
		expect(raw.map((r) => r.outcome.kind)).toEqual([
			"harness_budget_stop",
			"harness_budget_stop",
		]);
		expect(summary.paths.tools.outcomes).toEqual({ harness_budget_stop: 2 });
	});

	it("runs the legacy path with the production prompt", async () => {
		const { gateway, requests } = fakeGateway(happyScript);
		const { raw } = await execute(gateway, ["--ids", "q1"], "legacy");
		expect(raw[0].outcome).toEqual({ kind: "answered" });
		expect(raw[0].path).toBe("legacy");
		expect(requests[0].tools).toBeUndefined();
		expect(requests[0].prompt.systemInstruction).toContain(
			"SENTINEL_DESCRIPTION",
		);
		expect(requests[0].prompt.context).toContain("架空同名");
		expect(requests[0].includeReasoningSummary).toBeUndefined();
		expect(raw[0].deliveredChunks.join("")).toContain("SENTINEL_ANSWER");
	});

	it("alternates which path runs first in both mode", async () => {
		const { gateway } = fakeGateway(happyScript);
		const { raw, summary } = await execute(gateway, [], "both");
		expect(raw.map((r) => `${r.id}:${r.path}`)).toEqual([
			"q1:legacy",
			"q1:tools",
			"q2:tools",
			"q2:legacy",
		]);
		expect(Object.keys(summary.paths).sort()).toEqual(["legacy", "tools"]);
	});

	it("keeps question, answer, history and row text out of summary and stdout", async () => {
		const { gateway } = fakeGateway(happyScript);
		const { summaryText, h } = await execute(gateway, [], "both");
		const printed = h.lines.join("\n");
		for (const sentinel of SENTINELS) {
			expect(summaryText).not.toContain(sentinel);
			expect(printed).not.toContain(sentinel);
		}
	});

	it("dry run loads no key, builds no gateway and writes nothing", async () => {
		const out = join(
			await mkdtemp(join(tmpdir(), "sheet-tools-eval-dry-")),
			"run",
		);
		const h = harness();
		const code = await runCli(
			[
				"--csv",
				paths.csv,
				"--description",
				paths.description,
				"--questions",
				paths.questions,
				"--out",
				out,
				"--mode",
				"both",
				"--max-usd",
				"1",
			],
			h.deps,
		);
		expect(code).toBe(0);
		expect(h.loadApiKey).not.toHaveBeenCalled();
		expect(h.createGateway).not.toHaveBeenCalled();
		const printed = h.lines.join("\n");
		expect(printed).toContain("offline plan only");
		expect(printed).toMatch(/snapshot sha256: [0-9a-f]{64}/);
		expect(printed).toContain("gpt-6-luna");
		expect(printed).toContain("worst case tools");
		for (const sentinel of SENTINELS) expect(printed).not.toContain(sentinel);
		await expect(readFile(join(out, "raw.jsonl"))).rejects.toThrow();
	});

	it("refuses an --out inside a tracked directory", async () => {
		const h = harness();
		await expect(
			runCli(
				[
					"--csv",
					paths.csv,
					"--description",
					paths.description,
					"--questions",
					paths.questions,
					"--out",
					join(repoRoot, "src", "eval-out"),
					"--mode",
					"tools",
					"--max-usd",
					"1",
				],
				h.deps,
			),
		).rejects.toThrow("not gitignored");
		// An ignored in-repo directory is accepted.
		const ignored = harness(undefined, { isIgnored: async () => true });
		await expect(
			runCli(
				[
					"--csv",
					paths.csv,
					"--description",
					paths.description,
					"--questions",
					paths.questions,
					"--out",
					join(repoRoot, ".llm-eval", "sheet-tools-test"),
					"--mode",
					"tools",
					"--max-usd",
					"1",
				],
				ignored.deps,
			),
		).resolves.toBe(0);
	});

	it("rejects stale pricing", async () => {
		const h = harness(undefined, {
			now: () => new Date("2026-11-30T00:00:00Z"),
		});
		await expect(
			runCli(
				[
					"--csv",
					paths.csv,
					"--description",
					paths.description,
					"--questions",
					paths.questions,
					"--out",
					join(tmpdir(), "sheet-tools-eval-stale"),
					"--mode",
					"tools",
					"--max-usd",
					"1",
				],
				h.deps,
			),
		).rejects.toThrow("stale");
	});
});
