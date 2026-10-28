import type { DiscordComponentsMessage } from "../clients/discord";

export const MIN_GALLERY_IMAGES = 2;
export const GALLERY_MAX_ITEMS = 10;
// Stays within Discord's 40-component limit even if gallery items count.
export const GALLERIES_PER_MESSAGE = 3;

const IS_COMPONENTS_V2 = 1 << 15;
const MEDIA_GALLERY_TYPE = 12;

// RFC 3986 URL characters, with parentheses only as balanced pairs, so the
// closing ")" of a Markdown link and full-width punctuation around a URL are
// not part of the match.
const URL_PATTERN =
	/https?:\/\/(?:[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]|\([A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]*\))+/g;
const TRAILING_PUNCTUATION = /[.,;:!?'*]+$/;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

function trimTrailingPunctuation(candidate: string): string {
	return candidate.replace(TRAILING_PUNCTUATION, "");
}

function isImageUrl(candidate: string): boolean {
	try {
		return IMAGE_EXTENSION.test(new URL(candidate).pathname);
	} catch {
		return false;
	}
}

/** Image URLs in the order they appear, without duplicates. */
export function extractImageUrls(text: string): string[] {
	const urls = new Set<string>();
	for (const match of text.matchAll(URL_PATTERN)) {
		const candidate = trimTrailingPunctuation(match[0]);
		if (isImageUrl(candidate)) {
			urls.add(candidate);
		}
	}
	return [...urls];
}

/** Wrap image URLs in <> so Discord does not render a preview for each. */
export function suppressImageEmbeds(text: string): string {
	return text.replace(URL_PATTERN, (match, offset: number) => {
		const candidate = trimTrailingPunctuation(match);
		if (!isImageUrl(candidate) || text[offset - 1] === "<") {
			return match;
		}
		return `<${candidate}>${match.slice(candidate.length)}`;
	});
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

/** Media Gallery messages holding every URL, 10 per gallery. */
export function buildGalleryMessages(
	urls: readonly string[],
): DiscordComponentsMessage[] {
	const galleries = chunk(urls, GALLERY_MAX_ITEMS).map((group) => ({
		type: MEDIA_GALLERY_TYPE,
		items: group.map((url) => ({ media: { url } })),
	}));
	return chunk(galleries, GALLERIES_PER_MESSAGE).map((components) => ({
		flags: IS_COMPONENTS_V2,
		components,
	}));
}
