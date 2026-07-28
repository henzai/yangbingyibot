export const DISCORD_CONTENT_LIMIT = 2000;
const PREFERRED_BOUNDARY_MIN_FILL_RATIO = 0.8;

export function formatAnswer(question: string, answer: string): string {
	return `> ${question}\n${answer}`;
}

export function formatThinking(question: string, summary: string): string {
	return `> ${question}\n:thought_balloon: ${summary}`;
}

export function formatError(question: string, errorMessage: string): string {
	return `> ${question}\n:rotating_light: エラーが発生しました: ${errorMessage}`;
}

function safeCodePointBoundary(content: string, end: number): number {
	if (end <= 0 || end >= content.length) {
		return end;
	}

	const previous = content.charCodeAt(end - 1);
	const next = content.charCodeAt(end);
	const splitsSurrogatePair =
		previous >= 0xd800 &&
		previous <= 0xdbff &&
		next >= 0xdc00 &&
		next <= 0xdfff;

	return splitsSurrogatePair ? end - 1 : end;
}

/**
 * Split Discord content without dropping delimiters or splitting a Unicode code
 * point. The limit is measured in UTF-16 code units, which is the conservative
 * interpretation of Discord's content limit.
 */
export function splitContent(
	content: string,
	limit = DISCORD_CONTENT_LIMIT,
): string[] {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError("Discord content limit must be a positive integer");
	}
	if (content.length === 0) {
		return [];
	}

	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > limit) {
		const hardBoundary = safeCodePointBoundary(remaining, limit);
		if (hardBoundary === 0) {
			throw new RangeError(
				"Discord content limit is too small for the first Unicode code point",
			);
		}

		const lastNewline = remaining.lastIndexOf("\n", hardBoundary - 1);
		const lastSpace = remaining.lastIndexOf(" ", hardBoundary - 1);
		const minimumPreferredBoundary = Math.floor(
			hardBoundary * PREFERRED_BOUNDARY_MIN_FILL_RATIO,
		);
		const splitAt =
			lastNewline >= 0 && lastNewline + 1 >= minimumPreferredBoundary
				? lastNewline + 1
				: lastSpace >= 0 && lastSpace + 1 >= minimumPreferredBoundary
					? lastSpace + 1
					: hardBoundary;

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);
	}

	if (remaining.length > 0) {
		chunks.push(remaining);
	}

	return chunks;
}
