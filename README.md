# yangbingyibot

Google SheetsのナレッジベースとGoogle Gemini AIを使用してDiscordで質問に回答するボットです。Cloudflare Workers上で動作します。

## 機能

- `/ask` スラッシュコマンドで質問を受け付け
- Google Sheetsからナレッジベースを取得
- Google Gemini AIで質問に回答
- 会話履歴をKVに保存してコンテキストを維持（5分間）
- シートデータを5分間キャッシュ

## アーキテクチャ

```
Discord → Cloudflare Workers → Google Gemini AI
                 ↓
         Google Sheets (ナレッジベース)
                 ↓
         Cloudflare KV (キャッシュ・履歴)
```

**リクエストフロー:**
1. Discordから `/` エンドポイントへPOSTリクエスト
2. ミドルウェアでDiscord署名を検証（Ed25519）
3. 即座に遅延レスポンス（DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE）を返却
4. `executionCtx.waitUntil()` で非同期に処理を実行
5. 結果をDiscord Webhookフォローアップで送信

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
GOOGLE_CLIENT_EMAIL=<Google Service Account Email>
GOOGLE_PRIVATE_KEY=<Google Service Account Private Key>
```

本番環境では `wrangler secret` でシークレットを設定してください。

### Discordコマンドの登録

```bash
npm run register
```

## 開発

```bash
npm run dev          # ローカル開発（ホットリロード）
npm test             # テスト実行
npm run cf-typegen   # Cloudflare Worker型を生成
```

## デプロイ

```bash
npm run deploy
```

## プロジェクト構成

```
src/
├── index.ts                           # Honoアプリエントリーポイント
├── types.ts                           # 型定義
├── clients/
│   ├── gemini.ts                      # Google Gemini AIクライアント
│   ├── kv.ts                          # Cloudflare KVラッパー
│   └── spreadSheet.ts                 # Google Sheetsクライアント
├── handlers/
│   └── answerQuestion.ts              # 質問回答フローのオーケストレーション
├── middleware/
│   └── verifyDiscordInteraction.ts    # Discord署名検証
└── responses/
    └── errorResponse.ts               # エラーレスポンス

scripts/
├── commands.js                        # Discordコマンド定義
└── register.js                        # コマンド登録スクリプト
```

## 技術スタック

- [Hono](https://hono.dev/) - Webフレームワーク
- [Cloudflare Workers](https://workers.cloudflare.com/) - サーバーレス実行環境
- [Cloudflare KV](https://developers.cloudflare.com/kv/) - キーバリューストレージ
- [Google Gemini AI](https://ai.google.dev/) - LLM
- [Google Sheets API](https://developers.google.com/sheets/api) - ナレッジベース

## ライセンス

Private
