import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

// Separate from chat_history:v2 so the history format and readers stay unchanged.
const DELIVERED_KEY_PREFIX = "chat_delivered:v1:";
export const MAX_DELIVERED_IDS = 2000;
const MAX_ID_LENGTH = 256;

type StoredDeliveredIds = { version: 1; ids: string[] };

function deliveredKey(conversationKey: string): string {
	return `${DELIVERED_KEY_PREFIX}${conversationKey}`;
}

/** Keep the most recent occurrence of each ID, oldest first, within the cap. */
export function mergeDeliveredIds(
	previous: readonly string[],
	added: readonly string[],
): string[] {
	const merged = new Map<string, true>();
	for (const id of [...previous, ...added]) {
		if (typeof id !== "string" || !id || id.length > MAX_ID_LENGTH) continue;
		merged.delete(id);
		merged.set(id, true);
	}
	return [...merged.keys()].slice(-MAX_DELIVERED_IDS);
}

/**
 * Source-scoped member IDs whose rows were confirmed delivered to Discord by
 * code-rendered answers. Previews, attempts and model text never add IDs.
 */
export class DeliveredIdRepository {
	constructor(
		private readonly kv: KVNamespace,
		private readonly ttlSeconds: number,
		private readonly log: Logger = defaultLogger,
	) {}

	async get(conversationKey: string): Promise<string[]> {
		try {
			const value = await this.kv.get<unknown>(
				deliveredKey(conversationKey),
				"json",
			);
			if (!value) return [];
			const record = value as Partial<StoredDeliveredIds>;
			if (record.version !== 1 || !Array.isArray(record.ids)) {
				this.log.warn("Delivered ID data is invalid, ignoring it");
				return [];
			}
			return mergeDeliveredIds([], record.ids);
		} catch (error) {
			this.log.error("Failed to get delivered IDs from KV", {
				error: getErrorMessage(error),
			});
			return [];
		}
	}

	async save(conversationKey: string, ids: readonly string[]): Promise<void> {
		const stored: StoredDeliveredIds = {
			version: 1,
			ids: mergeDeliveredIds([], ids),
		};
		await this.kv.put(deliveredKey(conversationKey), JSON.stringify(stored), {
			expirationTtl: this.ttlSeconds,
		});
	}
}

export function createDeliveredIdRepository(
	kv: KVNamespace,
	ttlSeconds: number,
	log?: Logger,
): DeliveredIdRepository {
	return new DeliveredIdRepository(kv, ttlSeconds, log);
}
