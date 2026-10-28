import type {
	DiscordComponentsMessage,
	DiscordMediaGalleryItem,
} from "../clients/discord";

export const GALLERY_MAX_ITEMS = 10;
// Stays within Discord's 40-component limit even if gallery items count.
export const GALLERIES_PER_MESSAGE = 3;
const DESCRIPTION_MAX_LENGTH = 1024;

const IS_COMPONENTS_V2 = 1 << 15;
const MEDIA_GALLERY_TYPE = 12;

// RFC 3986 URL characters, with parentheses only as balanced pairs, so the
// closing ")" of a Markdown link and full-width punctuation around a URL are
// not part of the match.
const URL_SOURCE =
	"https?:\\/\\/(?:[A-Za-z0-9\\-._~:/?#[\\]@!$&'*+,;=%]|\\([A-Za-z0-9\\-._~:/?#[\\]@!$&'*+,;=%]*\\))+";
const URL_PATTERN = new RegExp(URL_SOURCE, "g");
// Discord does not render Markdown images, so ![alt](url) shows as "!" + link.
const MARKDOWN_IMAGE_PATTERN = new RegExp(
	`!\\[([^\\]\\n]*)\\]\\(\\s*<?(${URL_SOURCE})>?\\s*\\)[ \\t]*`,
	"g",
);
// A line left with only a list marker after its image was removed.
const EMPTY_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*$/;
const TRAILING_PUNCTUATION = /[.,;:!?'*]+$/;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

export interface GalleryImage {
	url: string;
	description?: string;
}

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

/**
 * Collect image URLs for a gallery in the order they appear, without
 * duplicates, and remove Markdown images from the text. The alt text of a
 * Markdown image becomes the gallery item's description.
 */
export function extractImages(text: string): {
	text: string;
	images: GalleryImage[];
} {
	const descriptions = new Map<string, string | undefined>();
	for (const match of text.matchAll(URL_PATTERN)) {
		const candidate = trimTrailingPunctuation(match[0]);
		if (isImageUrl(candidate) && !descriptions.has(candidate)) {
			descriptions.set(candidate, undefined);
		}
	}

	const lines = text.split("\n").flatMap((line) => {
		let removed = false;
		const rest = line.replace(
			MARKDOWN_IMAGE_PATTERN,
			(match, alt: string, url: string) => {
				if (!isImageUrl(url)) {
					return match;
				}
				const description = alt.trim().slice(0, DESCRIPTION_MAX_LENGTH);
				if (description && descriptions.get(url) === undefined) {
					descriptions.set(url, description);
				}
				removed = true;
				return "";
			},
		);
		if (!removed) {
			return [line];
		}
		return EMPTY_LINE.test(rest) ? [] : [rest.trimEnd()];
	});

	return {
		text: lines.join("\n"),
		images: [...descriptions].map(([url, description]) =>
			description ? { url, description } : { url },
		),
	};
}

/** Wrap URLs in <> so Discord does not render a link preview for each. */
export function suppressLinkEmbeds(text: string): string {
	return text.replace(URL_PATTERN, (match, offset: number) => {
		if (text[offset - 1] === "<") {
			return match;
		}
		const candidate = trimTrailingPunctuation(match);
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

/** Media Gallery messages holding every image, 10 per gallery. */
export function buildGalleryMessages(
	images: readonly GalleryImage[],
): DiscordComponentsMessage[] {
	const galleries = chunk(images, GALLERY_MAX_ITEMS).map((group) => ({
		type: MEDIA_GALLERY_TYPE,
		items: group.map(
			({ url, description }): DiscordMediaGalleryItem =>
				description ? { media: { url }, description } : { media: { url } },
		),
	}));
	return chunk(galleries, GALLERIES_PER_MESSAGE).map((components) => ({
		flags: IS_COMPONENTS_V2,
		components,
	}));
}

/**
 * Plain links to the images in gallery messages, for when Discord rejects
 * them. Without this, Markdown images removed from the text would be lost.
 */
export function buildGalleryFallbackText(
	messages: readonly DiscordComponentsMessage[],
): string {
	return messages
		.flatMap((message) => message.components)
		.flatMap((gallery) => gallery.items)
		.map(({ media, description }) =>
			description
				? `[${description.replace(/[[\]]/g, "\\$&")}](<${media.url}>)`
				: `<${media.url}>`,
		)
		.join("\n");
}
