import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	DeliveredIdRepository,
	MAX_DELIVERED_IDS,
	mergeDeliveredIds,
} from "./deliveredIds";

const createMockKVNamespace = () =>
	({
		get: vi.fn(),
		put: vi.fn(),
	}) as unknown as KVNamespace;

describe("mergeDeliveredIds", () => {
	it("dedupes keeping the most recent position", () => {
		expect(mergeDeliveredIds(["a", "b", "c"], ["a", "d"])).toEqual([
			"b",
			"c",
			"a",
			"d",
		]);
	});

	it("drops non-string, empty and over-long IDs", () => {
		const added = [1, null, "", "x".repeat(257), "ok", "y".repeat(256)];
		expect(mergeDeliveredIds([], added as unknown as string[])).toEqual([
			"ok",
			"y".repeat(256),
		]);
	});

	it("caps the set keeping the newest IDs", () => {
		const ids = Array.from(
			{ length: MAX_DELIVERED_IDS + 5 },
			(_, index) => `id-${index}`,
		);
		const merged = mergeDeliveredIds([], ids);
		expect(merged).toHaveLength(MAX_DELIVERED_IDS);
		expect(merged[0]).toBe("id-5");
		expect(merged.at(-1)).toBe(`id-${MAX_DELIVERED_IDS + 4}`);
	});
});

describe("DeliveredIdRepository", () => {
	let kv: KVNamespace;
	let repository: DeliveredIdRepository;

	beforeEach(() => {
		kv = createMockKVNamespace();
		repository = new DeliveredIdRepository(kv, 600);
	});

	it("reads the stored IDs from the versioned key", async () => {
		(kv.get as Mock).mockResolvedValue({ version: 1, ids: ["a", "b"] });
		await expect(repository.get("conv")).resolves.toEqual(["a", "b"]);
		expect(kv.get).toHaveBeenCalledWith("chat_delivered:v1:conv", "json");
	});

	it.each([
		["missing", null],
		["an invalid version", { version: 2, ids: ["a"] }],
		["a non-array ids field", { version: 1, ids: "a" }],
	])("returns an empty list for %s", async (_name, value) => {
		(kv.get as Mock).mockResolvedValue(value);
		await expect(repository.get("conv")).resolves.toEqual([]);
	});

	it("returns an empty list when KV fails", async () => {
		(kv.get as Mock).mockRejectedValue(new Error("kv down"));
		await expect(repository.get("conv")).resolves.toEqual([]);
	});

	it("saves the versioned payload with the constructor TTL", async () => {
		await repository.save("conv", ["a", "b", "a"]);
		expect(kv.put).toHaveBeenCalledWith(
			"chat_delivered:v1:conv",
			'{"version":1,"ids":["b","a"]}',
			{ expirationTtl: 600 },
		);
	});
});
