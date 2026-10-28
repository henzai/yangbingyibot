import { describe, expect, it } from "vitest";
import {
	buildGalleryMessages,
	extractImageUrls,
	suppressImageEmbeds,
} from "./images";

const image = (sid: number) =>
	`https://www.snh48.com/images/member/zp_${sid}.jpg`;

describe("extractImageUrls", () => {
	it("finds image URLs by path extension in order", () => {
		const text = [
			`唐果さん ${image(1)}`,
			"https://example.com/a.PNG?size=large",
			"https://example.com/b.webp",
			"https://example.com/c.gif",
			"https://example.com/d.jpeg",
		].join("\n");

		expect(extractImageUrls(text)).toEqual([
			image(1),
			"https://example.com/a.PNG?size=large",
			"https://example.com/b.webp",
			"https://example.com/c.gif",
			"https://example.com/d.jpeg",
		]);
	});

	it("ignores pages, other schemes, and extensions outside the path", () => {
		const text = [
			"https://www.snh48.com/member_details.html?sid=1#SNH",
			"https://example.com/view?file=a.jpg",
			"ftp://example.com/a.jpg",
			"https://example.com/a.jpg.html",
		].join("\n");

		expect(extractImageUrls(text)).toEqual([]);
	});

	it("removes duplicates", () => {
		expect(extractImageUrls(`${image(1)} ${image(2)} ${image(1)}`)).toEqual([
			image(1),
			image(2),
		]);
	});

	it("excludes surrounding punctuation and Markdown syntax", () => {
		const text = [
			`[画像](${image(1)})`,
			`<${image(2)}>`,
			`画像：${image(3)}。`,
			`(${image(4)}), ${image(5)}.`,
			`**${image(6)}**`,
		].join("\n");

		expect(extractImageUrls(text)).toEqual([
			image(1),
			image(2),
			image(3),
			image(4),
			image(5),
			image(6),
		]);
	});
});

describe("suppressImageEmbeds", () => {
	it("wraps bare and Markdown-linked image URLs in angle brackets", () => {
		expect(suppressImageEmbeds(`唐果さん ${image(1)}`)).toBe(
			`唐果さん <${image(1)}>`,
		);
		expect(suppressImageEmbeds(`[画像](${image(1)})`)).toBe(
			`[画像](<${image(1)}>)`,
		);
		expect(suppressImageEmbeds(`${image(1)}.`)).toBe(`<${image(1)}>.`);
	});

	it("leaves wrapped image URLs and non-image URLs unchanged", () => {
		const text = `<${image(1)}> https://www.snh48.com/member_details.html?sid=1#SNH`;

		expect(suppressImageEmbeds(text)).toBe(text);
	});
});

describe("buildGalleryMessages", () => {
	const urls = (count: number) =>
		Array.from({ length: count }, (_, index) => image(index + 1));
	const shape = (count: number) =>
		buildGalleryMessages(urls(count)).map((message) =>
			message.components.map((gallery) => gallery.items.length),
		);

	it("builds Components V2 Media Gallery messages", () => {
		expect(buildGalleryMessages([image(1), image(2)])).toEqual([
			{
				flags: 1 << 15,
				components: [
					{
						type: 12,
						items: [{ media: { url: image(1) } }, { media: { url: image(2) } }],
					},
				],
			},
		]);
	});

	it("puts 10 images per gallery and 3 galleries per message", () => {
		expect(shape(0)).toEqual([]);
		expect(shape(1)).toEqual([[1]]);
		expect(shape(10)).toEqual([[10]]);
		expect(shape(11)).toEqual([[10, 1]]);
		expect(shape(30)).toEqual([[10, 10, 10]]);
		expect(shape(31)).toEqual([[10, 10, 10], [1]]);
	});

	it("keeps every URL in order", () => {
		const delivered = buildGalleryMessages(urls(31)).flatMap((message) =>
			message.components.flatMap((gallery) =>
				gallery.items.map((item) => item.media.url),
			),
		);

		expect(delivered).toEqual(urls(31));
	});
});
