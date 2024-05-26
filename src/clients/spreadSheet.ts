import { GoogleSpreadsheet } from 'google-spreadsheet';
import GoogleAuth, { GoogleKey } from 'cloudflare-workers-and-google-oauth';

const DOC_ID = '1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg';

export const getSheetInfo = async function (sa: string) {
	const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
	const googleAuth: GoogleKey = JSON.parse(sa);

	const oauth = new GoogleAuth(googleAuth, scopes);
	const token = await oauth.getGoogleAuthToken();
	const doc = new GoogleSpreadsheet(DOC_ID, { token: token || '' });
	await doc.loadInfo();

	const sheet = doc.sheetsByIndex[0];
	const rows = await sheet.getRows();

	let csvContent = '';

	rows.forEach((row) => {
		const rowValues = Object.values(row).map((cell) =>
			// セル内にカンマが含まれる場合はダブルクォートで囲む
			cell.toString().includes(',') ? `"${cell}"` : cell
		);
		csvContent += rowValues.slice(0, 22).join(',') + '\n'; // A列からV列まで
	});

	return csvContent;
};
