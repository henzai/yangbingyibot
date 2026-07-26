// スプレッドシートのCSVはGeminiへの入力トークンの大半を占めるため、
// 意味を落とさずに削れる分を落としてから渡す。
// 内訳: 全行が空の列を除去、情報量のない行を除去、CSV -> TSV。

// 先頭から保持する行数（メタ行・列説明行・ヘッダ行）
const PRESERVED_HEADER_ROWS = 3;

// これ未満の非空セルしか持たない行は情報量がないとみなして除去する。
// 列位置や見出し名に依存しないため、シートのレイアウト変更に強い。
const MIN_NON_EMPTY_CELLS = 2;

function parseCsv(csv: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let inQuotes = false;

	for (let i = 0; i < csv.length; i++) {
		const char = csv[i];

		if (inQuotes) {
			if (char === '"') {
				// 連続する二重引用符はエスケープされた引用符
				if (csv[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cell += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			row.push(cell);
			cell = "";
		} else if (char === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else if (char !== "\r") {
			cell += char;
		}
	}

	// 末尾に改行がない場合の最終行
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}

	return rows;
}

// TSVの区切りを壊さないよう、セル内の制御文字を空白に潰す
function sanitizeCell(value: string | undefined): string {
	return (value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

export function compactSheetCsv(csv: string): string {
	const rows = parseCsv(csv).map((row) => row.map(sanitizeCell));
	if (rows.length === 0) return "";

	const columnCount = Math.max(...rows.map((row) => row.length));

	// 全行にわたって空の列は情報を持たないので落とす
	const liveColumns: number[] = [];
	for (let column = 0; column < columnCount; column++) {
		if (rows.some((row) => row[column])) {
			liveColumns.push(column);
		}
	}

	const keptRows = rows.filter((row, index) => {
		if (index < PRESERVED_HEADER_ROWS) return true;
		const nonEmpty = row.filter(Boolean).length;
		return nonEmpty >= MIN_NON_EMPTY_CELLS;
	});

	return keptRows
		.map((row) => liveColumns.map((column) => row[column] ?? "").join("\t"))
		.join("\n");
}
