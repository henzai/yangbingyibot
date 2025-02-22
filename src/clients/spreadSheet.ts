import { GoogleSpreadsheet } from 'google-spreadsheet';
import GoogleAuth, { GoogleKey } from 'cloudflare-workers-and-google-oauth';

// スプレッドシートのID
const DOC_ID = '1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg';

// 定数を上部にまとめる
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SHEET_NAME = 'test';

// スプレッドシートの情報を取得するためのシート
// A1セルにスプレッドシートの説明が入っている
const DESCRIPTION_SHEET_NAME = 'description';

// スプレッドシートの情報を取得する関数
// serviceAccountJson: Google Service Accountの認証情報(JSON形式の文字列)
// 戻り値: スプレッドシートの内容をCSV形式で返す
export const getSheetInfo = async function (serviceAccountJson: string): Promise<string> {
	const googleAuth: GoogleKey = JSON.parse(serviceAccountJson);
	const oauth = new GoogleAuth(googleAuth, GOOGLE_SCOPES);
	const token = await oauth.getGoogleAuthToken();
	const doc = new GoogleSpreadsheet(DOC_ID, { token: token || '' });
	await doc.loadInfo();

	const sheet = doc.sheetsByTitle[SHEET_NAME];
	await sheet.loadHeaderRow();

	const csvBuffer = await sheet.downloadAsCSV();
	const csvContent = new TextDecoder().decode(csvBuffer);

	return csvContent;
};

// スプレッドシートの情報を取得する関数
// serviceAccountJson: Google Service Accountの認証情報(JSON形式の文字列)
// 戻り値: スプレッドシートの内容をCSV形式で返す
export const getSheetDescription = async function (serviceAccountJson: string): Promise<string> {
	const googleAuth: GoogleKey = JSON.parse(serviceAccountJson);
	const oauth = new GoogleAuth(googleAuth, GOOGLE_SCOPES);
	const token = await oauth.getGoogleAuthToken();
	const doc = new GoogleSpreadsheet(DOC_ID, { token: token || '' });
	await doc.loadInfo();
	const sheet = doc.sheetsByTitle[DESCRIPTION_SHEET_NAME];
	await sheet.loadCells('A1');
	const cell = sheet.getCell(0, 0);
	return cell.value?.toString() || '';
};
