import type { SpreadsheetConfig } from "../config";

export async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Preserve the existing source-scoped cache namespace. Never log source IDs. */
export function sourceFingerprint(source: SpreadsheetConfig): Promise<string> {
	return sha256(
		[source.id, source.dataSheetName, source.descriptionSheetName].join("\n"),
	);
}
