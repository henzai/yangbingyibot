import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { HistoryEntry } from "../contracts";
import { ConversationHistoryRepository } from "./conversationHistory";

const createMockKVNamespace = () =>
	({
		get: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
		list: vi.fn(),
		getWithMetadata: vi.fn(),
	}) as unknown as KVNamespace;

describe("ConversationHistoryRepository", () => {
	let mockKV: KVNamespace;
	let repository: ConversationHistoryRepository;

	beforeEach(() => {
		vi.clearAllMocks();
		mockKV = createMockKVNamespace();
		repository = new ConversationHistoryRepository(mockKV, 600);
	});

	it("isolates histories by conversation key and never reads the legacy key", async () => {
		(mockKV.get as Mock).mockResolvedValue([]);

		await repository.get("conversation-a");
		await repository.get("conversation-b");

		expect(mockKV.get).toHaveBeenNthCalledWith(
			1,
			"chat_history:v2:conversation-a",
			"json",
		);
		expect(mockKV.get).toHaveBeenNthCalledWith(
			2,
			"chat_history:v2:conversation-b",
			"json",
		);
		expect(mockKV.get).not.toHaveBeenCalledWith("chat_history", "json");
	});

	it("saves only the latest 20 entries with the configured TTL", async () => {
		const history: HistoryEntry[] = Array.from({ length: 25 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "model",
			text: `entry-${index}`,
		}));

		await repository.save("conversation", history);

		const [, serialized, options] = (mockKV.put as Mock).mock.calls[0];
		const saved = JSON.parse(serialized) as HistoryEntry[];
		expect(saved).toHaveLength(20);
		expect(saved[0].text).toBe("entry-5");
		expect(saved.at(-1)?.text).toBe("entry-24");
		expect(options).toEqual({ expirationTtl: 600 });
	});

	it("removes oldest entries until serialized UTF-8 data is at most 64 KiB", async () => {
		const history: HistoryEntry[] = [
			{ role: "user", text: "古".repeat(15_000) },
			{ role: "model", text: "新".repeat(15_000) },
		];

		await repository.save("conversation", history);

		const serialized = (mockKV.put as Mock).mock.calls[0][1] as string;
		const saved = JSON.parse(serialized) as HistoryEntry[];
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
			64 * 1024,
		);
		expect(saved).toEqual([{ role: "model", text: "新".repeat(15_000) }]);
	});

	it("stores an empty history when a single entry exceeds 64 KiB", async () => {
		await repository.save("conversation", [
			{ role: "user", text: "x".repeat(70 * 1024) },
		]);

		expect(mockKV.put).toHaveBeenCalledWith(
			"chat_history:v2:conversation",
			"[]",
			{ expirationTtl: 600 },
		);
	});

	it("filters invalid entries read from KV", async () => {
		(mockKV.get as Mock).mockResolvedValue([
			{ role: "user", text: "valid" },
			null,
			{ role: "assistant", text: "invalid role" },
			{ role: "model", text: 123 },
			{ role: "model", text: "also valid", extra: "removed" },
		]);

		await expect(repository.get("conversation")).resolves.toEqual([
			{ role: "user", text: "valid" },
			{ role: "model", text: "also valid" },
		]);
	});

	it("returns an empty history when KV get fails", async () => {
		(mockKV.get as Mock).mockRejectedValue(new Error("KV unavailable"));

		await expect(repository.get("conversation")).resolves.toEqual([]);
	});

	it("throws a stable error when KV save fails", async () => {
		(mockKV.put as Mock).mockRejectedValue(new Error("KV unavailable"));

		await expect(repository.save("conversation", [])).rejects.toThrow(
			"Failed to save conversation history",
		);
	});
});
