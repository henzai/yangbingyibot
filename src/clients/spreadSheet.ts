import GoogleAuth, {
	type GoogleKey,
} from "cloudflare-workers-and-google-oauth";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { DEFAULT_RUNTIME_CONFIG, type SpreadsheetConfig } from "../config";
import { compactSheetCsv } from "../utils/compactSheet";
import { getErrorMessage } from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Helper to parse and validate service account JSON
function parseServiceAccount(serviceAccountJson: string): GoogleKey {
	try {
		const parsed = JSON.parse(serviceAccountJson);

		// Validate required fields
		if (!parsed.client_email || !parsed.private_key) {
			throw new Error(
				"Service account JSON missing required fields (client_email, private_key)",
			);
		}

		return parsed as GoogleKey;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Invalid service account JSON format");
		}
		throw error;
	}
}

// Helper to authenticate with Google
async function authenticateGoogle(
	serviceAccountJson: string,
	log: Logger,
): Promise<string> {
	try {
		const googleAuth = parseServiceAccount(serviceAccountJson);
		const oauth = new GoogleAuth(googleAuth, GOOGLE_SCOPES);
		const token = await oauth.getGoogleAuthToken();

		if (!token) {
			throw new Error("Failed to obtain Google auth token");
		}

		return token;
	} catch (error) {
		log.error("Google authentication error", {
			error: getErrorMessage(error),
		});
		throw new Error(`Google authentication failed: ${getErrorMessage(error)}`);
	}
}

// Interface for combined sheet data
export interface SheetData {
	sheetInfo: string;
	description: string;
}

// Helper to fetch sheet info from a loaded document
async function fetchSheetInfo(
	doc: GoogleSpreadsheet,
	sheetName: string,
	log: Logger,
): Promise<string> {
	const sheet = doc.sheetsByTitle[sheetName];
	if (!sheet) {
		throw new Error(`Sheet "${sheetName}" not found in spreadsheet`);
	}

	try {
		await sheet.loadHeaderRow(2);
		const csvBuffer = await sheet.downloadAsCSV();
		const csvContent = new TextDecoder().decode(csvBuffer);

		if (!csvContent || csvContent.trim().length === 0) {
			throw new Error("Sheet returned empty CSV data");
		}

		// CSVはGeminiへの入力トークンの大半を占めるため、渡す前に圧縮する
		const compacted = compactSheetCsv(csvContent);
		log.info("Sheet CSV compacted", {
			originalChars: csvContent.length,
			compactedChars: compacted.length,
		});

		return compacted;
	} catch (error) {
		log.error("Failed to download sheet as CSV", {
			error: getErrorMessage(error),
		});
		throw new Error("シートデータのダウンロードに失敗しました。");
	}
}

// Helper to fetch description from a loaded document
async function fetchSheetDescription(
	doc: GoogleSpreadsheet,
	sheetName: string,
	log: Logger,
): Promise<string> {
	const sheet = doc.sheetsByTitle[sheetName];
	if (!sheet) {
		log.warn(
			`Description sheet "${sheetName}" not found, using empty description`,
		);
		return "";
	}

	try {
		await sheet.loadCells("A1");
		const cell = sheet.getCellByA1("A1");
		return cell.value?.toString() || "";
	} catch (error) {
		log.warn("Failed to load description cell", {
			error: getErrorMessage(error),
		});
		return "";
	}
}

// Unified function to fetch both sheet info and description with single authentication
export async function getSheetData(
	serviceAccountJson: string,
	log?: Logger,
	source: SpreadsheetConfig = DEFAULT_RUNTIME_CONFIG.spreadsheet,
): Promise<SheetData> {
	const logger = log ?? defaultLogger;
	try {
		// Authenticate once
		const token = await authenticateGoogle(serviceAccountJson, logger);
		const doc = new GoogleSpreadsheet(source.id, { token });

		// Load document info
		try {
			await doc.loadInfo();
		} catch (error) {
			logger.error("Failed to load spreadsheet info", {
				error: getErrorMessage(error),
			});
			throw new Error(
				"スプレッドシートへのアクセスに失敗しました。権限を確認してください。",
			);
		}

		// Fetch both sheets in parallel using the same authenticated token
		const [sheetInfo, description] = await Promise.all([
			fetchSheetInfo(doc, source.dataSheetName, logger),
			fetchSheetDescription(doc, source.descriptionSheetName, logger),
		]);

		return { sheetInfo, description };
	} catch (error) {
		// Preserve user-friendly errors, wrap others
		if (
			error instanceof Error &&
			(error.message.includes("スプレッドシート") ||
				error.message.includes("シート"))
		) {
			throw error;
		}

		logger.error("Unexpected error in getSheetData", {
			error: getErrorMessage(error),
		});
		throw new Error("スプレッドシート情報の取得中にエラーが発生しました。");
	}
}
