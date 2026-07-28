import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DeduplicationStore } from "./deduplicationStore";

const createMockKVNamespace = () =>
	({
		get: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	}) as unknown as KVNamespace;

describe("DeduplicationStore", () => {
	let mockKV: KVNamespace;
	let store: DeduplicationStore;

	beforeEach(() => {
		vi.clearAllMocks();
		mockKV = createMockKVNamespace();
		store = new DeduplicationStore(mockKV);
	});

	it("reports whether a key is marked", async () => {
		(mockKV.get as Mock).mockResolvedValueOnce("1").mockResolvedValueOnce(null);

		await expect(store.isMarked("first")).resolves.toBe(true);
		await expect(store.isMarked("second")).resolves.toBe(false);
	});

	it("marks a key with the requested TTL", async () => {
		await store.mark("error_reported:fingerprint", 3600);

		expect(mockKV.put).toHaveBeenCalledWith("error_reported:fingerprint", "1", {
			expirationTtl: 3600,
		});
	});
});
