import type { HistoryEntry } from "../contracts";
import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const HISTORY_KEY_PREFIX = "chat_history:v2:";
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_BYTES = 64 * 1024;

function isHistoryEntry(value: unknown): value is HistoryEntry {
	if (!value || typeof value !== "object") {
		return false;
	}

	const entry = value as Record<string, unknown>;
	return (
		(entry.role === "user" || entry.role === "model") &&
		typeof entry.text === "string"
	);
}

function historyKey(conversationKey: string): string {
	return `${HISTORY_KEY_PREFIX}${conversationKey}`;
}

function constrainHistory(history: HistoryEntry[]): HistoryEntry[] {
	const entries = history
		.slice(-MAX_HISTORY_ENTRIES)
		.map(({ role, text }) => ({ role, text }));

	while (
		entries.length > 0 &&
		new TextEncoder().encode(JSON.stringify(entries)).byteLength >
			MAX_HISTORY_BYTES
	) {
		entries.shift();
	}

	return entries;
}

export class ConversationHistoryRepository {
	constructor(
		private readonly kv: KVNamespace,
		private readonly historyTtlSeconds: number,
		private readonly log: Logger = defaultLogger,
	) {}

	async get(conversationKey: string): Promise<HistoryEntry[]> {
		try {
			const parsedHistory = await this.kv.get<unknown>(
				historyKey(conversationKey),
				"json",
			);
			if (!parsedHistory) {
				return [];
			}

			if (!Array.isArray(parsedHistory)) {
				this.log.warn("History data is not an array, returning empty array");
				return [];
			}

			return parsedHistory
				.filter(isHistoryEntry)
				.map(({ role, text }) => ({ role, text }));
		} catch (error) {
			this.log.error("Failed to get history from KV", {
				error: getErrorMessage(error),
			});
			return [];
		}
	}

	async save(conversationKey: string, history: HistoryEntry[]): Promise<void> {
		try {
			const constrainedHistory = constrainHistory(history);
			await this.kv.put(
				historyKey(conversationKey),
				JSON.stringify(constrainedHistory),
				{ expirationTtl: this.historyTtlSeconds },
			);
		} catch (error) {
			this.log.error("Failed to save history to KV", {
				error: getErrorMessage(error),
			});
			throw new Error("Failed to save conversation history");
		}
	}
}

export function createConversationHistoryRepository(
	kv: KVNamespace,
	historyTtlSeconds: number,
	log?: Logger,
): ConversationHistoryRepository {
	return new ConversationHistoryRepository(kv, historyTtlSeconds, log);
}
