import type { SpreadsheetConfig } from "../config";
import {
	readMemberRecords,
	SHEET_NORMALIZATION_VERSION,
} from "./memberRecords";
import { sha256, sourceFingerprint } from "./sourceFingerprint";
import { isSheetStructure, type ReadySheetStructure } from "./structuredSheet";

export const SNAPSHOT_VERSION = 1 as const;
/** Raw description is preserved; tool-specific prompt assembly is a later change. */
export const DESCRIPTION_POLICY_VERSION = 1 as const;
export const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const KEY_PREFIX = "sheet_snapshot:v1:";
const DIGEST = /^[0-9a-f]{64}$/;

export type SheetSnapshotRef = {
	snapshotId: string;
	sourceFingerprint: string;
	expiresAt: number;
};

type SnapshotContent = {
	version: typeof SNAPSHOT_VERSION;
	sourceFingerprint: string;
	normalizationVersion: typeof SHEET_NORMALIZATION_VERSION;
	descriptionPolicyVersion: typeof DESCRIPTION_POLICY_VERSION;
	description: string;
	descriptionDigest: string;
	structuredSheet: ReadySheetStructure;
};

export type SheetSnapshot = SnapshotContent & {
	contentDigest: string;
	/** Capture time, not the upstream sheet's modification time. */
	capturedAt: number;
	expiresAt: number;
};

type FailureReason =
	| "invalid_snapshot"
	| "invalid_identity"
	| "missing_description"
	| "too_large"
	| "source_mismatch"
	| "expired"
	| "not_found"
	| "storage_error";
type Unavailable = { status: "unavailable"; reason: FailureReason };
type Captured = { status: "ready"; ref: SheetSnapshotRef };
type Loaded = { status: "ready"; snapshot: SheetSnapshot };

export function isSheetSnapshotRef(value: unknown): value is SheetSnapshotRef {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.snapshotId === "string" &&
		DIGEST.test(record.snapshotId) &&
		typeof record.sourceFingerprint === "string" &&
		DIGEST.test(record.sourceFingerprint) &&
		typeof record.expiresAt === "number" &&
		Number.isSafeInteger(record.expiresAt) &&
		record.expiresAt > 0
	);
}

/** Canonical field order and detached arrays, including when input comes from KV. */
function copyStructure(sheet: ReadySheetStructure): ReadySheetStructure {
	return {
		status: "ready",
		schemaVersion: sheet.schemaVersion,
		catalogVersion: sheet.catalogVersion,
		columnKeys: [...sheet.columnKeys],
		headerRows: sheet.headerRows.map((row) => [...row]),
		personRows: sheet.personRows.map((row) => [...row]),
		sourceRowNumbers: [...sheet.sourceRowNumbers],
		availableYears: [...sheet.availableYears],
		latestDataYear: sheet.latestDataYear,
	};
}

function contentOf(snapshot: SnapshotContent): SnapshotContent {
	return {
		version: SNAPSHOT_VERSION,
		sourceFingerprint: snapshot.sourceFingerprint,
		normalizationVersion: SHEET_NORMALIZATION_VERSION,
		descriptionPolicyVersion: DESCRIPTION_POLICY_VERSION,
		description: snapshot.description,
		descriptionDigest: snapshot.descriptionDigest,
		structuredSheet: copyStructure(snapshot.structuredSheet),
	};
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function key(ref: SheetSnapshotRef): string {
	return `${KEY_PREFIX}${ref.sourceFingerprint}:${ref.snapshotId}`;
}

export class SheetSnapshotRepository {
	constructor(
		private readonly kv: KVNamespace,
		private readonly now: () => number = Date.now,
	) {}

	async capture(
		source: SpreadsheetConfig,
		structuredSheet: unknown,
		description: string,
	): Promise<Captured | Unavailable> {
		if (
			!isSheetStructure(structuredSheet) ||
			structuredSheet.status !== "ready"
		) {
			return { status: "unavailable", reason: "invalid_snapshot" };
		}
		if (!description.trim())
			return { status: "unavailable", reason: "missing_description" };
		// Copy before the first await: caller mutation cannot change this capture.
		const sheet = copyStructure(structuredSheet);
		const capturedAt = this.now();
		if (!Number.isSafeInteger(capturedAt) || capturedAt < 0)
			return { status: "unavailable", reason: "invalid_snapshot" };
		const sourceId = await sourceFingerprint(source);
		if (readMemberRecords(sheet, sourceId).status !== "ready")
			return { status: "unavailable", reason: "invalid_identity" };
		const content = contentOf({
			version: SNAPSHOT_VERSION,
			sourceFingerprint: sourceId,
			normalizationVersion: SHEET_NORMALIZATION_VERSION,
			descriptionPolicyVersion: DESCRIPTION_POLICY_VERSION,
			description,
			descriptionDigest: await sha256(description),
			structuredSheet: sheet,
		});
		const snapshot: SheetSnapshot = {
			...content,
			contentDigest: await sha256(JSON.stringify(content)),
			capturedAt,
			expiresAt: capturedAt + SNAPSHOT_TTL_SECONDS * 1000,
		};
		const serialized = JSON.stringify(snapshot);
		if (bytes(serialized) > SNAPSHOT_MAX_BYTES)
			return { status: "unavailable", reason: "too_large" };
		const ref: SheetSnapshotRef = {
			snapshotId: await sha256(serialized),
			sourceFingerprint: sourceId,
			expiresAt: snapshot.expiresAt,
		};
		try {
			// Content-addressed complete envelope: repeated writes contain identical bytes.
			await this.kv.put(key(ref), serialized, {
				expiration: Math.ceil(snapshot.expiresAt / 1000),
			});
			return { status: "ready", ref };
		} catch {
			return { status: "unavailable", reason: "storage_error" };
		}
	}

	async get(
		source: SpreadsheetConfig,
		ref: SheetSnapshotRef,
	): Promise<Loaded | Unavailable> {
		if (!isSheetSnapshotRef(ref))
			return { status: "unavailable", reason: "invalid_snapshot" };
		if (ref.sourceFingerprint !== (await sourceFingerprint(source)))
			return { status: "unavailable", reason: "source_mismatch" };
		if (this.now() >= ref.expiresAt)
			return { status: "unavailable", reason: "expired" };
		let serialized: string | null;
		try {
			serialized = await this.kv.get(key(ref), "text");
		} catch {
			return { status: "unavailable", reason: "storage_error" };
		}
		// KV visibility is eventual. A miss is unavailable; never substitute today's cache.
		if (serialized === null)
			return { status: "unavailable", reason: "not_found" };
		if (bytes(serialized) > SNAPSHOT_MAX_BYTES)
			return { status: "unavailable", reason: "too_large" };
		try {
			const value = JSON.parse(serialized) as SheetSnapshot;
			if (
				!value ||
				value.version !== SNAPSHOT_VERSION ||
				value.normalizationVersion !== SHEET_NORMALIZATION_VERSION ||
				value.descriptionPolicyVersion !== DESCRIPTION_POLICY_VERSION ||
				value.sourceFingerprint !== ref.sourceFingerprint ||
				value.expiresAt !== ref.expiresAt ||
				!Number.isSafeInteger(value.capturedAt) ||
				value.capturedAt < 0 ||
				value.capturedAt > this.now() ||
				value.expiresAt !== value.capturedAt + SNAPSHOT_TTL_SECONDS * 1000 ||
				typeof value.description !== "string" ||
				!value.description.trim() ||
				!isSheetStructure(value.structuredSheet) ||
				value.structuredSheet.status !== "ready" ||
				(await sha256(serialized)) !== ref.snapshotId ||
				(await sha256(value.description)) !== value.descriptionDigest ||
				(await sha256(JSON.stringify(contentOf(value)))) !==
					value.contentDigest ||
				readMemberRecords(value.structuredSheet, ref.sourceFingerprint)
					.status !== "ready"
			) {
				return { status: "unavailable", reason: "invalid_snapshot" };
			}
			if (this.now() >= ref.expiresAt)
				return { status: "unavailable", reason: "expired" };
			return { status: "ready", snapshot: value };
		} catch {
			return { status: "unavailable", reason: "invalid_snapshot" };
		}
	}
}
