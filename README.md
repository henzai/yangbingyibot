# yangbingyibot

Google SheetsのナレッジベースとGoogle Gemini AIを使用してDiscordで質問に回答するボットです。Cloudflare Workers上で動作します。

## 機能

- `/ask` スラッシュコマンドで質問を受け付け
- Google Sheetsからナレッジベースを取得
- Google Gemini AIでストリーミング回答（リアルタイムでDiscordメッセージを段階的更新）
- Gemini思考過程の表示（💭 AI要約で表示）
- 利用者＋チャンネル単位の会話履歴と、接続先別のシートデータをKVに保持
- Analytics Engineでメトリクス収集
- Cronヘルスチェック（5分間隔でKV・Gemini API・サービスアカウントを監視）
- エラー・障害の自動GitHub Issues報告（重複排除付き）

## アーキテクチャ

```
Discord → Cloudflare Workers → Cloudflare Workflow → Google Gemini AI (streaming)
                                      ↓                    ↓
                               Google Sheets        Discord PATCH (段階的更新)
                                      ↓
                               Cloudflare KV (キャッシュ・履歴)
                                      ↓
                               Analytics Engine (メトリクス)

Cron (5分間隔) → Health Check → GitHub Issues (障害通知)
```

**リクエストフロー:**
1. Discordから `/` エンドポイントへPOSTリクエスト
2. ミドルウェアでDiscord署名を検証（Ed25519）
3. 即座に遅延レスポンス（DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE）を返却
4. Cloudflare Workflow (`AnswerQuestionWorkflow`) を非同期実行:
   - Step 1: Google SheetsからシートデータをKVキャッシュ経由で取得
   - Step 2: KVから会話履歴を取得
   - Step 3: Gemini APIでストリーミング応答 + Discordメッセージを1〜1.5秒間隔でPATCH更新
   - Step 4: 会話履歴をKVに保存

Discordはインタラクションに3秒以内の応答を要求するため、実処理はWorkflowに逃がして即座に遅延レスポンスを返す構成になっています。

## セットアップ

### 必要なもの

- Node.js
- Cloudflareアカウント
- Discordアプリケーション
- Google Cloud Platform サービスアカウント
- Google Gemini APIキー

### 環境変数

`.dev.vars` ファイルを作成し、以下の環境変数を設定:

```
DISCORD_TOKEN=<Discord Bot Token>
DISCORD_PUBLIC_KEY=<Discord Public Key>
DISCORD_APPLICATION_ID=<Discord Application ID>
GEMINI_API_KEY=<Google Gemini API Key>
GOOGLE_SERVICE_ACCOUNT=<Google Service Account credentials (JSON文字列)>
GITHUB_TOKEN=<GitHub Personal Access Token（オプション：エラー自動報告用）>
```

以下は任意設定です。未設定時は現在の本番値へフォールバックします。

- `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL`
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_DATA_SHEET_NAME`, `GOOGLE_DESCRIPTION_SHEET_NAME`
- `GITHUB_REPOSITORY`（`owner/repository`形式）
- `HISTORY_TTL_SECONDS`（60〜86400秒、既定値300秒）

本番環境では `wrangler secret` でシークレットを設定してください。

### 起動

```bash
npm install
npm run register   # Discordにスラッシュコマンドを登録（初回とコマンド定義の変更時のみ）
npm run dev
```

## 開発

```bash
npm test           # テスト実行
npm run check      # Biomeでフォーマット + Lint（コミット前に実行すること）
```

その他のスクリプトは `package.json` を参照してください。

## デプロイ

```bash
npm run deploy
```

## コードの読み進め方

- `src/index.ts` — Honoアプリのエントリーポイント。Cloudflareに Workflow クラスを発見させるため、`AnswerQuestionWorkflow` をここから再エクスポートしている
- `src/workflows/answerQuestionWorkflow.ts` — 回答生成の本体（上記リクエストフローの Step 1〜4）
- `src/repositories/` — 会話履歴、シートキャッシュ、Issue重複排除の用途別KVアクセス
- `src/health.ts` — Cronトリガーから呼ばれるヘルスチェック

## ライセンス

Private
