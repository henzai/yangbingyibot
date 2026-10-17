# 作業E：Gatewayのツール呼び出し契約と応答継続

レビューはこの冒頭と次の表だけで約3分です。判断点は最大3点です。

1. ツール要求で終わった応答を `finish.reason: "tool_calls"` として最終回答と区別し、その応答の本文は途中経過として配信しない方針でよいか（推奨：可）。
2. `store: false` のまま、前回応答の全output item（暗号化reasoningを含む）を不透明な累積stateとして次の往復へ渡す方式でよいか（推奨：可。`previous_response_id` は使わない）。
3. Geminiは今回ツール非対応とし、ツール付き要求を送信前に拒否する方針でよいか（推奨：可。モデルを黙って切り替えない）。

| 確認したい結果 | 今回の挙動 |
| --- | --- |
| ツール定義 | `LlmToolDefinition` を `type:"function"`・`strict:true` へそのまま変換。`tool_choice:"auto"`、`parallel_tool_calls:false` |
| 部分引数 | 引数のdeltaでは何もしない。完了した最終Responseの `function_call` だけを読む。未完了・失敗・最終Responseなしではツール要求を返さない |
| 引数とcall_id | 引数はJSON objectへparseして返す。不正JSON・非object・未知ツールはエラーコードで返す。call_idの欠落・重複、ツールなし要求への関数呼び出しは例外 |
| 要求と最終回答 | ツール要求の応答は `tool_calls` イベント（usage/finishの前に1回）と `finish.reason:"tool_calls"`。最終回答は従来どおり `stop` |
| 応答継続 | 次の入力＝元の入力＋前回までの全output item＋`function_call_output`。結果のcall_idが未処理のIDと完全一致しなければ送信しない |
| 各往復の指示 | 毎回同じ `instructions`（description由来の人格・回答ルール）と同じシート文脈、`gpt-6-luna` / `reasoning.effort:"medium"` を送る |
| 既存のtext経路 | ツールなしのOpenAI/Gemini要求は従来と同一。現行Workflowはツールを渡さず、万一 `tool_calls` で終われば配信せずエラー扱い |

Epic #512、設計PR #513、作業C #515のschema（`src/sheets/search/tools.schema.json`）を基にした実装です。Workflow・Discord・会話履歴・予算・切替flagへの接続は作業Fです。実APIは呼んでいません。

## 契約（`src/llm/types.ts`）

- `LlmRequest.tools` と `LlmRequest.continuation`。`capabilities.tools` がfalseのproviderやツール非対応モデルでは、provider要求の前に再試行しないエラーにします。
- `LlmToolState` はproviderが所有する不透明でJSON化できるstateです。Fで Workflow step に保存できます。`items` には暗号化reasoningが入るため、呼び出し側は中身を読まず、ログや会話履歴へ出さず、そのまま返します。
- `LlmToolContinuation` は未処理のcall_idごとに1件の結果文字列を持ちます。過不足・重複・別providerのstateは送信前に拒否します。
- 引数の型・値の検証は作業Cの実行器（`validArguments` と実行時検証）の責務です。Gatewayは完全なJSON objectかどうかだけを判定し、生の引数文字列を公開しません。

## OpenAI adapter

- ツールありの要求だけに `tools`、`tool_choice`、`parallel_tool_calls:false` を付け、reasoningモデルでは `include:["reasoning.encrypted_content"]` も付けます。`store:false` と `truncation:"disabled"` は維持します。
- 継続stateは累積です。各往復で、それまでのitem・ツール結果・今回の全outputを、項目を削らずに順番どおり保持します。
- 拒否（refusal）は従来どおり `blocked` を優先し、同じ応答の関数呼び出しは返しません。
- ログに出すのは `toolCallCount` の件数だけです。引数・結果・reasoning・stateは出しません。

## strict schemaの確認範囲

`src/llm/providers/openaiStrictSchema.test.ts` で、作業Cの4ツールがOpenAI公式資料のStructured Outputs対応範囲に収まることを確認しています。対象はキーワード、全objectの `additionalProperties:false` と全項目required、rootがobjectであること、深さ・property数・enum数・文字数の上限です。実APIによる受理確認は有料呼び出しのため未実施です。Fの限定有効化の前に、範囲と費用を確認してから行います。

## 後続（作業F以降）

ツール往復のループ、回数・bytes・token・deadlineの累積予算、ツール実行中のDiscord表示、最終回答だけの配信、会話履歴とcheckpoint、切替flag、各往復のusage集計はFで行います。全カテゴリの品質・費用・遅延の比較はGで行います。

参照：[Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna)（2026-10-18確認）。
