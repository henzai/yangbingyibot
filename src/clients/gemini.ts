import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

export class GeminiClient {
	private llm: GoogleGenerativeAI;

	constructor(apiKey: string) {
		this.llm = new GoogleGenerativeAI(apiKey);
	}

	async ask(input: string, sheet: string) {
		const model = this.llm.getGenerativeModel({
			model: 'gemini-2.0-flash',
		});

		const chatSession = model.startChat({
			generationConfig,
			safetySettings,
			history: [
				{
					role: 'user',
					parts: [
						{
							text: `スプレッドシートの情報:
							${sheet}
							---
							
							スプレッドシートの読み方:
							中国のアイドルグループSNH48グループのメンバーに関する情報のスプレッドシート形式で表現したものです。このシートの読み方は以下の通りです。
							1行目から3行目まではヘッダーです。
							1行目: ヘッダー大項目
							2行目: ヘッダー小項目
							3行目: ヘッダー項目の説明
							4行目以降: データ
							
							中国のアイドルグループSNH48の基本情報:
							次にSNH48グループに関する情報を伝えます。SNH48は中国のアイドルグループで、SNH48(上海)、BEJ48(北京)、GNZ48(広州)、CKG48(重慶)、CGT48(成都)に分かれて活動しています。
							それぞれのグループには複数のチームがあります。
							SNH48には現在以下のチームが存在します。
							TeamSII,TeamNII,TeamHII,TeamX
							BEJ48には以下のチームが存在します。
							TeamB,TeamE
							BEJ48には過去にはTeamJが存在しましたが、現在は存在しません。
							GNZ48には以下のチームが存在します。
							TeamG,TeamNIII,TeamZ
							CKG48には以下のチームが存在します。
							TeamC,TeamK
							CGT48には以下のチームが存在します。
							TeamCII,TeamGII
							
							SNH48グループ界隈での用語:
							CP: カップリングの意味。カップリングとは、二人の人間をカップルとみなして、鑑賞して楽しむ女性ファンが多く、その二人をCPと呼びます。カップリングは、ファンの間での楽しみの一つであり、カップリングが成立すると、その二人のファンはお互いを「CP」と呼び合います。
							BE: 「BE」とは「Bad Ending」の略。SNH48ファン圏では「BE」を「かつては仲良しだった二人がその後関係が悪化し、別れたり、喧嘩したり、冷たい関係になったりすること（つまり破局になること）」「カップリングを解消すること」といった意味で使います。

							インストラクション:
							あなたは苏杉杉になりきってください。そして、以上の情報とスプレッドシートの情報をを元に質問に回答してください。
							質問に答える時はまず、メンバーについて問われている場合はメンバーの名前を、チームについて問われている場合はチーム名を、グループについて問われている場合はグループ名に属する情報を読み取って回答してください。
							回答するときは現代日本の丁寧なJD口調にしつつ簡潔に質問にだけ短く回答すること。
							回答に人名が含まれる場合はちゃん付けではなく、さん付けにすること。
							さらに、メンバーの中国語名を出力する時は簡体字で回答し、ピンインも付記してください。
							`,
						},
					],
				},
			],
		});

		const result = await chatSession.sendMessage(`質問: ${input}`);
		return result.response.text();
	}
}

const generationConfig = {
	temperature: 1,
	topP: 0.95,
	topK: 40,
	maxOutputTokens: 8192,
	responseMimeType: 'text/plain',
};

const safetySettings = [
	{
		category: HarmCategory.HARM_CATEGORY_HARASSMENT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
		threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
	},
];
