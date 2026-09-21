/**
 * Stable column contract shared by the sheet snapshot, local identity index,
 * and the future Jev column router.
 *
 * sourceIndex is the column position in the parsed source CSV. It is never an
 * index into compactSheetCsv's projected TSV.
 */
export type SheetColumnDefinition = {
	key: string;
	sourceIndex: number;
	label: string;
	description: string;
};

const IDENTITY_COLUMNS = [
	{
		key: "full_name",
		sourceIndex: 7,
		label: "姓名",
		description: "メンバーの名前",
	},
	{
		key: "pinyin",
		sourceIndex: 8,
		label: "ピンイン",
		description: "メンバー名のピンイン表記",
	},
	{
		key: "initials",
		sourceIndex: 10,
		label: "イニシャル",
		description: "メンバー名のイニシャル",
	},
	{
		key: "community_nicknames",
		sourceIndex: 11,
		label: "我々のあだ名",
		description: "我々がメンバーに付けたあだ名",
	},
] as const satisfies readonly SheetColumnDefinition[];

const SELECTABLE_COLUMNS = [
	{
		key: "primary_affiliation",
		sourceIndex: 3,
		label: "本所属",
		description: "メンバーの主な所属チーム",
	},
	{
		key: "secondary_affiliation",
		sourceIndex: 4,
		label: "兼任先",
		description: "メンバーが兼任している別のチーム",
	},
	{
		key: "newcomer_flag",
		sourceIndex: 5,
		label: "新人組フラグ",
		description: "新人組のメンバーかどうか",
	},
	{
		key: "age",
		sourceIndex: 9,
		label: "年齢",
		description: "現在の年齢",
	},
	{
		key: "nickname_origin",
		sourceIndex: 12,
		label: "あだ名の由来",
		description: "我々が付けたあだ名の由来",
	},
	{
		key: "birthday",
		sourceIndex: 13,
		label: "誕生日",
		description: "生年月日・誕生日",
	},
	{
		key: "debut_date",
		sourceIndex: 14,
		label: "出道日",
		description: "デビュー・加入した日",
	},
	{
		key: "generation",
		sourceIndex: 15,
		label: "期数",
		description: "何期生か",
	},
	{
		key: "height",
		sourceIndex: 16,
		label: "身長",
		description: "身長",
	},
	{
		key: "zodiac",
		sourceIndex: 17,
		label: "星座",
		description: "星座",
	},
	{
		key: "birth_province",
		sourceIndex: 18,
		label: "出身省",
		description: "出身地の省",
	},
	{
		key: "birth_city",
		sourceIndex: 19,
		label: "出身市",
		description: "出身地の市区",
	},
	{
		key: "skills",
		sourceIndex: 20,
		label: "特徴",
		description: "特技・スキル・特徴",
	},
	{
		key: "hobbies",
		sourceIndex: 21,
		label: "趣味",
		description: "趣味",
	},
	{
		key: "catchphrase",
		sourceIndex: 22,
		label: "キャッチフレーズ",
		description: "キャッチフレーズ",
	},
	{
		key: "official_nickname",
		sourceIndex: 23,
		label: "公式ニックネーム",
		description: "公式プロフィールのニックネーム。我々のあだ名とは別",
	},
	{
		key: "official_english_name",
		sourceIndex: 24,
		label: "公式英語名",
		description: "公式英語名",
	},
	{
		key: "university",
		sourceIndex: 25,
		label: "大学",
		description: "在籍・卒業した大学",
	},
	{
		key: "blood_type",
		sourceIndex: 26,
		label: "血液型",
		description: "血液型",
	},
	{
		key: "mbti",
		sourceIndex: 27,
		label: "MBTI",
		description: "MBTI",
	},
	{
		key: "debut_age",
		sourceIndex: 28,
		label: "出道時年齢",
		description: "デビュー・加入時の年齢",
	},
	{
		key: "pocket_followers",
		sourceIndex: 29,
		label: "口袋48フォロワー数",
		description: "口袋48のフォロワー数",
	},
	{
		key: "support_color_1",
		sourceIndex: 30,
		label: "応援色1",
		description: "1つ目の応援色",
	},
	{
		key: "support_color_1_detail",
		sourceIndex: 31,
		label: "応援色1詳細",
		description: "1つ目の応援色の詳しい表現",
	},
	{
		key: "support_color_2",
		sourceIndex: 32,
		label: "応援色2",
		description: "2つ目の応援色",
	},
	{
		key: "support_color_2_detail",
		sourceIndex: 33,
		label: "応援色2詳細",
		description: "2つ目の応援色の詳しい表現",
	},
	{
		key: "election_2014",
		sourceIndex: 34,
		label: "2014年総選挙順位",
		description: "2014年の総選挙順位",
	},
	{
		key: "election_2015",
		sourceIndex: 35,
		label: "2015年総選挙順位",
		description: "2015年の総選挙順位",
	},
	{
		key: "election_2016",
		sourceIndex: 36,
		label: "2016年総選挙順位",
		description: "2016年の総選挙順位",
	},
	{
		key: "election_2017",
		sourceIndex: 37,
		label: "2017年総選挙順位",
		description: "2017年の総選挙順位",
	},
	{
		key: "election_2018",
		sourceIndex: 38,
		label: "2018年総選挙順位",
		description: "2018年の総選挙順位",
	},
	{
		key: "election_2019",
		sourceIndex: 39,
		label: "2019年総選挙順位",
		description: "2019年の総選挙順位",
	},
	{
		key: "election_2020",
		sourceIndex: 40,
		label: "2020年総選挙順位",
		description: "2020年の総選挙順位",
	},
	{
		key: "election_2021",
		sourceIndex: 41,
		label: "2021年総選挙順位",
		description: "2021年の総選挙順位",
	},
	{
		key: "election_2022",
		sourceIndex: 42,
		label: "2022年総選挙順位",
		description: "2022年の総選挙順位",
	},
	{
		key: "election_2023",
		sourceIndex: 43,
		label: "2023年総選挙順位",
		description: "2023年の総選挙順位",
	},
	{
		key: "election_2024",
		sourceIndex: 44,
		label: "2024年総選挙順位",
		description: "2024年の総選挙順位",
	},
	{
		key: "election_2025",
		sourceIndex: 45,
		label: "2025年総選挙順位",
		description: "2025年の総選挙順位",
	},
	{
		key: "election_2026",
		sourceIndex: 46,
		label: "2026年総選挙順位",
		description: "2026年の総選挙順位",
	},
	{
		key: "career",
		sourceIndex: 47,
		label: "経歴",
		description: "加入、移籍、昇格、卒業などの活動履歴",
	},
] as const satisfies readonly SheetColumnDefinition[];

export const COLUMN_CATALOG_VERSION = 1 as const;
export const IDENTITY_COLUMN_CATALOG = IDENTITY_COLUMNS;
export const SELECTABLE_COLUMN_CATALOG = SELECTABLE_COLUMNS;
export const SHEET_COLUMN_CATALOG = [
	...IDENTITY_COLUMNS,
	...SELECTABLE_COLUMNS,
] as const;

export type IdentityColumnKey = (typeof IDENTITY_COLUMNS)[number]["key"];
export type SelectableColumnKey = (typeof SELECTABLE_COLUMNS)[number]["key"];
export type SheetColumnKey = (typeof SHEET_COLUMN_CATALOG)[number]["key"];

export const SHEET_COLUMN_KEYS = SHEET_COLUMN_CATALOG.map(
	(column) => column.key,
) as SheetColumnKey[];

export const SHEET_SOURCE_INDICES = SHEET_COLUMN_CATALOG.map(
	(column) => column.sourceIndex,
) as number[];
