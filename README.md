# yangbingyibot

Google SheetsのナレッジベースとGoogle Gemini AIを使用してDiscordで質問に回答するボットです。Cloudflare Workers上で動作します。

## 機能

- `/ask` スラッシュコマンドで質問を受け付け
- Google Sheetsからナレッジベースを取得
- Google Gemini AIでストリーミング回答（リアルタイムでDiscordメッセージを段階的更新）
- Gemini思考過程の表示（💭 AI要約で表示）
- 会話履歴をKVに保存してコンテキストを維持（5分間）
- シートデータを5分間キャッシュ（KVネイティブTTL）
- Analytics Engineでメトリクス収集

## アーキテクチャ

```
Discord → Cloudflare Workers → Cloudflare Workflow → Google Gemini AI (streaming)
                                      ↓                    ↓
                               Google Sheets        Discord PATCH (段階的更新)
                                      ↓
                               Cloudflare KV (キャッシュ・履歴)
                                      ↓
                               Analytics Engine (メトリクス)
```

**リクエストフロー:**
1. Discordから `/` エンドポイントへPOSTリクエスト
2. ミドルウェアでDiscord署名を検証（Ed25519）
3. 即座に遅延レスポンス（DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE）を返却
4. Cloudflare Workflow (`AnswerQuestionWorkflow`) を非同期実行:
   - Step 1: Google SheetsからシートデータをKVキャッシュ経由で取得
   - Step 2: KVから会話履歴を取得
   - Step 3: Gemini APIでストリーミング応答 + Discordメッセージを1.5秒間隔でPATCH更新
   - Step 4: 会話履歴をKVに保存

## セットアップ

### 必要なもの

- Node.js
- Cloudflareアカウント
- Discordアプリケーション
- Google Cloud Platform サービスアカウント
- Google Gemini APIキー

### インストール

```bash
npm install
```

### 環境変数

`.dev.vars` ファイルを作成し、以下の環境変数を設定:

```
DISCORD_TOKEN=<Discord Bot Token>
DISCORD_PUBLIC_KEY=<Discord Public Key>
DISCORD_APPLICATION_ID=<Discord Application ID>
GEMINI_API_KEY=<Google Gemini API Key>
GOOGLE_SERVICE_ACCOUNT=<Google Service Account credentials (JSON文字列)>
```

本番環境では `wrangler secret` でシークレットを設定してください。

**wrangler.tomlでのバインディング:**
- KV Namespace: `sushanshan_bot`
- Analytics Engine: `METRICS`
- Workflow: `ANSWER_QUESTION_WORKFLOW` (class: `AnswerQuestionWorkflow`)

### Discordコマンドの登録

```bash
npm run register
```

## 開発

```bash
npm run dev          # ローカル開発（ホットリロード）
npm test             # テスト実行
npm run cf-typegen   # Cloudflare Worker型を生成
npm run check        # Biome フォーマッター + リンター（自動修正）
npm run check:ci     # Biome チェック（CI用、書き込みなし）
npm run lint         # リンターのみ実行
npm run format       # フォーマッターのみ実行
```

## デプロイ

```bash
npm run deploy
```

## プロジェクト構成

```
src/
├── index.ts                           # Honoアプリエントリーポイント、Workflow再エクスポート
├── types.ts                           # 型定義（Bindings含む）
├── clients/
│   ├── discord.ts                     # Discord Webhookクライアント（PATCH編集用）
│   ├── gemini.ts                      # Google Gemini AIクライアント（ストリーミング対応）
│   ├── kv.ts                          # Cloudflare KVラッパー（ネイティブTTL）
│   ├── metrics.ts                     # Analytics Engineメトリクスクライアント
│   └── spreadSheet.ts                 # Google Sheetsクライアント
├── workflows/
│   ├── answerQuestionWorkflow.ts      # メインワークフロー（4ステップ）
│   └── types.ts                       # Workflow用型定義
├── middleware/
│   └── verifyDiscordInteraction.ts    # Discord署名検証
├── responses/
│   └── errorResponse.ts               # エラーレスポンス
└── utils/
    ├── logger.ts                      # 構造化ロガー
    ├── requestId.ts                   # リクエストID生成
    └── retry.ts                       # リトライロジック（指数バックオフ）

scripts/
├── commands.js                        # Discordコマンド定義
└── register.js                        # コマンド登録スクリプト
```

## 技術スタック

- [Hono](https://hono.dev/) - Webフレームワーク
- [Cloudflare Workers](https://workers.cloudflare.com/) - サーバーレス実行環境
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) - 非同期ワークフロー実行
- [Cloudflare KV](https://developers.cloudflare.com/kv/) - キーバリューストレージ
- [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) - メトリクス収集
- [Google Gemini AI](https://ai.google.dev/) - LLM（ストリーミング対応）
- [Google Sheets API](https://developers.google.com/sheets/api) - ナレッジベース
- [Biome](https://biomejs.dev/) - フォーマッター・リンター

## ライセンス

Private
