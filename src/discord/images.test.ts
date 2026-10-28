import { describe, expect, it } from "vitest";
import {
	buildGalleryFallbackText,
	buildGalleryMessages,
	extractImages,
	suppressLinkEmbeds,
} from "./images";

const image = (sid: number) =>
	`https://www.snh48.com/images/member/zp_${sid}.jpg`;
const page = (sid: number) =>
	`https://www.snh48.com/member_details.html?sid=${sid}#SNH`;
const urlsOf = (text: string) =>
	extractImages(text).images.map((item) => item.url);

describe("extractImages", () => {
	it("finds image URLs by path extension in order", () => {
		const text = [
			`唐果さん ${image(1)}`,
			"https://example.com/a.PNG?size=large",
			"https://example.com/b.webp",
			"https://example.com/c.gif",
			"https://example.com/d.jpeg",
		].join("\n");

		expect(urlsOf(text)).toEqual([
			image(1),
			"https://example.com/a.PNG?size=large",
			"https://example.com/b.webp",
			"https://example.com/c.gif",
			"https://example.com/d.jpeg",
		]);
	});

	it("ignores pages, other schemes, and extensions outside the path", () => {
		const text = [
			page(1),
			"https://example.com/view?file=a.jpg",
			"ftp://example.com/a.jpg",
			"https://example.com/a.jpg.html",
		].join("\n");

		expect(urlsOf(text)).toEqual([]);
	});

	it("removes duplicates", () => {
		expect(urlsOf(`${image(1)} ${image(2)} ${image(1)}`)).toEqual([
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

		expect(urlsOf(text)).toEqual([
			image(1),
			image(2),
			image(3),
			image(4),
			image(5),
			image(6),
		]);
	});

	it("keeps balanced parentheses inside a URL", () => {
		const inQuery = "https://example.com/a.jpg?crop=(10,20)";
		const inPath = "https://upload.wikimedia.org/x/Foo_(bar).jpg";

		expect(urlsOf(`${inQuery} [画像](${inPath})`)).toEqual([inQuery, inPath]);
	});

	it("moves Markdown images out of the text with their alt text", () => {
		const text = [
			"Team NII メンバー",
			`- ![胡晓慧](${image(1)}) [胡晓慧（Hú Xiǎohuì）さん](${page(1)})`,
			`- ![潘瑛琪](<${image(2)}>) [潘瑛琪（Pān Yīngqí）さん](${page(2)})`,
		].join("\n");

		expect(extractImages(text)).toEqual({
			text: [
				"Team NII メンバー",
				`- [胡晓慧（Hú Xiǎohuì）さん](${page(1)})`,
				`- [潘瑛琪（Pān Yīngqí）さん](${page(2)})`,
			].join("\n"),
			images: [
				{ url: image(1), description: "胡晓慧" },
				{ url: image(2), description: "潘瑛琪" },
			],
		});
	});

	it("drops lines left empty after their image is removed", () => {
		const text = [
			"一覧",
			`- ![胡晓慧](${image(1)})`,
			`![](${image(2)})`,
			"",
			"以上です。",
		].join("\n");

		expect(extractImages(text)).toEqual({
			text: ["一覧", "", "以上です。"].join("\n"),
			images: [{ url: image(1), description: "胡晓慧" }, { url: image(2) }],
		});
	});

	it("keeps bare image URLs and non-image Markdown images in the text", () => {
		const text = `写真 ${image(1)} ![ページ](${page(1)})`;

		expect(extractImages(text)).toEqual({
			text,
			images: [{ url: image(1) }],
		});
	});
});

describe("suppressLinkEmbeds", () => {
	it("wraps bare and Markdown-linked URLs in angle brackets", () => {
		expect(suppressLinkEmbeds(`唐果さん ${image(1)}`)).toBe(
			`唐果さん <${image(1)}>`,
		);
		expect(suppressLinkEmbeds(`[唐果さん](${page(1)})`)).toBe(
			`[唐果さん](<${page(1)}>)`,
		);
		expect(suppressLinkEmbeds(`${page(1)}.`)).toBe(`<${page(1)}>.`);
	});

	it("wraps the whole URL when it contains parentheses", () => {
		const url = "https://example.com/a.jpg?crop=(10,20)";

		expect(suppressLinkEmbeds(`画像 ${url}`)).toBe(`画像 <${url}>`);
		expect(suppressLinkEmbeds(`[画像](${url})`)).toBe(`[画像](<${url}>)`);
	});

	it("leaves wrapped URLs unchanged", () => {
		const text = `<${image(1)}> [ページ](<${page(1)}>)`;

		expect(suppressLinkEmbeds(text)).toBe(text);
	});
});

describe("buildGalleryMessages", () => {
	const images = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ url: image(index + 1) }));
	const shape = (count: number) =>
		buildGalleryMessages(images(count)).map((message) =>
			message.components.map((gallery) => gallery.items.length),
		);

	it("builds Components V2 Media Gallery messages with descriptions", () => {
		expect(
			buildGalleryMessages([
				{ url: image(1), description: "胡晓慧" },
				{ url: image(2) },
			]),
		).toEqual([
			{
				flags: 1 << 15,
				components: [
					{
						type: 12,
						items: [
							{ media: { url: image(1) }, description: "胡晓慧" },
							{ media: { url: image(2) } },
						],
					},
				],
			},
		]);
	});

	it("puts 9 images per gallery and 3 galleries per message", () => {
		expect(shape(0)).toEqual([]);
		expect(shape(1)).toEqual([[1]]);
		expect(shape(9)).toEqual([[9]]);
		expect(shape(10)).toEqual([[9, 1]]);
		expect(shape(27)).toEqual([[9, 9, 9]]);
		expect(shape(28)).toEqual([[9, 9, 9], [1]]);
	});

	it("keeps every image in order", () => {
		const delivered = buildGalleryMessages(images(31)).flatMap((message) =>
			message.components.flatMap((gallery) =>
				gallery.items.map((item) => item.media.url),
			),
		);

		expect(delivered).toEqual(images(31).map((item) => item.url));
	});
});

describe("buildGalleryFallbackText", () => {
	it("lists every gallery image as a link without a preview", () => {
		const messages = buildGalleryMessages([
			{ url: image(1), description: "胡晓慧" },
			{ url: image(2), description: "[a] b" },
			{ url: image(3) },
		]);

		expect(buildGalleryFallbackText(messages)).toBe(
			[
				`[胡晓慧](<${image(1)}>)`,
				`[\\[a\\] b](<${image(2)}>)`,
				`<${image(3)}>`,
			].join("\n"),
		);
	});
});
