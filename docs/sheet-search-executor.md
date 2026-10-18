# 作業C：snapshot上の検索実行器

レビューはこの冒頭と次の表だけで約3分です。判断点は「検索の共通基盤として、このPRを取り込めるか」の1点です。推奨は可です。人物候補と正確な条件集合を分け、欠損・不完全な取得を明示する実行器を先に確定できます。返答は「このPRをmergeしてよい」または懸念点だけで十分です。mergeには別途その明示承認を必要とします。

| 確認したい結果 | 今回の挙動 |
| --- | --- |
| 同じ質問中のデータ版 | 作業Bの不変snapshotを一度ロード。descriptionも同じ版。可変cacheの再読込なし |
| 人物・自由記述の探索 | 公式名を含む6命名列の候補検索／許可された文字列列の全行走査。候補・文字列一致を完全な意味検索と扱わない |
| 条件集合・上位・集計 | 型付きAND/OR、全件抽出、平均、数値/日付差、年別最良順位、境界の全同値。行・件数・集合参照は同じ実行器から生成 |
| 根拠や取得が不足した場合 | 非公開・数式エラー・曖昧な状態・日付精度不足を区別。32KiB上限とcursor、長文の復元可能な断片、完全なID集合を保持 |
| 本番への接続 | E/Fで行う。現在のTSV回答・モデル設定・5分cache・PINGを維持 |

Epic #512、設計PR #513の契約v0.2を基に、最新mainの作業B（#514）へ独立して追加した実装です。有料評価・本番切替・Discord送信を含みません。検索品質や全コーパスへの回答成功を証明するPRではありません。

## 入口と読み取り契約

`src/sheets/search/engine.ts` の `SheetSearchEngine.open(repository, source, ref, options)` は検証済み不変KV bundleを一度だけ読み込みます。消失・期限・source不一致・破損ではエラーを返し、現時点のSheetsへ置換しません。各実行の開始・終了でも期限とAbortSignalを確認します。snapshotを消費するための追加ネットワーク/APIはありません。

`execute(name, parsedArguments)` は4操作のclosed schemaと型・演算・dataset・引数の組合せを検証します。schemaはPR #513から取り込み、runtimeと一緒に `src/sheets/search/tools.schema.json` で管理します。providerへのstrict schema提供・受理確認は作業Eです。

- `search_records`：identity/text。未指定ならidentityは6命名列、textはdatasetの利用可能な文字列/集合列を走査します。明示fieldで範囲を狭められます。identityは同名別人・短い表記の曖昧さを残し、旧8件制限を廃止して人物ID単位でページングします。一致元・方法は各recordの `matches` に付きます。
- `get_records`：最大20ID。明示fieldsかpresetを一方だけ指定します。`all_available` は許可された生項目と利用可能な派生項目を対象にし、対象年齢を必要とする `days_until_target_age` は明示fieldsで取得します。referenceではdescription全文を取得できます。
- `query_records`：OR最大8枝×AND最大8、sort最大3列。null条件は全状態の全件です。上位Nを指定した場合のみ、sort値が有効な行を対象として境界同値を含めます。不明なsort値の人数は `ranking_unknown_count` に分けます。
- `aggregate_records`：最大5metric、group_by最大3。countはdistinct ID、平均は有効値だけが分母。min/maxは全同値集合参照、best_rankは年がある正整数順位だけ、differenceは左−右です。両IDが同じwhere集合にあることを検証します。集合型のgroup_byは各要素へ展開するので複数groupに属することがあります。同じgroup内では正規化後もIDを重複排除します。上位groupは指定metricの有効値だけを対象にし、不明group数をranking_unknown_group_countへ分けます。

`catalog(dataset)` はfieldごとの型・許可演算・出典・未提供理由を返します。current_group/current_teamは下記「現在所属」の検証済み辞書で導出します。generation_groupは加入グループで、現在所属へ流用しません。初期referenceはsnapshotに実在するdescription!A1の1レコードだけです。他タブは統合済みとしません。

## 値・状態・日付

原文とsource field/元行番号を結果に残します。numberは桁区切り・万・cm/歳を定義どおり解釈し、不正値を0へ変換しません。eq/in/not_inは集合の要素へ完全一致し、TeamCとTeamCIIを混ぜません。contains/starts_withは正規化後のリテラル比較です。

empty/placeholderだけがis_missingに一致します。not_public/formula_error/invalidは三値論理のunknownです。ANDにfalseがあればfalse、ORにtrueがあればtrueとし、それ以外の不明はunknown_countへ計上します。状態矛盾を現役人数へ含めません。条件を満たさないと確定した行をunknownへ上乗せしません。

日付はISO日・年月・年・月日を区別します。大小比較と日付差は完全な年月日が必要です。age_at・加入満年数/序数年・次回誕生日・指定年齢到達日をコードで計算します。`as_of=null` はopen時点のAsia/Tokyo日付を一度固定します。Workflow再開時は保存した `questionDate` をoptionsへ渡すのがE/Fの責務です。生のageはsnapshot取得時点のシート表示値であり、別時点の満年齢へ読み替えません。

2月29日の非閏年における周年/誕生日は保留します。月日だけから生年を補いません。人格設定は属性の根拠にせず、description全文は `engine.description` から同じ版を利用できます。各モデル往復の指示組立はE/Fで実装し、現行の常時入力を変更しません。

## 完全性とページング

全結果にsnapshot/各version/取得時点、条件、matched_count/selected_count/returned_count/unknown_count、coverage、result_set_id、next_cursor、truncatedを付けます。queryでは上位同値追加後がselected_countです。aggregateのmatched/selectedは人数、group_count/selected_group_count/returned_countはgroup数として区別します。

coverage=exact_setは指定した型付き条件に対する完全性であり、質問の解釈の正しさではありません。identityはcandidate_only、textはlexical_matchesです。0件の意味もその検索範囲内に限られ、同義語・概念の不在や回答不能を意味しません。意味索引の採否と品質評価はGへ残します。

cursorはsnapshot・操作・全引数（cursor自身を除く）・計算日・配信済みIDに束縛します。cursorは認証情報ではありません。異なる条件/版/操作・破損したcursorを拒否し、同じページの再試行は決定的です。result_set_idは全選択IDと条件に束縛し、ページ間で不変です。

getはセル単位でページングします。大きなTypedCellはJSON全体をUnicodeコードポイント単位で分割し、`cell_fragment` と `fragment:{field,index,count,encoding:"typed_cell_json"}` を返します。順序・countを検証し、結合後JSON.parseで元のraw/value/型を復元してから完全なセルとして使います。未取得断片を全文として扱いません。queryの大きすぎる単一行はbudget_exceededとなり、IDを取得してgetで長文を読むことができます。

`readResultSet(handle)` はDのコード側描画/検算用で、完全なID配列のコピーを返します。min/maxのtied_set_idとbest_rankのrank_set_idも使えます。20件を超える同値ID/年別順位のpreviewは省略し、完全な集合参照/件数を返します。handleはリクエスト内で保持し、Workflow再開時は同じsnapshot/引数/計算日から再実行して再構築します。モデルに任意の履歴キーやsnapshotを指定させません。

引数64KiB・結果32KiB・走査人物10,000件・保持ID集合計2MiB・1人物のgroup展開100通りを上限化しています。大きすぎる単一項目は成功として切り詰めずエラーにします。全質問のdeadline・累積byte/token/tool回数・モデル往復数はFの責務です。

## 再利用と後続

PR #478のNFKC/Latin声調・空白正規化、別名分割、最長一致、Latin境界、一般英語/短表記の文脈判定、名前探索時だけの有限近似を再利用しました。personIndexはsource+SIDへ置換し、公式ニックネーム/英語名を追加しました。別名候補は最終同定ではありません。旧PR #478は直接mergeせず、本PRを再利用先とします。旧Issue/PRのcloseと正式な再スコープはHで行います。

Dは集合と配信済みIDの照合・決定的描画、Eはprovider関数呼び出し、FはWorkflow/会話/予算/flagとdescriptionの各往復入力、Gは全カテゴリ比較です。gpt-6-luna/medium、5分cache、24時間保持はそのままです。

検証結果はPR本文へ記載します。テストは人工人物と人工説明のみを使い、生シート・質問コーパス・未追跡HANDOFF/調査レポートを公開差分へ含めません。

最終確認：Node.js 24 `npm run verify`（Biome・TypeScript・人工回帰を含む全アプリテスト・評価テスト16件・deploy dry-run）とPRのtest/build/typecheck/lintを確認します。保存済みCSVのオフライン検証では732人物の全ページ取得、SNH48 23期20人/24期9人を確認。生年不明の`????-MM-DD` 23セルを月日精度で保持し、年齢計算へ流用しません。CSVは作業B時点の保存物で、新しい本番疎通・品質評価ではありません。

## 現在所属（current_group / current_team）

検索時にprimary_affiliationとsecondary_affiliation（兼任を含む）から導出するset型項目です。snapshot・構造・catalogの保存バージョンは変えません。辞書はユーザー検証済みのバージョン1（`AFFILIATION_DICTIONARY_VERSION`、`src/sheets/search/affiliations.ts`）で、キーはセルのtrim後の完全一致です。

| ラベル | group | team |
|---|---|---|
| SII, NII, HII, X | SNH48 | ラベル自身 |
| SNH预备生 | SNH48 | 预备生 |
| G, NIII, Z | GNZ48 | ラベル自身 |
| GNZ预备生 | GNZ48 | 预备生 |
| B, E | BEJ48 | ラベル自身 |
| BEJ预备生 | BEJ48 | 预备生 |
| C, K | CKG48 | ラベル自身 |
| CKG预备生 | CKG48 | 预备生 |
| CII | CGT48 | CII |
| CGT预备生 | CGT48 | 预备生 |
| IDFT | IDFT（SNH48に含まない独立グループ） | IDFT |

`暫休/退団`、`SNH荣誉毕业生`、`GNZ荣誉毕业生`（暫休・退団・卒業・毕业を含むラベル）は現在所属ではありません。

- current_group＝主所属と兼任のgroupの重複排除・ソート済み集合、current_team＝teamの重複排除集合（主所属が先）。主所属か兼任かは `primary_affiliation` / `secondary_affiliation` を同時に取得して区別します。`source_fields` は status と両所属列です。
- 状態active：非空ラベルを写像。辞書にも非現在ラベルにもないラベルは `invalid`（reason `unmapped_affiliation`）で不明扱い。写像できるラベルがなければ `invalid`（`no_current_affiliation`）。
- 状態inactive（status 44）：field_state `value` の空集合。eq/inは一致せず不明にも数えず、not_inとis_missingは一致します（空の集合型はis_missing扱い）。
- 状態conflicting/unknown：`invalid`（state_flagsと同じく不明に数えます）。
- 辞書を変更するにはユーザーの検証が必要で、`AFFILIATION_DICTIONARY_VERSION` を上げます。
