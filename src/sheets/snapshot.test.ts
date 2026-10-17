import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpreadsheetConfig } from "../config";
import { SHEET_COLUMN_KEYS } from "./columnCatalog";
import {
	type SheetSnapshotRef,
	SheetSnapshotRepository,
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_TTL_SECONDS,
} from "./snapshot";
import { sha256 } from "./sourceFingerprint";
import { memberFixture } from "./testFixtures";

const SOURCE: SpreadsheetConfig = {
	id: "fixture-sheet",
	dataSheetName: "members",
	descriptionSheetName: "description",
};

describe("immutable sheet snapshots", () => {
	let data: Map<string, string>;
	let kv: KVNamespace;
	let now: number;
	let repository: SheetSnapshotRepository;

	beforeEach(() => {
		data = new Map();
		kv = {
			get: vi.fn(async (key: string) => data.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => {
				data.set(key, value);
			}),
		} as unknown as KVNamespace;
		now = 1_800_000_000_000;
		repository = new SheetSnapshotRepository(kv, () => now);
	});

	async function capture(
		description = "Artificial role instructions",
	): Promise<SheetSnapshotRef> {
		const result = await repository.capture(
			SOURCE,
			memberFixture(),
			description,
		);
		if (result.status !== "ready") throw new Error(result.reason);
		return result.ref;
	}

	it("replays A after a newer sheet/description B is captured", async () => {
		const a = await capture();
		now += 300_000;
		const sheetB = memberFixture();
		sheetB.personRows[0][SHEET_COLUMN_KEYS.indexOf("full_name")] = "架空更新名";
		const b = await repository.capture(SOURCE, sheetB, "Updated instructions");
		expect(b.status).toBe("ready");
		if (b.status !== "ready") return;
		const old = await repository.get(SOURCE, a);
		const current = await repository.get(SOURCE, b.ref);
		expect(old.status).toBe("ready");
		expect(current.status).toBe("ready");
		if (old.status !== "ready" || current.status !== "ready") return;
		expect(old.snapshot.description).toBe("Artificial role instructions");
		expect(old.snapshot.structuredSheet.personRows[0][0]).toBe("架空同名");
		expect(current.snapshot.description).toBe("Updated instructions");
		expect(current.snapshot.structuredSheet.personRows[0][0]).toBe(
			"架空更新名",
		);
		expect(a.snapshotId).not.toBe(b.ref.snapshotId);
		expect(
			vi
				.mocked(kv.get)
				.mock.calls.every(([key]) =>
					String(key).startsWith("sheet_snapshot:v1:"),
				),
		).toBe(true);
	});

	it("separates content digest from capture time and uses absolute expiration", async () => {
		const a = await capture();
		now += 1000;
		const b = await capture();
		const old = await repository.get(SOURCE, a);
		const current = await repository.get(SOURCE, b);
		if (old.status !== "ready" || current.status !== "ready")
			throw new Error("Missing fixture snapshot");
		expect(a.snapshotId).not.toBe(b.snapshotId);
		expect(old.snapshot.contentDigest).toBe(current.snapshot.contentDigest);
		expect(vi.mocked(kv.put).mock.calls[0][2]).toEqual({
			expiration: a.expiresAt / 1000,
		});
		expect(a.expiresAt - old.snapshot.capturedAt).toBe(
			SNAPSHOT_TTL_SECONDS * 1000,
		);
	});

	it("copies input before awaits and loaded objects do not mutate storage", async () => {
		const sheet = memberFixture();
		const pending = repository.capture(SOURCE, sheet, "Instructions");
		sheet.personRows[0][0] = "Modified by caller";
		const result = await pending;
		if (result.status !== "ready") throw new Error(result.reason);
		const loaded = await repository.get(SOURCE, result.ref);
		if (loaded.status !== "ready") throw new Error(loaded.reason);
		expect(loaded.snapshot.structuredSheet.personRows[0][0]).toBe("架空同名");
		loaded.snapshot.structuredSheet.personRows[0][0] = "Modified read";
		const reloaded = await repository.get(SOURCE, result.ref);
		if (reloaded.status !== "ready") throw new Error(reloaded.reason);
		expect(reloaded.snapshot.structuredSheet.personRows[0][0]).toBe("架空同名");
	});

	it("rejects another source before reading KV", async () => {
		const ref = await capture();
		await expect(
			repository.get({ ...SOURCE, descriptionSheetName: "other" }, ref),
		).resolves.toEqual({ status: "unavailable", reason: "source_mismatch" });
		expect(kv.get).not.toHaveBeenCalled();
	});

	it("reports missing, expired and storage failures without substituting latest", async () => {
		const ref = await capture();
		data.clear();
		await expect(repository.get(SOURCE, ref)).resolves.toEqual({
			status: "unavailable",
			reason: "not_found",
		});
		vi.mocked(kv.get).mockRejectedValueOnce(
			new Error("sensitive provider body"),
		);
		await expect(repository.get(SOURCE, ref)).resolves.toEqual({
			status: "unavailable",
			reason: "storage_error",
		});
		now = ref.expiresAt;
		await expect(repository.get(SOURCE, ref)).resolves.toEqual({
			status: "unavailable",
			reason: "expired",
		});
	});

	it.each(["description", "row", "version", "json"])(
		"rejects corrupted %s",
		async (field) => {
			const ref = await capture();
			const [key, original] = [...data.entries()][0];
			const value = JSON.parse(original);
			if (field === "description") value.description = "Wrong instructions";
			if (field === "row")
				value.structuredSheet.personRows[0][0] = "Wrong member";
			if (field === "version") value.normalizationVersion = 999;
			data.set(key, field === "json" ? "{" : JSON.stringify(value));
			await expect(repository.get(SOURCE, ref)).resolves.toEqual({
				status: "unavailable",
				reason: "invalid_snapshot",
			});
		},
	);

	it("rejects mismatched expiration references and oversized persisted data", async () => {
		const ref = await capture();
		await expect(
			repository.get(SOURCE, { ...ref, expiresAt: ref.expiresAt + 1000 }),
		).resolves.toEqual({ status: "unavailable", reason: "invalid_snapshot" });
		data.set([...data.keys()][0], "x".repeat(SNAPSHOT_MAX_BYTES + 1));
		await expect(repository.get(SOURCE, ref)).resolves.toEqual({
			status: "unavailable",
			reason: "too_large",
		});
	});

	it("validates inner description/content digests even with a matching envelope hash", async () => {
		const ref = await capture();
		const original = JSON.parse([...data.values()][0]);
		original.description = "Changed without digest";
		const serialized = JSON.stringify(original);
		const altered = { ...ref, snapshotId: await sha256(serialized) };
		data.set(
			`sheet_snapshot:v1:${ref.sourceFingerprint}:${altered.snapshotId}`,
			serialized,
		);
		await expect(repository.get(SOURCE, altered)).resolves.toEqual({
			status: "unavailable",
			reason: "invalid_snapshot",
		});
	});

	it("will not publish a reference for empty instructions, duplicate SID, oversized data or failed writes", async () => {
		await expect(
			repository.capture(SOURCE, memberFixture(), " "),
		).resolves.toEqual({
			status: "unavailable",
			reason: "missing_description",
		});
		const duplicate = memberFixture();
		duplicate.personRows[1][SHEET_COLUMN_KEYS.indexOf("sid")] = "101";
		await expect(
			repository.capture(SOURCE, duplicate, "Instructions"),
		).resolves.toEqual({ status: "unavailable", reason: "invalid_identity" });
		await expect(
			repository.capture(
				SOURCE,
				memberFixture(),
				"x".repeat(SNAPSHOT_MAX_BYTES),
			),
		).resolves.toEqual({ status: "unavailable", reason: "too_large" });
		expect(kv.put).not.toHaveBeenCalled();
		vi.mocked(kv.put).mockRejectedValueOnce(
			new Error("private provider error"),
		);
		await expect(
			repository.capture(SOURCE, memberFixture(), "Instructions"),
		).resolves.toEqual({ status: "unavailable", reason: "storage_error" });
	});
});
