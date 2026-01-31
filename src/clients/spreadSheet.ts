import { GoogleSpreadsheet } from 'google-spreadsheet';
import GoogleAuth, { GoogleKey } from 'cloudflare-workers-and-google-oauth';

// スプレッドシートのID
const DOC_ID = '1sPOk2XqSB3ZB-O0eKl2ZkKYVr_OgvVCZX0xS79FTNfg';

// 定数を上部にまとめる
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SHEET_NAME = 'test';

// スプレッドシートの情報を取得するためのシート
// A1セルにスプレッドシートの説明が入っている
const DESCRIPTION_SHEET_NAME = 'description';

// Helper to parse and validate service account JSON
function parseServiceAccount(serviceAccountJson: string): GoogleKey {
	try {
		const parsed = JSON.parse(serviceAccountJson);

		// Validate required fields
		if (!parsed.client_email || !parsed.private_key) {
			throw new Error('Service account JSON missing required fields (client_email, private_key)');
		}

		return parsed as GoogleKey;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error('Invalid service account JSON format');
		}
		throw error;
	}
}

// Helper to authenticate with Google
async function authenticateGoogle(serviceAccountJson: string): Promise<string> {
	try {
		const googleAuth = parseServiceAccount(serviceAccountJson);
		const oauth = new GoogleAuth(googleAuth, GOOGLE_SCOPES);
		const token = await oauth.getGoogleAuthToken();

		if (!token) {
			throw new Error('Failed to obtain Google auth token');
		}

		return token;
	} catch (error) {
		console.error('Google authentication error:', error);
		throw new Error(`Google authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

// スプレッドシートの情報を取得する関数
// serviceAccountJson: Google Service Accountの認証情報(JSON形式の文字列)
// 戻り値: スプレッドシートの内容をCSV形式で返す
export const getSheetInfo = async function (serviceAccountJson: string): Promise<string> {
	try {
		const token = await authenticateGoogle(serviceAccountJson);
		const doc = new GoogleSpreadsheet(DOC_ID, { token });

		// Load document info
		try {
			await doc.loadInfo();
		} catch (error) {
			console.error('Failed to load spreadsheet info:', error);
			throw new Error('スプレッドシートへのアクセスに失敗しました。権限を確認してください。');
		}

		// Get sheet by name
		const sheet = doc.sheetsByTitle[SHEET_NAME];
		if (!sheet) {
			throw new Error(`Sheet "${SHEET_NAME}" not found in spreadsheet`);
		}

		// Load header and download CSV
		try {
			await sheet.loadHeaderRow(2);
			const csvBuffer = await sheet.downloadAsCSV();
			const csvContent = new TextDecoder().decode(csvBuffer);

			if (!csvContent || csvContent.trim().length === 0) {
				throw new Error('Sheet returned empty CSV data');
			}

			return csvContent;
		} catch (error) {
			console.error('Failed to download sheet as CSV:', error);
			throw new Error('シートデータのダウンロードに失敗しました。');
		}
	} catch (error) {
		// Preserve user-friendly errors, wrap others
		if (error instanceof Error && (error.message.includes('スプレッドシート') || error.message.includes('シート'))) {
			throw error;
		}

		console.error('Unexpected error in getSheetInfo:', error);
		throw new Error('スプレッドシート情報の取得中にエラーが発生しました。');
	}
};

// スプレッドシートのdescriptionを取得する関数
// serviceAccountJson: Google Service Accountの認証情報(JSON形式の文字列)
// 戻り値: スプレッドシートのdescriptionを返す
export const getSheetDescription = async function (serviceAccountJson: string): Promise<string> {
	try {
		const token = await authenticateGoogle(serviceAccountJson);
		const doc = new GoogleSpreadsheet(DOC_ID, { token });

		// Load document info
		try {
			await doc.loadInfo();
		} catch (error) {
			console.error('Failed to load spreadsheet info:', error);
			throw new Error('スプレッドシートへのアクセスに失敗しました。権限を確認してください。');
		}

		// Get description sheet
		const sheet = doc.sheetsByTitle[DESCRIPTION_SHEET_NAME];
		if (!sheet) {
			console.warn(`Description sheet "${DESCRIPTION_SHEET_NAME}" not found, using empty description`);
			return '';
		}

		// Load cell and get description
		try {
			await sheet.loadCells('A1');
			const cell = sheet.getCellByA1('A1');
			return cell.value?.toString() || '';
		} catch (error) {
			console.error('Failed to load description cell:', error);
			// Non-fatal: return empty description
			return '';
		}
	} catch (error) {
		// Preserve user-friendly errors
		if (error instanceof Error && error.message.includes('スプレッドシート')) {
			throw error;
		}

		console.error('Unexpected error in getSheetDescription:', error);
		// Description is optional, return empty on error
		return '';
	}
};
