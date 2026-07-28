import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";

const mockGetGoogleAuthToken = vi.fn();
const mockLoadInfo = vi.fn();
const mockLoadHeaderRow = vi.fn();
const mockDownloadAsCSV = vi.fn();
const mockLoadCells = vi.fn();
const mockGetCellByA1 = vi.fn();

// vitest 4 は `new` 呼び出し時に実装を Reflect.construct するため、
// コンストラクタとして使うモックの実装はアロー関数にできない（class 式で代用）
vi.mock("cloudflare-workers-and-google-oauth", () => ({
	default: vi.fn(
		class {
			getGoogleAuthToken = mockGetGoogleAuthToken;
		},
	),
}));

vi.mock("google-spreadsheet", () => ({
	GoogleSpreadsheet: vi.fn(
		class {
			loadInfo = mockLoadInfo;
			sheetsByTitle = {};
		},
	),
}));

import { GoogleSpreadsheet } from "google-spreadsheet";
import { getSheetData } from "./spreadSheet";

const validServiceAccount = JSON.stringify({
	client_email: "test@example.com",
	private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
});

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	withContext: vi.fn().mockReturnThis(),
} as unknown as Logger;

function setupSheets(options?: {
	hasTestSheet?: boolean;
	hasDescSheet?: boolean;
	csvContent?: string;
	descValue?: string | null;
	dataSheetName?: string;
	descriptionSheetName?: string;
}) {
	const {
		hasTestSheet = true,
		hasDescSheet = true,
		csvContent = "col1,col2\nval1,val2",
		descValue = "Bot description",
		dataSheetName = "test",
		descriptionSheetName = "description",
	} = options ?? {};

	const sheetsByTitle: Record<string, unknown> = {};

	if (hasTestSheet) {
		sheetsByTitle[dataSheetName] = {
			loadHeaderRow: mockLoadHeaderRow,
			downloadAsCSV: mockDownloadAsCSV,
		};
	}

	if (hasDescSheet) {
		sheetsByTitle[descriptionSheetName] = {
			loadCells: mockLoadCells,
			getCellByA1: mockGetCellByA1,
		};
	}

	mockDownloadAsCSV.mockResolvedValue(new TextEncoder().encode(csvContent));
	mockGetCellByA1.mockReturnValue({ value: descValue });

	const sheets = sheetsByTitle;
	// biome-ignore lint/suspicious/noExplicitAny: overriding mock property
	(GoogleSpreadsheet as any).mockImplementation(
		class {
			loadInfo = mockLoadInfo;
			sheetsByTitle = sheets;
		},
	);
}

describe("spreadSheet", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetGoogleAuthToken.mockResolvedValue("mock-token");
		mockLoadInfo.mockResolvedValue(undefined);
		mockLoadHeaderRow.mockResolvedValue(undefined);
		mockLoadCells.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getSheetData", () => {
		it("returns sheet info and description on success", async () => {
			setupSheets();

			const result = await getSheetData(validServiceAccount, mockLogger);

			// sheetInfoはcompactSheetCsvを通るためTSVで返る
			expect(result).toEqual({
				sheetInfo: "col1\tcol2\nval1\tval2",
				description: "Bot description",
			});
		});

		it("returns empty description when description sheet is missing", async () => {
			setupSheets({ hasDescSheet: false });

			const result = await getSheetData(validServiceAccount, mockLogger);

			expect(result.description).toBe("");
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not found"),
			);
		});

		it("returns empty description when cell value is null", async () => {
			setupSheets({ descValue: null });

			const result = await getSheetData(validServiceAccount, mockLogger);

			expect(result.description).toBe("");
		});

		it("uses the configured spreadsheet and sheet names", async () => {
			setupSheets({
				dataSheetName: "configured-data",
				descriptionSheetName: "configured-description",
			});

			const result = await getSheetData(validServiceAccount, mockLogger, {
				id: "configured-spreadsheet",
				dataSheetName: "configured-data",
				descriptionSheetName: "configured-description",
			});

			expect(GoogleSpreadsheet).toHaveBeenCalledWith("configured-spreadsheet", {
				token: "mock-token",
			});
			expect(result.description).toBe("Bot description");
		});
	});

	describe("parseServiceAccount (via getSheetData)", () => {
		it("throws on invalid JSON", async () => {
			await expect(
				getSheetData("not-json PRIVATE_KEY_SECRET", mockLogger),
			).rejects.toMatchObject({
				service: "sheets",
				operation: "parse service account",
				retryable: false,
				userMessage: "Google認証設定が不正です。",
			});
		});

		it("throws when client_email is missing", async () => {
			await expect(
				getSheetData(JSON.stringify({ private_key: "key" }), mockLogger),
			).rejects.toMatchObject({
				operation: "validate service account",
				retryable: false,
				userMessage: "Google認証設定が不正です。",
			});
		});

		it("throws when private_key is missing", async () => {
			await expect(
				getSheetData(JSON.stringify({ client_email: "a@b.com" }), mockLogger),
			).rejects.toMatchObject({
				operation: "validate service account",
				retryable: false,
				userMessage: "Google認証設定が不正です。",
			});
		});
	});

	describe("authenticateGoogle (via getSheetData)", () => {
		it("throws when token is null", async () => {
			mockGetGoogleAuthToken.mockResolvedValue(null);

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toMatchObject({
				service: "sheets",
				operation: "authenticate",
				retryable: false,
				userMessage: "Google認証に失敗しました。",
			});
		});
	});

	describe("loadInfo failure", () => {
		it("throws user-friendly error when loadInfo fails", async () => {
			setupSheets();
			mockLoadInfo.mockRejectedValue(
				Object.assign(new Error("secret response body"), { status: 403 }),
			);

			const error = await getSheetData(validServiceAccount, mockLogger).catch(
				(caught) => caught,
			);

			expect(error).toBeInstanceOf(ExternalServiceError);
			expect(error).toMatchObject({
				operation: "load spreadsheet",
				status: 403,
				retryable: false,
				userMessage:
					"スプレッドシートへのアクセスに失敗しました。権限を確認してください。",
			});
			expect(error.message).not.toContain("secret response body");
			expect(mockLoadInfo).toHaveBeenCalledTimes(1);
		});

		it("retries a structured 503", async () => {
			vi.useFakeTimers();
			setupSheets();
			mockLoadInfo
				.mockRejectedValueOnce(
					Object.assign(new Error("unavailable"), { status: 503 }),
				)
				.mockResolvedValueOnce(undefined);

			const promise = getSheetData(validServiceAccount, mockLogger);
			await vi.runAllTimersAsync();

			await expect(promise).resolves.toEqual({
				sheetInfo: "col1\tcol2\nval1\tval2",
				description: "Bot description",
			});
			expect(mockLoadInfo).toHaveBeenCalledTimes(2);
		});
	});

	describe("fetchSheetInfo failure", () => {
		it("throws when test sheet is not found", async () => {
			setupSheets({ hasTestSheet: false });

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toMatchObject({
				operation: "resolve data sheet",
				retryable: false,
				userMessage: "指定されたシートが見つかりません。",
			});
		});

		it("throws when CSV is empty", async () => {
			setupSheets({ csvContent: "   " });

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toMatchObject({
				operation: "validate data sheet",
				retryable: false,
				userMessage: "シートデータが空です。",
			});
		});
	});
});
