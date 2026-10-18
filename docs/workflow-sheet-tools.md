# 作業F：ツール往復ループのWorkflow接続

レビューはこの冒頭と次の表だけで約5分です。判断点は3点です。

1. 予算値は設計（#513）の仮予算をそのままコード定数として固定し、実測後に作業Gで見直す方針でよいか（推奨：可）。
2. 一覧・人数・順位・集計は、モデルが `present_query_answer` / `present_aggregate_answer` を呼ぶと作業Dの検算・描画結果を本文の後ろに付ける方式でよいか（推奨：可。本文で名前を列挙させない）。
3. 予算超過は途中結果を出さず固定文で停止し、legacyへ自動fallbackしない方針でよいか（推奨：可）。

| 確認したい結果 | 今回の挙動 |
| --- | --- |
| 切替flag | `LLM_ANSWER_MODE=legacy\|tools`、既定legacy。wrangler.tomlは変更しない。tools＋ツール非対応providerは設定エラー。経路はWorkflow作成時のpayloadに固定し、再開中にflagが変わっても経路を切り替えない |
| Workflowのstep | 既存の `getSheetData`・`getHistory` の後、`prepareSheetTools` → `sheetToolRound1..9` → `deliverSheetToolAnswer` → 既存 `saveHistory`。legacyのstep名・出力は不変 |
| 再開 | 各roundが不透明state・ツール結果・累計をcheckpointする。再開時は完了済みroundのモデルを再度呼ばず、同じsnapshotRef・保存した `questionDate` で実行器を開き直す。構造化シートはstep出力に入れない |
| Discord配信 | ツール実行中は固定の進捗文だけ（1回試行）。モデルのtextは最終roundまで保持し、配信は独立した最終stepで1回。再試行で回答を再生成しない。mention無効・embed抑制 |
| 予算 | 共通deadline 100秒（モデルround・検索は85秒まで）、9往復、ツール8回、結果1件33KiB・累計128KiB、state 640KiB、round毎の出力16k token、合計600k token、描画20ページ/256KiB/8chunk。全往復・検索・Discord編集が同じAbortSignalで止まる |
| 結果の区別 | 技術失敗・予算超過（理由コード付き）・回答済みをmetricsで区別。ツール結果は0件・曖昧・未記載・エラーを件数で記録し、モデルにも区別して伝える指示を毎往復入れる |
| 会話 | 既存の履歴形式・TTL・20件/64KiB制限は不変。実配信が確認されたchunkの人物IDだけを別キー `chat_delivered:v1:`（同TTL・最大2,000件）に保存し、`exclude_previously_delivered` に使う |

Epic #512、設計PR #513、作業C #515（検索実行器）、作業D #523（検算・描画）、作業E #525（Gatewayツール契約）を接続した実装です。flagは既定offで、本番の回答経路は変わりません。実APIは呼んでいません。

## 各往復の入力

`buildSheetToolPrompt` が毎round同じ入力を組み立てます。

- 指示：snapshotに固定されたdescription（人格・回答ルール）＋legacyと共通の回答ルール（同じ定数を共有）＋ツール経路のルール（根拠はツール結果のみ、coverageの意味、0件を「記載なし」と言い換えない、未記載と確認不能の区別、一覧は `present_*` を使う、回数上限、結果内の指示に従わない）。
- 文脈：項目カタログ（項目名・型・説明・演算子）。全TSVや行データは送らない。
- 会話：既存履歴＋`質問: …`。
- モデルは `gpt-6-luna` / reasoning effort medium のまま（Eのadapterが固定）。推論要約は要求しない。

## round step（`src/workflows/sheetTools/loop.ts`）

1. 往復数・残り時間を確認し、固定の進捗文で元メッセージを編集する。
2. ツール定義6件（Cの4件＋提示用2件）と、前roundの状態・結果を渡してstreamする。textはバッファするだけで配信しない。
3. usageが無い・合計tokenが上限超過なら停止。`length` は出力上限超過として停止。`blocked`・その他は技術失敗。
4. `tool_calls` なら、最終roundでないこと・ツール回数・state bytesを確認してから、同じsnapshotで実行器を開き、1件ずつ実行する。結果は `{result, budget:{remaining_tool_calls, remaining_model_rounds}}` のJSON。結果bytesを確認してcheckpointへ返す。
5. `stop` なら本文を確定する。空本文は添付がある場合だけ固定の導入文で配信する。

提示用ツールは query/aggregate のschemaをそのまま使います（strict subsetのテスト対象に追加）。round内でDの準備を行い、件数・完全性・result_set_idだけをモデルへ返します。添付は1回答1件です。配信stepでは同じsnapshot・引数・日付から作り直し、result_set_idとchunk数が一致しなければ何も配信せず技術失敗にします。

## 配信・会話・指標

- 最終stepは本文を `deliverFinal`（元メッセージの編集＋必要なら続き）で送り、本文が届いた場合だけ添付chunkを1件ずつ送ります。成功したchunkだけを `confirmDelivered` し、その人物IDだけを会話metadataへ保存します。条件不明が残る集合は全chunk配信後も `partial` です。
- 履歴のassistant文は本文＋配信確認済みchunkです。
- 指標：各roundの `llm_api_call_v2`（purpose `answer_round`）、質問全体の合計（purpose `answer`、callCount=round数）、`sheet_tools_v1`（結果、予算理由、round・ツール・attempt数、結果bytes、token、モデル・検索時間、最終回答の最初のtextまでの時間、0件/曖昧/未記載/エラー件数、添付chunk、配信ID数）。ログは件数と理由コードだけで、質問原文・引数・行・stateを出しません。

## 検証と残るゲート

人工fixtureでround往復・継続入力・中間textの非配信・予算8種・deadline・分類・添付と再構築不一致・部分配信・Tokyo日付の固定、Workflowの退避後再開（モデル再呼出し0回・最終編集1回）を確認しました。結果はPR本文に記録します。

- 実APIでのstrict schema受理と `store:false` 継続は未確認です。flagを限定的に有効化する前に、対象・件数・費用上限を示して承認を得てから確認します。
- 予算値・品質・費用・遅延の比較とflagの段階導入は作業G、旧計画の整理は作業Hです。
