import { GoogleSpreadsheet } from 'google-spreadsheet';
import GoogleAuth, { GoogleKey } from 'cloudflare-workers-and-google-oauth';

const DOC_ID = '1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg';

// KV用のキー
const SHEET_INFO = 'sheet_info';

// KV用のキャッシュの型
type SheetInfo = {
	// キャッシュした時間
	time: number;
	sheetInfo: string;
};

export const getSheetInfo = async function (sa: string, kv: KVNamespace): Promise<string> {
	// キャッシュを取得
	const cachedSheetInfo = await kv.get<SheetInfo>(SHEET_INFO);
	if (cachedSheetInfo) {
		// 5分以内のデータの場合はキャッシュを返す
		if (Date.now() - cachedSheetInfo.time < 1000 * 60 * 5) {
			return cachedSheetInfo.sheetInfo;
		}
	}

	// キャッシュがない場合はスプレッドシートからデータを取得
	const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
	const googleAuth: GoogleKey = JSON.parse(sa);

	const oauth = new GoogleAuth(googleAuth, scopes);
	const token = await oauth.getGoogleAuthToken();
	const doc = new GoogleSpreadsheet(DOC_ID, { token: token || '' });
	await doc.loadInfo();

	const sheet = doc.sheetsByTitle['2024改'];
	await sheet.loadHeaderRow(2);

	const sss = await sheet.downloadAsCSV();
	/// sssを文字列に変換してtttに代入
	const ttt = new TextDecoder().decode(sss);

	// キャッシュを保存
	await kv.put(SHEET_INFO, JSON.stringify({ time: Date.now(), sheetInfo: ttt }));

	return ttt;
	// const rows = await sheet.getRows();

	// let csvContent = '';

	// rows.forEach((row, index) => {
	// 	// 最初の行をスキップ
	// 	// if (index === 0) return;

	// 	const rowValues = Object.values(row).map((cell, i) => {
	// 		if (index < 5) {
	// 			console.log(`index: ${index}, i: ${i}, cell: ${cell}`);
	// 		}

	// 		// セル内にカンマが含まれる場合はダブルクォートで囲む
	// 		cell.toString().includes(',') ? `"${cell}"` : cell;
	// 	});

	// 	csvContent += rowValues.slice(0, 33).join(',') + '\n'; // A列からAG列まで
	// });

	// console.log(csvContent);

	// return csvContent;
};
