import { GoogleSpreadsheet } from 'google-spreadsheet';
import GoogleAuth, { GoogleKey } from 'cloudflare-workers-and-google-oauth';

// スプレッドシートのID
const DOC_ID = '1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg';

// 定数を上部にまとめる
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SHEET_NAME = '2024改';

export const getSheetInfo = async function (serviceAccountJson: string): Promise<string> {
	const googleAuth: GoogleKey = JSON.parse(serviceAccountJson);
	const oauth = new GoogleAuth(googleAuth, GOOGLE_SCOPES);
	const token = await oauth.getGoogleAuthToken();
	const doc = new GoogleSpreadsheet(DOC_ID, { token: token || '' });
	await doc.loadInfo();

	const sheet = doc.sheetsByTitle[SHEET_NAME];
	await sheet.loadHeaderRow(2);

	const csvBuffer = await sheet.downloadAsCSV();
	const csvContent = new TextDecoder().decode(csvBuffer);

	return csvContent;
};
