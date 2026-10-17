import type { SheetSearchEngine } from "../search/engine";
import type { SearchFailure, SearchResult } from "../search/types";

/** This port accepts only the request-local, pinned executor, never model pages. */
export type AnswerSource = Pick<SheetSearchEngine, "execute" | "readResultSet">;
export type AnswerFailure = {
	status: "error";
	reason: SearchFailure["reason"] | "invalid_result" | "selection_mismatch";
};
export type AnswerLimits = {
	maxPages?: number;
	maxResultBytes?: number;
	maxChunks?: number;
	chunkLimit?: number;
};
export type AnswerChunk = {
	content: string;
	/** Only IDs whose complete row appears in this chunk. Not population IDs. */
	ids: string[];
};
export type DeliveryReceipt = { index: number; content: string };
export type AnswerEvidence = Pick<
	SearchResult,
	| "snapshot_id"
	| "result_set_id"
	| "source_captured_at"
	| "calculation_context"
	| "applied_filters"
	| "matched_count"
	| "selected_count"
	| "unknown_count"
>;

/** F persists acknowledgements after transport success; preparing is not sending. */
export class PreparedSheetAnswer {
	readonly status = "ready";
	private readonly planned: AnswerChunk[];
	private readonly evidence: AnswerEvidence;
	private readonly expectedIds: string[];
	private readonly confirmed = new Set<number>();
	constructor(
		evidence: AnswerEvidence,
		chunks: AnswerChunk[],
		expectedIds: string[],
		readonly selectionComplete: boolean,
		readonly omittedEntries: number,
	) {
		this.evidence = structuredClone({
			snapshot_id: evidence.snapshot_id,
			result_set_id: evidence.result_set_id,
			source_captured_at: evidence.source_captured_at,
			calculation_context: evidence.calculation_context,
			applied_filters: evidence.applied_filters,
			matched_count: evidence.matched_count,
			selected_count: evidence.selected_count,
			unknown_count: evidence.unknown_count,
		});
		this.planned = structuredClone(chunks);
		this.expectedIds = [...new Set(expectedIds)];
	}
	get metadata(): AnswerEvidence {
		return structuredClone(this.evidence);
	}
	get chunks(): AnswerChunk[] {
		return structuredClone(this.planned);
	}
	get omittedIds(): string[] {
		const planned = new Set(this.planned.flatMap((chunk) => chunk.ids));
		return this.expectedIds.filter((id) => !planned.has(id));
	}
	/** Call only for acknowledged, unchanged chunks, never a preview or attempt. */
	confirmDelivered(receipts: readonly DeliveryReceipt[]): boolean {
		if (
			receipts.some(
				({ index, content }) =>
					!Number.isInteger(index) ||
					index < 0 ||
					index >= this.planned.length ||
					content !== this.planned[index].content,
			)
		)
			return false;
		for (const { index } of receipts) this.confirmed.add(index);
		return true;
	}
	deliveryState() {
		const delivered = new Set(
			this.planned.flatMap((chunk, index) =>
				this.confirmed.has(index) ? chunk.ids : [],
			),
		);
		return {
			status:
				this.confirmed.size === 0
					? ("unsent" as const)
					: this.confirmed.size === this.planned.length &&
							this.omittedEntries === 0 &&
							this.selectionComplete
						? ("complete" as const)
						: ("partial" as const),
			delivered_ids: this.expectedIds.filter((id) => delivered.has(id)),
			undelivered_ids: this.expectedIds.filter((id) => !delivered.has(id)),
			confirmed_chunks: [...this.confirmed].sort((a, b) => a - b),
		};
	}
}

/** Structured selections can be checked; free text/names are never reverse parsed. */
export function verifyAnswerSelection(
	source: AnswerSource,
	handle: string,
	proposal: unknown,
): { status: "valid"; ids: string[] } | AnswerFailure {
	if (
		!proposal ||
		typeof proposal !== "object" ||
		!("snapshot_id" in proposal) ||
		typeof proposal.snapshot_id !== "string" ||
		!("ids" in proposal) ||
		!Array.isArray(proposal.ids) ||
		proposal.ids.some((id) => typeof id !== "string") ||
		!("count" in proposal) ||
		typeof proposal.count !== "number" ||
		!Number.isSafeInteger(proposal.count) ||
		proposal.count < 0
	)
		return { status: "error", reason: "selection_mismatch" };
	const expected = source.readResultSet(handle);
	if (expected.status === "error")
		return { status: "error", reason: expected.reason };
	const ids = new Set(proposal.ids);
	if (
		proposal.snapshot_id !== expected.snapshot_id ||
		proposal.count !== proposal.ids.length ||
		ids.size !== proposal.ids.length ||
		ids.size !== expected.ids.length ||
		expected.ids.some((id) => !ids.has(id))
	)
		return { status: "error", reason: "selection_mismatch" };
	return { status: "valid", ids: [...expected.ids] };
}
