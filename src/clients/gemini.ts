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
							一行目は無視して、2行目をヘッダーとして扱います。以下の説明は3行目以降のデータについて説明します。
							先のは中国のアイドルグループSNH48グループのメンバーに関する情報のスプレッドシートをCSV形式で表現したものです。まずはこのシートの読み方を伝えます。
							A列(公演队)はメンバーが主に活動しているチームを示しています。例えば、本所属はGNZ48 teamNIIIでも、メインで活動しているのはSNH48 teamSIIの場合はSNH48 teamSIIと記載されています。
							B列(本所属)はメンバーの本所属チームを示しています。
							C列(兼任)はメンバーのチーム兼任情報を示しています。メンバーが本所属チーム以外に兼任している場合はそのチーム名が記載されています。
							D列(あだ名)は我々がメンバーに付けているあだ名を表します。
							E列(姓名)はメンバーの名前です。
							F列の情報は参照しないでください。
							G列(生日)はメンバーの誕生日です。
							H列(年龄)はメンバーの現在の年齢です。
							I列(身高)はメンバーの身長です。
							J列(出道)はメンバーがデビューした日付です。
							K列(出道时)はメンバーがデビューした時の年齢です。
							L列(期数)はメンバーが入団した期数を示します。例えば、"SNH 4th"はSNH48グループの4期生を示します。
							M列からS列はメンバーの所属したチームの情報です。例えば、最初にBEJ48 TeamBにいて、その後SNH48 TeamSIIに移籍した場合はBEJ48 TeamBとSNH48 TeamSIIが記載されています。M列からS列まで最大で7回の所属の変遷が記載されています。
							T列からAD列は総選挙の結果情報です。ヘッダ行が総選挙の年度で、各行がその年度の総選挙の結果を示しています。例えば、AC列(2023)は第10回総選挙の結果を示しています。10回総選挙のことは10选と中国語で呼ばれることもあります。9选は第9回総選挙のことです。0や空欄はその年度の総選挙ではランクインしていないことを示します。括弧内の数字は当時在籍していたグループの中での順位を示します。例えば、GNZ48在籍者で"21(8)"はSNH48グループ全体の中で21位で、在籍グループでは8位だったことを示します。
							AE列(出身省)はメンバーの出身地です。ピンイン表記で書かれています。例: "Hebei", "Henan"
							AF列(出身市)はメンバーの出身地の市区を示します。ピンイン表記で書かれています。例: "Shijiazhuang", "Zhengzhou"
							AG列(大学)はメンバーが在籍している、もしくは卒業した大学を示します。
							AH列(キーワード)はメンバーの備考情報を示します。
							AI列(あだ名の由来)はメンバーのあだ名の由来を示します。
							
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
