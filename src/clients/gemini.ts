import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

export class GeminiClient {
	private llm: GoogleGenerativeAI;

	constructor(apiKey: string) {
		this.llm = new GoogleGenerativeAI(apiKey);
	}

	async ask(input: string, sheet: string) {
		const model = this.llm.getGenerativeModel({
			model: 'gemini-1.5-pro',
		});

		const chatSession = model.startChat({
			generationConfig,
			safetySettings,
			history: [
				{
					role: 'user',
					parts: [
						{
							text: `【中国のアイドルグループSNH48の基本情報】
							次にSNH48グループに関する情報を伝えます。SNH48は中国のアイドルグループで、SNH48(上海)、BEJ48(北京)、GNZ48(広州)、CKG48(重慶)、CGT48(成都)に分かれて活動しています。
							それぞれのグループには複数のチームがあります。
							SNH48には現在以下のチームが存在します。
							teamSII,teamNII,teamHII,teamX
							BEJ48には以下のチームが存在します。
							teamB,teamE
							BEJ48には過去にはteamJが存在しましたが、現在は存在しません。
							GNZ48には以下のチームが存在します。
							teamG,teamNIII,teamZ
							CKG48には以下のチームが存在します。
							teamC,teamK
							CGT48には以下のチームが存在します。
							teamCII,teamGII
							`,
						},
						{
							text: `${sheet}`,
						},
						{
							text: `先のは中国のアイドルグループSNH48グループのメンバーに関する情報のスプレッドシートをCSV形式で表現したものです。まずはこのシートの見方を伝えます。
							A列は所属チームです。
							B列は我々がメンバーに付けているあだ名です。
							C列はメンバーの名前です。
							D列はメンバーの名前のピンイン表記です。
							E列はメンバーの現在の年齢です。
							Q列は誕生日です。
							R列は入団した日付です。
							T列は出身です。
							U列は身長です。
							さて、あなたは苏杉杉になりきってください。そして、以上の情報とスプレッドシートの情報をを元に質問に回答してください。
							質問に答える時はまず、メンバーについて問われている場合はメンバーの名前を、チームについて問われている場合はチーム名を、グループについて問われている場合はグループ名に属する情報を読み取って回答してください。
							回答するときは現代日本のちょっと痛めのJDのような口調にしつつ簡潔に質問にだけ短く回答すること。
							回答に人名が含まれる場合はちゃん付けではなく、さん付けにすること。
							さらに、メンバーの中国語名を出力する時は簡体字で回答し、ピンインも付記してください。`,
						},
					],
				},
			],
		});

		const result = await chatSession.sendMessage(input);
		return result.response.text();
	}
}

const generationConfig = {
	temperature: 1,
	topP: 0.95,
	topK: 64,
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
