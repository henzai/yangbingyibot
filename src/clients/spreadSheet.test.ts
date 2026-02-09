import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetGoogleAuthToken = vi.fn();
const mockLoadInfo = vi.fn();
const mockLoadHeaderRow = vi.fn();
const mockDownloadAsCSV = vi.fn();
const mockLoadCells = vi.fn();
const mockGetCellByA1 = vi.fn();

vi.mock("cloudflare-workers-and-google-oauth", () => ({
	default: vi.fn().mockImplementation(() => ({
		getGoogleAuthToken: mockGetGoogleAuthToken,
	})),
}));

vi.mock("google-spreadsheet", () => ({
	GoogleSpreadsheet: vi.fn().mockImplementation(() => ({
		loadInfo: mockLoadInfo,
		sheetsByTitle: {},
	})),
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
};

function setupSheets(options?: {
	hasTestSheet?: boolean;
	hasDescSheet?: boolean;
	csvContent?: string;
	descValue?: string | null;
}) {
	const {
		hasTestSheet = true,
		hasDescSheet = true,
		csvContent = "col1,col2\nval1,val2",
		descValue = "Bot description",
	} = options ?? {};

	const sheetsByTitle: Record<string, unknown> = {};

	if (hasTestSheet) {
		sheetsByTitle.test = {
			loadHeaderRow: mockLoadHeaderRow,
			downloadAsCSV: mockDownloadAsCSV,
		};
	}

	if (hasDescSheet) {
		sheetsByTitle.description = {
			loadCells: mockLoadCells,
			getCellByA1: mockGetCellByA1,
		};
	}

	mockDownloadAsCSV.mockResolvedValue(new TextEncoder().encode(csvContent));
	mockGetCellByA1.mockReturnValue({ value: descValue });

	// biome-ignore lint/suspicious/noExplicitAny: overriding mock property
	(GoogleSpreadsheet as any).mockImplementation(() => ({
		loadInfo: mockLoadInfo,
		sheetsByTitle,
	}));
}

describe("spreadSheet", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetGoogleAuthToken.mockResolvedValue("mock-token");
		mockLoadInfo.mockResolvedValue(undefined);
		mockLoadHeaderRow.mockResolvedValue(undefined);
		mockLoadCells.mockResolvedValue(undefined);
	});

	describe("getSheetData", () => {
		it("returns sheet info and description on success", async () => {
			setupSheets();

			const result = await getSheetData(validServiceAccount, mockLogger);

			expect(result).toEqual({
				sheetInfo: "col1,col2\nval1,val2",
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
	});

	describe("parseServiceAccount (via getSheetData)", () => {
		it("throws on invalid JSON", async () => {
			await expect(getSheetData("not-json", mockLogger)).rejects.toThrow(
				"スプレッドシート情報の取得中にエラーが発生しました。",
			);
		});

		it("throws when client_email is missing", async () => {
			await expect(
				getSheetData(JSON.stringify({ private_key: "key" }), mockLogger),
			).rejects.toThrow("スプレッドシート情報の取得中にエラーが発生しました。");
		});

		it("throws when private_key is missing", async () => {
			await expect(
				getSheetData(JSON.stringify({ client_email: "a@b.com" }), mockLogger),
			).rejects.toThrow("スプレッドシート情報の取得中にエラーが発生しました。");
		});
	});

	describe("authenticateGoogle (via getSheetData)", () => {
		it("throws when token is null", async () => {
			mockGetGoogleAuthToken.mockResolvedValue(null);

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toThrow("スプレッドシート情報の取得中にエラーが発生しました。");
		});
	});

	describe("loadInfo failure", () => {
		it("throws user-friendly error when loadInfo fails", async () => {
			setupSheets();
			mockLoadInfo.mockRejectedValue(new Error("403 Forbidden"));

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toThrow(
				"スプレッドシートへのアクセスに失敗しました。権限を確認してください。",
			);
		});
	});

	describe("fetchSheetInfo failure", () => {
		it("throws when test sheet is not found", async () => {
			setupSheets({ hasTestSheet: false });

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toThrow("スプレッドシート情報の取得中にエラーが発生しました。");
		});

		it("throws when CSV is empty", async () => {
			setupSheets({ csvContent: "   " });

			await expect(
				getSheetData(validServiceAccount, mockLogger),
			).rejects.toThrow("シートデータのダウンロードに失敗しました。");
		});
	});
});
