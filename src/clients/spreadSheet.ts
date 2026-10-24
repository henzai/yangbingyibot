import GoogleAuth, {
	type GoogleKey,
} from "cloudflare-workers-and-google-oauth";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { DEFAULT_RUNTIME_CONFIG, type SpreadsheetConfig } from "../config";
import { compactSheetCsv } from "../utils/compactSheet";
import {
	ExternalServiceError,
	getExternalErrorLogContext,
	normalizeExternalServiceError,
} from "../utils/errors";
import { logger as defaultLogger, type Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SHEETS_RETRY_CONFIG = {
	maxAttempts: 3,
	initialDelayMs: 500,
	maxDelayMs: 5000,
	backoffMultiplier: 2,
};

async function executeSheetsRequest<T>(
	operation: string,
	userMessage: string,
	log: Logger,
	request: () => Promise<T>,
): Promise<T> {
	return withRetry(
		async () => {
			try {
				return await request();
			} catch (error) {
				throw normalizeExternalServiceError(error, {
					service: "sheets",
					operation,
					userMessage,
				});
			}
		},
		SHEETS_RETRY_CONFIG,
		undefined,
		log,
	);
}

// Helper to parse and validate service account JSON
function parseServiceAccount(serviceAccountJson: string): GoogleKey {
	try {
		const parsed = JSON.parse(serviceAccountJson);

		// Validate required fields
		if (!parsed.client_email || !parsed.private_key) {
			throw new ExternalServiceError({
				service: "sheets",
				operation: "validate service account",
				retryable: false,
				userMessage: "Google認証設定が不正です。",
			});
		}

		return parsed as GoogleKey;
	} catch (error) {
		if (error instanceof ExternalServiceError) {
			throw error;
		}
		throw new ExternalServiceError({
			service: "sheets",
			operation: "parse service account",
			retryable: false,
			userMessage: "Google認証設定が不正です。",
			cause: error,
		});
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
		const token = await executeSheetsRequest(
			"authenticate",
			"Google認証に失敗しました。",
			log,
			async () => await oauth.getGoogleAuthToken(),
		);

		if (!token) {
			throw new ExternalServiceError({
				service: "sheets",
				operation: "authenticate",
				retryable: false,
				userMessage: "Google認証に失敗しました。",
			});
		}

		return token;
	} catch (error) {
		log.error("Google authentication error", {
			...getExternalErrorLogContext(error),
		});
		throw normalizeExternalServiceError(error, {
			service: "sheets",
			operation: "authenticate",
			retryable: false,
			userMessage: "Google認証に失敗しました。",
		});
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
		throw new ExternalServiceError({
			service: "sheets",
			operation: "resolve data sheet",
			retryable: false,
			userMessage: "指定されたシートが見つかりません。",
		});
	}

	try {
		const csvBuffer = await executeSheetsRequest(
			"download data sheet",
			"シートデータのダウンロードに失敗しました。",
			log,
			async () => {
				await sheet.loadHeaderRow(2);
				return sheet.downloadAsCSV();
			},
		);
		const csvContent = new TextDecoder().decode(csvBuffer);

		if (!csvContent || csvContent.trim().length === 0) {
			throw new ExternalServiceError({
				service: "sheets",
				operation: "validate data sheet",
				retryable: false,
				userMessage: "シートデータが空です。",
			});
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
			...getExternalErrorLogContext(error),
		});
		throw normalizeExternalServiceError(error, {
			service: "sheets",
			operation: "download data sheet",
			userMessage: "シートデータのダウンロードに失敗しました。",
		});
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
		await executeSheetsRequest(
			"load description sheet",
			"シート説明の取得に失敗しました。",
			log,
			async () => await sheet.loadCells("A1"),
		);
		const cell = sheet.getCellByA1("A1");
		return cell.value?.toString() || "";
	} catch (error) {
		log.warn("Failed to load description cell", {
			...getExternalErrorLogContext(error),
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
		await executeSheetsRequest(
			"load spreadsheet",
			"スプレッドシートへのアクセスに失敗しました。権限を確認してください。",
			logger,
			async () => await doc.loadInfo(),
		);

		// Fetch both sheets in parallel using the same authenticated token
		const [sheetInfo, description] = await Promise.all([
			fetchSheetInfo(doc, source.dataSheetName, logger),
			fetchSheetDescription(doc, source.descriptionSheetName, logger),
		]);

		return { sheetInfo, description };
	} catch (error) {
		if (error instanceof ExternalServiceError) {
			throw error;
		}

		const normalized = normalizeExternalServiceError(error, {
			service: "sheets",
			operation: "get sheet data",
			retryable: false,
			userMessage: "スプレッドシート情報の取得中にエラーが発生しました。",
		});
		logger.error("Unexpected Sheets client error", {
			...getExternalErrorLogContext(normalized),
		});
		throw normalized;
	}
}
