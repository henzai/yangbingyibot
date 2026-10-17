# 読み取り専用ツール契約 v0.2（設計案）

Epic #512 / 設計PR #513。アプリへの接続、実API実行、schemaのAPI受理確認は未実施。
具体的な引数は [4関数のJSON Schema](sheet-search-tools.schema.json) を参照する。
初期datasetは `members` / `reference`。公開catalogにはdatasetごとの利用可能field・型・演算・出典・未提供理由を必ず添える。
共通enumにあるfieldでも、対象datasetで未提供なら拒否する。schemaのenumは情報が存在するという保証ではない。

## descriptionシートは毎回の共通入力として残す

現行コードは `description!A1` をbuildAnswerPromptのsystemInstructionへ入れている。2026-10-17の再確認時は1,692文字で、人格/回答方針と解釈の前提が混在していた。
ツール方式へ移す際も、この内容を検索ツールから取得したときだけ有効になる構成にはしない。初期版は、短い指示と共通前提を各モデル往復に引き続き含める。

| 内容 | 新方式での扱い |
| --- | --- |
| 根拠の制約、人格設定、簡潔さ、人名/呼称/表記/星座等の回答ルール | 毎回のアプリ管理の指示として保持。人物データやツール結果と分ける |
| 用語、別名と公式呼称、似た名前/チーム名の区別 | 短い共通前提として検索前から毎回与える。用語質問の根拠としてreferenceからも取得可能にする |
| グループ/チーム等の説明 | 共通前提として与えるが、現在の所属/活動状態/全件性を保証するfilter enumにはしない。実データと矛盾したら出典/時点を確認 |
| 「あだ名はF列」「先頭3行はヘッダー」等 | ツール経路ではstable fieldと型付き結果の説明へ置換。元CSVの行/列検証はWorkerが担当。legacy経路の元descriptionは保持 |

元シートは編集元として維持し、ユーザーにコードと二重編集させない。アプリが既知の節/設定からルールと共通前提を決定的に組み立てる。毎回LLMへ分類/書換えを依頼しない。
将来説明が大きくなった場合だけ、詳細用語や参考知識をreferenceへ寄せる。人格・回答方針・検索に必要な区別事項は常時入力に残す。

「毎回渡す」は各モデルrequestへ含めるという意味で、毎往復Sheetsへアクセスする意味ではない。同一質問の開始時に取得/cacheしたdescriptionとcatalogを固定し、最終回答まで同じ版を使う。
descriptionのdigest・組立規則の版もsnapshot bundleへ含める。会話履歴やprovider側の記憶だけに依存して指示を省略しない。
description取得失敗時、保持すべき指示を黙って空にして新方式を継続しない。検証済みcacheの可用性を確認し、なければ設定/情報源エラーとして扱う。

人格設定は応答の役割であり、その人物の年齢・経歴等の根拠ではない。人格に関する属性質問も人物データを取得する。一般の人物セル・ツール結果に含まれる文章を指示へ昇格させない。
これらは設計上の保持方針であり、今回シートやアプリの動作は変更していない。

## 質問から必要になった操作

全820ユニーク（876投稿）の意図をLLMで読解した。正解値や人物IDの人手確定、実行結果の評価とは区別する。

| 必要なこと | 契約での扱い |
| --- | --- |
| 名前/別名/公式呼称/表記揺れ | identity検索→候補ID付き取得。別名一致を最終同定とは扱わない |
| 任意の人物項目、「全部」、複数人物比較 | fieldsまたはpresetで取得。「全部」はoverviewへ縮めず `all_available` をcursorで読み切る |
| 全体/所属/期/年齢/身長/誕生日で一覧 | 同一snapshot上の型付き条件。人物IDなしの全体投影も可能 |
| あだ名がある/ない、他にも | `is_present/is_missing/not_in`。前回配信済み集合の除外は会話内metadataから行う |
| 一番/上位数人/同値、平均年齢・平均身長 | min/max/mean/countと安定sort。上位Nは境界の同値を保持し、追加人数を示す |
| 最良の年別順位、何cm/何日違うか | `best_rank/difference`。年度と数値/日付型を保持して計算 |
| 同期/同年齢/同身長/同大学の人 | 基準IDの値を取得→同一snapshotへ条件を適用。基準の曖昧さを残す |
| 入団何年目、加入からの年数、誕生日/指定年齢まで | 有限の派生field＋calculation_context。基準日と規則を固定 |
| 元所属/移籍/在籍重複期間 | 経歴を取得。開始/終了の根拠があればintervalを作り、なければ不明とする |
| 用語/人格設定の参照、前質問の想起、言い換え | referenceと現在の会話を使う。人物検索を必須にしない |
| 根拠の再点検、引用された旧回答の検証 | 引用文を事実と扱わず、ID/条件/原文値を再取得 |

## 型と正規化

| 型/対象 | ルール |
| --- | --- |
| 人物ID | source名前空間＋SID。名前や配列位置をIDにしない。欠損/重複/衝突時は同定不能を返す |
| 所属・状態 | raw本所属/兼任/新人組/statusを残す。current_group/teamはSIDを結んだ検証済み辞書/情報源から作る。加入グループから現在グループを補わない |
| 期 | raw、加入group、整数の期を保持。漢数字/算用数字は同値、別groupの同じ期は別集合 |
| 数値 | 数値・単位・原文・妥当性を保持。万/桁区切りは定義どおり変換。不正値を0にしない |
| 日付 | 日/月/年の精度を保持。月日だけから生年を作らない。大小比較に必要な精度がなければunknownへ |
| 年齢 | raw `age` はシートの基準日付き表示値。指定時点の `age_at` は完全な生年月日から別計算する |
| 集合型 | 所属や別名等のeq/inは要素との完全一致。TeamCをTeamCIIへ部分一致させない |
| 自由記述/表記 | containsはリテラル部分文字列、starts_withは先頭一致。別名集合では分割した各表記へ適用する。日中の言い換えや概念一致と混同しない |
| 欠損 | empty/placeholder/not_public/formula_error/unavailable/invalidを分離。is_missingはempty/placeholder、is_presentは妥当な値のみ。非公開や数式エラーを「該当しない」と数えない |

在籍条件なしは全状態。activeを求めたときだけ、レビュー済み状態解釈を適用する。
status=99と別欄の暫休/退団表示が矛盾する場合、activeへ無条件に含めずunknownに計上する。
「新人」「比較的新人」「現役」「正規メンバー」の定義が不足する場合は、採用した条件を明示するか未確定を返す。閾値を隠して結果を断定しない。

## 引数と実行時の必須検証

全objectはclosed、全propertyはrequired、任意値はnull。各ツールのschemaはローカル$defsで自己完結する。
providerのstrict対応は作業Eで実APIを使わないSDK/fake testから確認し、API受理は承認済み評価で別確認する。

- 条件はOR最大8枝、各AND最大8項目。nullは全件、空のOR/ANDは不正。
- eq/大小比較は値1個、in/not_inは1〜50個、contains/starts_withは文字列1個、is_missing/is_presentは空配列。field型と演算も照合する。
- `get_records` はfields/presetのどちらか一方。ID最大20、fields最大20。`all_available` は許可列だけを結果byte上限内でcursor取得する。
- 検索文字列512文字、sort最大3列、page_sizeは1〜100（通常50）、cursor最大2048文字。引数全体は64KiBまで。
- datasetにないfield、未知ID、未知preset、数値にcontains、文字列の大小比較、不正日付、snapshot違いのcursorは実行しない。
- 文字列検索の空白/NFKC/声調/区切りの規則はversion化する。簡繁体・発音・似た名前の候補化と、同一人物の確定を分ける。

queryの `top_n` はnullまたは1〜100。指定時はsortが必須で、全条件集合をsortしてN件目の同値を含む集合を先に確定し、その後pageを切る。
page_sizeとtop_nを同一視しない。例えばpage_size=50であっても、それだけで「上位50人」とはしない。

`exclude_previously_delivered=true` は同じ会話の直前集合から**実際に配信済みのID**を除く。モデルに履歴キーを指定させない。metadata欠損ならmissing_context。
別ターンでは条件と事実を最新snapshotで取り直すが、過去に何を配信したかという履歴は保持する。旧集合にしかない事実を新回答へ混合しない。

## 集計・派生計算

`aggregate_records` は同じwhereを使用し、最大5metrics、group_by最大3列。

| metric | field / operands | 意味 |
| --- | --- | --- |
| count | field=null、operands=null | 条件に合うdistinct ID数。group_byありでgroup_count |
| min/max | numeric/date field、operands=null | 全同値のID集合handleも返す。欠損/不正の数を別返却 |
| mean | numeric field、operands=null | 有効数値だけが分母。母集団/有効数/欠損数/単位/丸め前の値を返す |
| best_rank | election_history、operands=null | 正の整数順位の最小値と該当年。G列の年不明順位や空欄/0を混ぜない |
| difference | numeric/date field、left_id/right_id | 左−右。両IDは同じdataset/snapshot/whereに属すること。group_byとの併用は拒否。日付差は日数と精度を返す |

集計結果のページングもsnapshot/条件/metricに束縛する。groupの同値はcanonical key、人物の同値はstable IDで順序を固定する。
上位Nをコード側で描画する場合はN件目の値と同値の全IDを追加し、その人数を明示する。先にN件へ切り捨ててから「同値なし」と判定しない。

aggregateの `sort_metric_index` はmetrics配列内の位置、`sort_direction` はasc/desc、`top_n` はnullまたは1〜100。存在しないmetricの位置は拒否し、top_n指定時はmetric指定が必須。平均が最大のチームはgroup_by→mean→そのmetricをdesc/top_n=1として実行器で決める。丸める前の値で比較し、同値groupは全件返す。

`calculation_context` は `as_of` と `target_age`。as_of=nullならWorkerが質問開始時のAsia/Tokyo日付を束縛する。指定日がある場合のみ質問の明示日へ変更する。
target_ageは指定年齢までの日数にだけ使い、0〜120。不要なtarget_ageや型と合わない計算は拒否する。

| 派生field | 定義 |
| --- | --- |
| age_at | 完全な生年月日からas_ofまでの満年齢 |
| tenure_completed_years | 定義した加入日からの満年数 |
| tenure_ordinal_year | 加入日以後は満年数＋1。加入日前はinvalid。経過年数と混同しない |
| days_until_birthday | 次回の誕生日までの日数。当日0、翌年への繰上げを明示 |
| days_until_target_age | target_age到達日までの日数。既に到達していれば到達済みと符号付き差を返す |

年をまたぐ比較では基準日/日付精度を必須にする。2月29日生まれの非閏年は曖昧さを避け、初期契約では計算を保留し理由を返す。暗黙に2月28日/3月1日へ補正しない。
「同時期」「背が高い」等の幅はユーザー指定がない限り未確定。解釈した日付幅/身長閾値を明示してから条件を適用する。

## 結果と失敗の契約

結果にはstatus、snapshot_id、schema/catalog/normalization版、source時点、applied_filters、records/metrics、matched_count、selected_count、returned_count、unknown_count、next_cursor、truncated、coverage、result_set_idを付ける。
各値はfield_stateと出典を持つ。候補ID/行・時点・根拠抜粋は回答に必要な範囲で返し、ログへ生データを出さない。

matched_countはwhereに合う母集団、selected_countはtop_nと同値追加の後の集合、returned_countは今回のpage。result_set_idはselected集合に束縛する。top_n=nullならselected_count=matched_count。集計では母集団人数とgroup数を別に返し、group pagingの件数と混同しない。

coverageはexact_set/lexical_matches/candidate_only/partial_scan。exact_setは指定条件への完全性で、自然文の解釈の正しさではない。
0件、ID曖昧、not_integrated、field_unavailable、missing_context、schema_mismatch、snapshot_expired、invalid_arguments、budget_exceeded、source_errorを区別する。
概念検索の未提供や失敗を「シートにない」と説明しない。

一次契約のsearch modeはidentity/textのみ。概念は同義語を含む複数のtext検索や列投影で根拠を探し、全走査が終わらなければpartial_scanとする。意味索引の採否は作業Gの比較で決める。自由記述を使う質問を対象外へ分類するための制限ではない。

一覧の最終配信はresult_set_idの全ID・件数をコードで照合してから行う。モデルpreviewと配信済みIDを分け、全員の代わりに上位候補だけを出さない。
仮予算（100秒/8tool call/9モデル往復/32KiB結果/128KiB累積）は設計書から維持する。上限超過を途中結果の成功にしない。実測・token上限の確定は作業F/Gで必須。

## 作業Aの到達点と後続ゲート

全876件の意図と必要なsource/field/操作/未確定理由をv3台帳へ記録した。820ユニークは全件読解、同一正規化hashの56重複は注釈を継承した。
これは「全876件の正解が確定」「新方式が全件回答できる」という意味ではない。

作業Bで本番CSV同値性・SID/状態・不変snapshotを確認し、Cで候補/検索/型付き演算、Dで集合描画、E/Fでツール継続と予算を実装する。
曖昧な人物同定、原会話の欠落、近似重複cluster、期待する回答値の正解データ、概念検索の再現率は評価側の未完事項として保持する。原文を見た集合を独立holdoutと呼ばない。
本番全面切替はカテゴリ別の品質確認まで行わず、legacyを維持する。実装開始・merge・有料評価・本番切替の各承認範囲は区別する。
