# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev          # Local development with hot reload
npm run deploy       # Deploy to Cloudflare Workers (with minification)
npm test             # Run tests with Vitest (@cloudflare/vitest-pool-workers)
npm run test:watch   # Run tests in watch mode
npm run register     # Register Discord slash commands via Discord API
npm run check        # Run Biome formatter + linter with auto-fix
npm run check:ci     # Run Biome check without writing (for CI)
npm run typecheck    # Run TypeScript type checking without emitting files
npm run cf-typegen   # Regenerate worker-configuration.d.ts from wrangler.toml
npm run verify       # check:ci + typecheck + test + deploy dry-run
```

`worker-configuration.d.ts` は `npm run cf-typegen` の生成物で、リポジトリにコミットされている。CI の typecheck ジョブは `cf-typegen` 実行後に `git diff --exit-code` を行うため、`wrangler.toml` のバインディングを変更したら再生成してコミットすること。

## Architecture

Discord bot on Cloudflare Workers (Hono). Uses Google Gemini AI with a Google Sheets knowledge base.

**リクエストフロー:**

1. Discord から `POST /` へリクエスト。`verifyDiscordInteraction` ミドルウェアが Ed25519 署名を検証する
2. `InteractionType.PING` には PONG を返す。`APPLICATION_COMMAND` はペイロードを検証して `ANSWER_QUESTION_WORKFLOW` を起動し、即座に `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` を返す（Discord の3秒制限のため実処理は Workflow に逃がす）
3. `AnswerQuestionWorkflow` が非同期で実行:
   - `getSheetData` — KV キャッシュから取得。無ければ Google Sheets から取得してキャッシュ（保存失敗は非致命）
   - `getHistory` — KV から会話履歴を取得
   - `streamGeminiAndEditDiscord` — Gemini のストリーミング応答を受けながら Discord メッセージを PATCH で段階更新（thinking フェーズは別モデルで要約して表示）
   - `saveHistory` — 更新後の会話履歴を KV に保存
4. Workflow が失敗した場合は GitHub Issues に報告し（フィンガープリントで重複排除）、エラーメッセージを Discord に送信する

**キャッシュ:**

`src/clients/kv.ts` がシートデータ (`sheet_info`) と会話履歴 (`chat_history`) をいずれも KV ネイティブ TTL 5分で保持する。エラー報告の重複排除キー (`error_reported:<fingerprint>`) は TTL 1時間。

**メトリクス:**

`METRICS` バインディングがある場合のみ Analytics Engine に記録し、無い場合は `NoOpMetricsClient` にフォールバックする。

**Cron:**

5分間隔で `scheduled` ハンドラが KV・Gemini API・サービスアカウントのヘルスチェックを実行し、失敗を GitHub Issues として報告する。

## Project Structure

```
src/
  index.ts            # Hono エントリーポイント + scheduled ハンドラ。AnswerQuestionWorkflow を再エクスポート
  types.ts            # Bindings（シークレット + Cloudflare バインディング）、HistoryEntry
  health.ts           # Cron ヘルスチェック（KV / Gemini / サービスアカウント）
  clients/
    discord.ts        # Discord Webhook クライアント（投稿・元メッセージ編集）
    gemini.ts         # Gemini クライアント（ストリーミング + 会話履歴）
    github.ts         # GitHub Issues クライアント（エラー・ヘルスチェック報告、重複排除）
    kv.ts             # KV キャッシュと会話履歴
    metrics.ts        # Analytics Engine メトリクス（NoOp フォールバック付き）
    spreadSheet.ts    # Google Sheets ナレッジベース取得
  middleware/
    verifyDiscordInteraction.ts  # Ed25519 署名検証
  responses/
    errorResponse.ts  # Discord エラーレスポンス生成
  utils/              # compactSheet, errors, logger, requestId, retry
  workflows/
    answerQuestionWorkflow.ts    # AnswerQuestionWorkflow 本体と各ステップ
    types.ts                     # Workflow のパラメータ / ステップ出力型
scripts/
  commands.js         # `/ask` コマンド定義（実行時と登録で共有）
  register.js         # Discord へのスラッシュコマンド登録
```

テストは実装と同じディレクトリに `*.test.ts` として配置する。

## Environment Variables

Required in Cloudflare Workers secrets or `.dev.vars` for local development:

- `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` - Discord credentials
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_SERVICE_ACCOUNT` - Google Service Account credentials (JSON string)
- `GITHUB_TOKEN` (optional) - GitHub PAT for auto-reporting errors and health check failures as Issues

Cloudflare bindings (defined in `wrangler.toml`, typed in `src/types.ts`):

- `sushanshan_bot` - KV namespace（シートキャッシュ / 会話履歴 / エラー重複排除）
- `ANSWER_QUESTION_WORKFLOW` - `AnswerQuestionWorkflow` の Workflow バインディング
- `METRICS` (optional) - Analytics Engine dataset `yangbingyibot_metrics`

## Git Workflow

- 新しいブランチは、明確に既存ブランチの作業を引き継ぐ場合を除き、必ず `main` から作成すること。作成前に `git fetch origin` を実行し、`origin/main` から作成すること
- PRを作成する際は、対象の変更に関係ないコミットが含まれていないことを確認すること
- TODOリストの各項目が完了するごとにコミットを作成すること

## Claude Code Actions

- コード変更を行った場合は `npm run check` で整形し、`npm run verify` で検証すること（CI と同じ check:ci / typecheck / test / deploy dry-run が実行される）
- PRが存在しない場合はドラフトPRを作成すること

## Critical Components

⚠️ `src/index.ts` の `InteractionType.PING` ハンドラは Discord 仕様上必須。削除・変更禁止。テストで保護済み。
