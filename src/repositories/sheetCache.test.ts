import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SpreadsheetConfig } from "../config";
import { SHEET_COLUMN_KEYS } from "../sheets/columnCatalog";
import { SheetSnapshotRepository } from "../sheets/snapshot";
import type { ReadySheetStructure } from "../sheets/structuredSheet";
import { memberFixture } from "../sheets/testFixtures";
import { SheetCacheRepository } from "./sheetCache";

const SOURCE: SpreadsheetConfig = {
	id: "spreadsheet-id",
	dataSheetName: "data",
	descriptionSheetName: "description",
};

const STRUCTURE = {
	status: "unavailable" as const,
	schemaVersion: 2 as const,
	catalogVersion: 2 as const,
	reason: "schema_mismatch" as const,
};

const createMockKVNamespace = () =>
	({
		get: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	}) as unknown as KVNamespace;

describe("SheetCacheRepository", () => {
	let mockKV: KVNamespace;
	let repository: SheetCacheRepository;

	beforeEach(() => {
		vi.clearAllMocks();
		mockKV = createMockKVNamespace();
		repository = new SheetCacheRepository(mockKV);
	});

	it("uses the same source-specific key for get and save", async () => {
		(mockKV.get as Mock).mockResolvedValue(null);

		await repository.get(SOURCE);
		await repository.save(SOURCE, "sheet", "description");

		const getKey = (mockKV.get as Mock).mock.calls[0][0] as string;
		const putKey = (mockKV.put as Mock).mock.calls[0][0] as string;
		expect(getKey).toBe(putKey);
		expect(getKey).toMatch(/^sheet_info:v2:[0-9a-f]{64}$/);
		expect(mockKV.get).not.toHaveBeenCalledWith("sheet_info", "json");
	});

	it.each([
		["spreadsheet id", { ...SOURCE, id: "other-id" }],
		["data sheet", { ...SOURCE, dataSheetName: "other-data" }],
		[
			"description sheet",
			{ ...SOURCE, descriptionSheetName: "other-description" },
		],
	])("misses cache when the %s changes", async (_name, changedSource) => {
		(mockKV.get as Mock).mockResolvedValue(null);

		await repository.get(SOURCE);
		await repository.get(changedSource);

		const firstKey = (mockKV.get as Mock).mock.calls[0][0];
		const secondKey = (mockKV.get as Mock).mock.calls[1][0];
		expect(firstKey).not.toBe(secondKey);
	});

	it("returns a validated cache entry", async () => {
		(mockKV.get as Mock).mockResolvedValue({
			sheetInfo: "sheet",
			description: "description",
			extra: "removed",
		});

		await expect(repository.get(SOURCE)).resolves.toEqual({
			sheetInfo: "sheet",
			description: "description",
		});
	});

	it("returns null for invalid data or a KV failure", async () => {
		(mockKV.get as Mock).mockResolvedValueOnce({ sheetInfo: 123 });
		await expect(repository.get(SOURCE)).resolves.toBeNull();

		(mockKV.get as Mock).mockRejectedValueOnce(new Error("KV unavailable"));
		await expect(repository.get(SOURCE)).resolves.toBeNull();
	});

	it("keeps a valid structured status alongside legacy fields", async () => {
		(mockKV.get as Mock).mockResolvedValue({
			sheetInfo: "sheet",
			description: "description",
			structuredSheet: STRUCTURE,
		});

		await expect(repository.get(SOURCE)).resolves.toEqual({
			sheetInfo: "sheet",
			description: "description",
			structuredSheet: STRUCTURE,
		});
	});

	it("saves cache with its own TTL", async () => {
		await repository.save(SOURCE, "sheet", "description");

		expect(mockKV.put).toHaveBeenCalledWith(
			expect.stringMatching(/^sheet_info:v2:[0-9a-f]{64}$/),
			JSON.stringify({ sheetInfo: "sheet", description: "description" }),
			{ expirationTtl: 300 },
		);
	});

	it("saves the structured snapshot without changing the key or TTL", async () => {
		await repository.save(SOURCE, "sheet", "description", STRUCTURE);

		expect(mockKV.put).toHaveBeenCalledWith(
			expect.stringMatching(/^sheet_info:v2:[0-9a-f]{64}$/),
			JSON.stringify({
				sheetInfo: "sheet",
				description: "description",
				structuredSheet: STRUCTURE,
			}),
			{ expirationTtl: 300 },
		);
	});

	it("keeps a 500-person structured cache entry within the payload budget", async () => {
		const personRows = Array.from({ length: 500 }, (_, personIndex) =>
			SHEET_COLUMN_KEYS.map(
				(_key, columnIndex) =>
					`member-${personIndex}-column-${columnIndex}-fixture-value`,
			),
		);
		const structuredSheet: ReadySheetStructure = {
			status: "ready",
			schemaVersion: 2,
			catalogVersion: 2,
			columnKeys: [...SHEET_COLUMN_KEYS],
			headerRows: Array.from({ length: 3 }, () =>
				SHEET_COLUMN_KEYS.map((key) => key),
			),
			personRows,
			sourceRowNumbers: personRows.map((_, index) => index + 4),
			availableYears: [],
			latestDataYear: null,
		};
		const sheetInfo = personRows.map((row) => row.join("\t")).join("\n");
		const legacyEntry = JSON.stringify({ sheetInfo, description: "fixture" });

		await repository.save(SOURCE, sheetInfo, "fixture", structuredSheet);

		const serializedEntry = (mockKV.put as Mock).mock.calls[0][1] as string;
		const encoder = new TextEncoder();
		const totalBytes = encoder.encode(serializedEntry).byteLength;
		const addedBytes = totalBytes - encoder.encode(legacyEntry).byteLength;
		expect(totalBytes).toBeLessThan(4 * 1024 * 1024);
		expect(addedBytes).toBeLessThan(2 * 1024 * 1024);
	});

	it("treats malformed structured data as a legacy entry", async () => {
		(mockKV.get as Mock).mockResolvedValue({
			sheetInfo: "sheet",
			description: "description",
			structuredSheet: { status: "ready", schemaVersion: 999 },
		});

		await expect(repository.get(SOURCE)).resolves.toEqual({
			sheetInfo: "sheet",
			description: "description",
		});
	});

	it("refreshes version-one structures while preserving legacy text", async () => {
		(mockKV.get as Mock).mockResolvedValue({
			sheetInfo: "legacy",
			description: "original instructions",
			structuredSheet: { ...STRUCTURE, schemaVersion: 1, catalogVersion: 1 },
		});
		await expect(repository.get(SOURCE)).resolves.toEqual({
			sheetInfo: "legacy",
			description: "original instructions",
		});
	});

	it("pins sheet and description before updating mutable cache, and replays after overwrite", async () => {
		const stored = new Map<string, string>();
		(mockKV.put as Mock).mockImplementation(
			async (key: string, value: string) => {
				stored.set(key, value);
			},
		);
		(mockKV.get as Mock).mockImplementation(
			async (key: string, format: string) => {
				const value = stored.get(key);
				return value === undefined
					? null
					: format === "json"
						? JSON.parse(value)
						: value;
			},
		);
		const ref = await repository.save(
			SOURCE,
			"legacy A",
			"instructions A",
			memberFixture(),
		);
		expect(ref).toBeDefined();
		if (!ref) return;
		expect((mockKV.put as Mock).mock.calls[0][0]).toMatch(
			/^sheet_snapshot:v1:/,
		);
		expect((mockKV.put as Mock).mock.calls[1][0]).toMatch(/^sheet_info:v2:/);
		expect((await repository.get(SOURCE))?.snapshotRef).toEqual(ref);
		await repository.save(
			SOURCE,
			"legacy B",
			"instructions B",
			memberFixture(),
		);
		expect((await repository.get(SOURCE))?.description).toBe("instructions B");
		const replay = await new SheetSnapshotRepository(mockKV).get(SOURCE, ref);
		expect(replay.status).toBe("ready");
		if (replay.status === "ready")
			expect(replay.snapshot.description).toBe("instructions A");
	});

	it("preserves legacy answer data when immutable snapshot writes fail", async () => {
		(mockKV.put as Mock)
			.mockRejectedValueOnce(new Error("snapshot unavailable"))
			.mockResolvedValueOnce(undefined);
		await expect(
			repository.save(SOURCE, "legacy", "instructions", memberFixture()),
		).resolves.toBeUndefined();
		const mutable = JSON.parse((mockKV.put as Mock).mock.calls[1][1]);
		expect(mutable).toMatchObject({
			sheetInfo: "legacy",
			description: "instructions",
		});
		expect(mutable.snapshotRef).toBeUndefined();
	});

	it.each(["source", "expiry", "shape"])(
		"drops a %s-invalid snapshot reference but keeps answer data",
		async (kind) => {
			const ref = await repository.save(
				SOURCE,
				"legacy",
				"instructions",
				memberFixture(),
			);
			if (!ref) throw new Error("Missing fixture reference");
			const invalid = { ...ref };
			if (kind === "source") invalid.sourceFingerprint = "0".repeat(64);
			if (kind === "expiry") invalid.expiresAt = 1;
			if (kind === "shape") invalid.snapshotId = "invalid";
			(mockKV.get as Mock).mockResolvedValue({
				sheetInfo: "legacy",
				description: "instructions",
				structuredSheet: memberFixture(),
				snapshotRef: invalid,
			});
			const entry = await repository.get(SOURCE);
			expect(entry?.sheetInfo).toBe("legacy");
			expect(entry?.snapshotRef).toBeUndefined();
		},
	);

	it("throws a stable error when KV save fails", async () => {
		(mockKV.put as Mock).mockRejectedValue(new Error("KV unavailable"));

		await expect(
			repository.save(SOURCE, "sheet", "description"),
		).rejects.toThrow("Failed to save cache data");
	});
});
