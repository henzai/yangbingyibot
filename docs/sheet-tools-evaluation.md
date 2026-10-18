# シートツール経路の評価ハーネス（作業G）

Epic #512 の作業Gで、本番と同じlegacy経路とtools経路を同一のシートsnapshotで走らせ、品質・コスト・遅延・予算超過を比べるためのローカルハーネスです。`tools/sheet-tools-eval/` にあり、`src/` の挙動は変えません。

通常の `npm test` / `npm run verify` はfake gatewayだけを使い、OpenAIを含む外部APIを一切呼びません。実APIを呼ぶのは `--execute` を付けたときだけで、これは利用者の承認後に手動で実行します。

## 安全なコマンド

```sh
# 計画のみ（鍵の読み込み、gateway生成、通信はいずれも行わない）
npm run eval:sheet-tools -- \
  --csv <sheet.csv> --description <description.json|txt> \
  --questions <questions.jsonl> --out .llm-eval/sheet-tools-1 \
  --mode both --max-usd 1

# 実行（承認後のみ）。上のコマンドに --execute を付ける
```

オプション：`--mode tools|legacy|both`、`--limit <n>`、`--ids a,b`。`both` は質問の番号ごとに先に走らせる経路を入れ替えます（偶数番はlegacy先、奇数番はtools先）。

## 入力（すべてローカル、gitignore対象）

- `--csv`：本番がダウンロードするデータシートのCSV。
- `--description`：Sheets APIの `{range, majorDimension, values}` 形式のJSON、またはプレーンテキスト。JSONは本番と同じく先頭セル（A1）の文字列化 `value?.toString() || ""` に変換します。
- `--questions`：JSONL。1行 `{id, category, question, history?: [{role: "user"|"assistant", text}]}`。余分な項目は無視します。
- `--out`：リポジトリ外、または `git check-ignore` で無視されるディレクトリ（例 `.llm-eval/...`）のみ許可。それ以外は拒否します。既存の `raw.jsonl` は上書きしません。
- 実行時のAPI鍵は、worktree直下のgitignored `.env.local` の `OPENAI_API_KEY` だけから読みます（`process.env` には入れません）。

固定条件：モデルは `gpt-6-luna`、本番のOpenAI adapter経由。reasoning effort mediumと `store:false`、strict関数ツールはadapterが固定しており、ハーネスは変更せず、起動時に確認だけ行います。要約（thinking summary）は本番どおり無効です。直列実行です。

## 固定snapshot

CSVから `buildSheetStructure` で構造化し、メモリ上のKV偽物に `SheetSnapshotRepository.capture` で固定します。tools経路は本番の `createSheetToolDeps` と同じ形の `openEngine`（`SheetSearchEngine.open`）で開きます。legacy経路は本番と同じCSV→sheetInfo変換（`parseCsv` + `compactSheetRows`）と同じdescriptionを使います。`questionDate` は本番どおり実行開始時刻からAsia/Tokyoの日付で決まり、summaryに記録します。入力の同一性は csv と description のsha256（`snapshotSha256`）で確認します。

tools経路は `prepareSheetToolsStep` → `runSheetToolRound`（1〜`maxModelRounds`）→ `deliverSheetToolAnswerStep` を本番の `SHEET_TOOL_LIMITS` のまま駆動し、roundごとに出力を `JSON.parse(JSON.stringify())` で往復させてWorkflowのcheckpointを模擬し、出力のバイト数を記録します。Discord配信は通信しないメモリ上の偽物です。

## 予算規則

各モデルリクエストの前に、最悪ケースを予約します。

> 予約 ＝（送るもの全体のUTF-8バイト数をtoken上限とみなす × 入力単価 ＋ 最大出力token × 出力単価）× 2試行

予約が、それまでの実績に足して `--max-usd` を超えるなら、送信せずに止め、その質問を `harness_budget_stop` として記録し、以降の質問も送りません。リクエスト後は実際のusageで精算します（キャッシュ入力はキャッシュ単価、reasoningは出力単価）。usageが欠けたときや失敗時は、予約額に基づく保守的な見積りを計上します。リトライした試行は予約額を加算します。legacyは本番が出力上限を設定しないため、予約だけ1roundと同じ16,000 tokenを仮定します（リクエストは変えません）。

価格は `tools/sheet-tools-eval/pricing.json`（gpt-6-luna：入力0.10、キャッシュ入力0.01、出力0.50 USD / 100万token、2026-10-18、出典はファイル内）。7日より古いと拒否します（`--execute` なしの計画も同様）。

## 出力

`--out` 配下：

| ファイル | 内容 |
| --- | --- |
| `raw.jsonl` | ローカル専用。質問×経路ごとに、結果（`answered` / `budget_exceeded(理由)` / `technical_failure(service, operation, HTTP status)` / `harness_budget_stop`）、最終本文、配信chunk、round別の指標（finishReason、ツール呼び出し数、usage（cached・reasoning含む）、試行数、所要時間、最初のtextまで、state・出力のバイト数）、ツール名と呼び出しごとの結果（ok/zero/ambiguous/missing/error）、モデルが送ったツール引数（`requestedCalls`。`invalid_arguments` の原因調査用）、合計、コスト、遅延 |
| `summary.json` | 集計のみ。質問・回答・履歴・行・ツール引数の本文は含まない。経路別・category別の件数、結果別件数、予算理由、ツール結果別件数、round数・ツール呼び出し数の分布、遅延のp50/p95、token合計（cached・reasoning含む）、コストの合計・平均・最大、state・結果・round出力の最大バイト数、snapshot sha256、git commit、モデル、価格版 |

`summary.json` のG1受入フラグ（tools経路）：`schemaAccepted`（round 1が非エラー応答）、`continuationObserved`（`tool_calls` で終わったroundの後に成功したroundがある）、`usageAlwaysPresent`（応答したroundすべてでusageが揃っている）。

標準出力・標準エラーにはid、件数、結果コード、数値だけを出します。質問・回答・行の本文は出しません。`raw.jsonl` はgitに入れず、共有しません。
