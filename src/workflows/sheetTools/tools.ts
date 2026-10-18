import type { LlmToolCall, LlmToolDefinition } from "../../llm/types";
import type {
	AnswerFailure,
	PreparedSheetAnswer,
} from "../../sheets/answers/contracts";
import {
	prepareAggregateAnswer,
	prepareQueryAnswer,
} from "../../sheets/answers/prepare";
import type { SheetSearchEngine } from "../../sheets/search/engine";
import toolSchemas from "../../sheets/search/tools.schema.json";
import type {
	AggregateArgs,
	QueryArgs,
	SearchFailure,
	SearchResult,
	ToolName,
} from "../../sheets/search/types";
import { SHEET_TOOL_LIMITS } from "./limits";

const SEARCH_TOOL_NAMES = [
	"search_records",
	"get_records",
	"query_records",
	"aggregate_records",
] as const satisfies readonly ToolName[];

export const PRESENT_QUERY_TOOL = "present_query_answer";
export const PRESENT_AGGREGATE_TOOL = "present_aggregate_answer";

function schemaFor(name: ToolName) {
	const tool = toolSchemas.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing sheet tool schema: ${name}`);
	return tool;
}

/**
 * The four executor tools unchanged, plus two presentation tools whose
 * parameters are exact copies of query/aggregate so strict-mode coverage holds.
 */
export const SHEET_TOOL_DEFINITIONS: readonly LlmToolDefinition[] =
	Object.freeze([
		...SEARCH_TOOL_NAMES.map((name) => {
			const tool = schemaFor(name);
			return {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				strict: true as const,
			};
		}),
		{
			name: PRESENT_QUERY_TOOL,
			description:
				"Attach a code-verified, code-rendered complete member list for these exact query_records conditions after your final text. Use it whenever the answer enumerates members or states how many match. The list is checked against the full result set and shows partial/unknown status explicitly. Do not repeat the names in your text. At most one attachment per answer.",
			parameters: schemaFor("query_records").parameters,
			strict: true,
		},
		{
			name: PRESENT_AGGREGATE_TOOL,
			description:
				"Attach a code-verified, code-rendered aggregate (counts, min/max with all ties, means with denominators, best ranks, differences) for these exact aggregate_records arguments after your final text. Use it whenever the answer reports counts, rankings or comparisons over a set. Do not restate the rendered figures as complete in your text. At most one attachment per answer.",
			parameters: schemaFor("aggregate_records").parameters,
			strict: true,
		},
	]);

/** Field catalog for the model context: names, types and labels, never rows. */
export function catalogText(engine: Pick<SheetSearchEngine, "catalog">) {
	const lines = ["シート検索で使える項目（dataset: members）:"];
	const operators = new Map<string, string>();
	for (const entry of engine.catalog("members")) {
		operators.set(entry.type, entry.operators.join("/"));
		lines.push(
			entry.available
				? `- ${entry.field} (${entry.type}): ${entry.source}`
				: `- ${entry.field}: 利用不可（${entry.unavailable_reason}）`,
		);
	}
	lines.push("型ごとの演算子:");
	for (const [type, ops] of operators) lines.push(`- ${type}: ${ops}`);
	const references = engine
		.catalog("reference")
		.filter((entry) => entry.available)
		.map((entry) => entry.field);
	lines.push(`dataset: reference の項目: ${references.join(", ")}`);
	return lines.join("\n");
}

export type ToolOutcome = "ok" | "zero" | "ambiguous" | "missing" | "error";

/** Persisted and re-prepared at delivery from the same snapshot and date. */
export type SheetToolAttachment =
	| { kind: "query"; args: QueryArgs; resultSetId: string; chunkCount: number }
	| {
			kind: "aggregate";
			args: AggregateArgs;
			resultSetId: string;
			chunkCount: number;
	  };

export type ToolExecution = {
	name: string;
	outcome: ToolOutcome;
	/** Result reason code only; never arguments or rows. */
	reason?: string;
	output: unknown;
	attachment?: SheetToolAttachment;
	durationMs: number;
};

function isSearchTool(
	name: string,
): name is (typeof SEARCH_TOOL_NAMES)[number] {
	return (SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

const MISSING_STATES = new Set(["empty", "placeholder"]);

/** Separate zero results, ambiguity and missing cells from technical errors. */
export function classifyResult(
	name: string,
	result: SearchResult | SearchFailure,
): ToolOutcome {
	if (result.status === "error") return "error";
	if (result.matched_count === 0 && result.records.length === 0) return "zero";
	if (
		name === "search_records" &&
		(new Set(result.records.map((record) => record.id)).size > 1 ||
			result.records.some((record) =>
				record.matches?.some((match) => match.ambiguous_short_form),
			))
	)
		return "ambiguous";
	if (
		result.records.some((record) =>
			Object.values(record.cells).some(
				(cell) => cell && MISSING_STATES.has(cell.field_state),
			),
		)
	)
		return "missing";
	return "ok";
}

export type PreparedAttachment = PreparedSheetAnswer | AnswerFailure;

export function prepareAttachment(
	engine: SheetSearchEngine,
	attachment: Pick<SheetToolAttachment, "kind" | "args">,
): Promise<PreparedAttachment> {
	return attachment.kind === "query"
		? prepareQueryAnswer(
				engine,
				attachment.args as QueryArgs,
				SHEET_TOOL_LIMITS.render,
			)
		: prepareAggregateAnswer(
				engine,
				attachment.args as AggregateArgs,
				SHEET_TOOL_LIMITS.render,
			);
}

function attachmentSummary(answer: PreparedSheetAnswer) {
	const metadata = answer.metadata;
	return {
		status: "ok",
		attached: true,
		snapshot_id: metadata.snapshot_id,
		result_set_id: metadata.result_set_id,
		applied_filters: metadata.applied_filters,
		matched_count: metadata.matched_count,
		selected_count: metadata.selected_count,
		unknown_count: metadata.unknown_count,
		rendered_chunks: answer.chunks.length,
		omitted_entries: answer.omittedEntries,
		complete: answer.selectionComplete && answer.omittedEntries === 0,
		note: "The application appends this verified rendering after your final text. Summarize it; do not repeat names or claim more completeness than shown.",
	};
}

export async function executeToolCall(
	engine: SheetSearchEngine,
	call: LlmToolCall,
	hasAttachment: boolean,
	now: () => number = Date.now,
): Promise<ToolExecution> {
	const started = now();
	const finish = (
		execution: Omit<ToolExecution, "durationMs" | "name">,
	): ToolExecution => ({
		name: call.name,
		...execution,
		durationMs: now() - started,
	});
	if (!call.arguments.ok) {
		const reason =
			call.arguments.error === "unknown_tool"
				? "unknown_tool"
				: "invalid_arguments";
		return finish({
			outcome: "error",
			reason,
			output: { status: "error", reason },
		});
	}
	const args = call.arguments.value;
	if (isSearchTool(call.name)) {
		const result = await engine.execute(call.name, args);
		return finish({
			outcome: classifyResult(call.name, result),
			...(result.status === "error" ? { reason: result.reason } : {}),
			output: result,
		});
	}
	if (
		call.name === PRESENT_QUERY_TOOL ||
		call.name === PRESENT_AGGREGATE_TOOL
	) {
		if (hasAttachment)
			return finish({
				outcome: "error",
				reason: "attachment_already_set",
				output: { status: "error", reason: "attachment_already_set" },
			});
		const kind = call.name === PRESENT_QUERY_TOOL ? "query" : "aggregate";
		const prepared = await prepareAttachment(engine, {
			kind,
			args: args as QueryArgs | AggregateArgs,
		} as Pick<SheetToolAttachment, "kind" | "args">);
		if (prepared.status === "error")
			return finish({
				outcome: "error",
				reason: prepared.reason,
				output: prepared,
			});
		const summary = attachmentSummary(prepared);
		return finish({
			outcome: summary.matched_count === 0 ? "zero" : "ok",
			output: summary,
			attachment: {
				kind,
				args: structuredClone(args),
				resultSetId: prepared.metadata.result_set_id,
				chunkCount: prepared.chunks.length,
			} as SheetToolAttachment,
		});
	}
	return finish({
		outcome: "error",
		reason: "unknown_tool",
		output: { status: "error", reason: "unknown_tool" },
	});
}
