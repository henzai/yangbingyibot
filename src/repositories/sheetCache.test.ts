import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SpreadsheetConfig } from "../config";
import { SheetCacheRepository } from "./sheetCache";

const SOURCE: SpreadsheetConfig = {
	id: "spreadsheet-id",
	dataSheetName: "data",
	descriptionSheetName: "description",
};

const STRUCTURE = {
	status: "unavailable" as const,
	schemaVersion: 1 as const,
	catalogVersion: 1 as const,
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

	it("throws a stable error when KV save fails", async () => {
		(mockKV.put as Mock).mockRejectedValue(new Error("KV unavailable"));

		await expect(
			repository.save(SOURCE, "sheet", "description"),
		).rejects.toThrow("Failed to save cache data");
	});
});
