import type { SpreadsheetConfig } from "../config";
import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const SHEET_CACHE_KEY_PREFIX = "sheet_info:v2:";
const SHEET_CACHE_TTL_SECONDS = 5 * 60;

export type SheetCacheEntry = {
	sheetInfo: string;
	description: string;
};

async function sourceFingerprint(source: SpreadsheetConfig): Promise<string> {
	const material = [
		source.id,
		source.dataSheetName,
		source.descriptionSheetName,
	].join("\n");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function cacheKey(source: SpreadsheetConfig): Promise<string> {
	return `${SHEET_CACHE_KEY_PREFIX}${await sourceFingerprint(source)}`;
}

export class SheetCacheRepository {
	constructor(
		private readonly kv: KVNamespace,
		private readonly log: Logger = defaultLogger,
	) {}

	async get(source: SpreadsheetConfig): Promise<SheetCacheEntry | null> {
		try {
			const cachedData = await this.kv.get<unknown>(
				await cacheKey(source),
				"json",
			);
			if (!cachedData) {
				return null;
			}

			if (
				typeof cachedData !== "object" ||
				typeof (cachedData as Record<string, unknown>).sheetInfo !== "string" ||
				typeof (cachedData as Record<string, unknown>).description !== "string"
			) {
				this.log.warn("Invalid cache data structure, ignoring cache");
				return null;
			}

			const entry = cachedData as SheetCacheEntry;
			return {
				sheetInfo: entry.sheetInfo,
				description: entry.description,
			};
		} catch (error) {
			this.log.error("Failed to get cache from KV", {
				error: getErrorMessage(error),
			});
			return null;
		}
	}

	async save(
		source: SpreadsheetConfig,
		sheetInfo: string,
		description: string,
	): Promise<void> {
		try {
			const entry: SheetCacheEntry = { sheetInfo, description };
			await this.kv.put(await cacheKey(source), JSON.stringify(entry), {
				expirationTtl: SHEET_CACHE_TTL_SECONDS,
			});
		} catch (error) {
			this.log.error("Failed to save cache to KV", {
				error: getErrorMessage(error),
			});
			throw new Error("Failed to save cache data");
		}
	}
}

export function createSheetCacheRepository(
	kv: KVNamespace,
	log?: Logger,
): SheetCacheRepository {
	return new SheetCacheRepository(kv, log);
}
