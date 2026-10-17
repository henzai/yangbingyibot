# 神スプレ検索ツール設計・作業Aレビュー案

2026-10-17 JST / Epic [#512](https://github.com/henzai/yangbingyibot/issues/512)

状態: 設計レビュー用。実装・既存PRのmerge/close・本番変更・有料評価は行わない。
基準はfetch済み `origin/main` の `de5af4dc7161a665da8fb971c370a5de6cc5b95f`。
OpenAI / `gpt-6-luna` / reasoning effort `medium` / summary offを維持する。

## 継続調査の更新（2026-10-17）

今回の確認箇所は [3分のレビュー依頼](sheet-search-review.md) に絞った。
具体化した [契約v0.2](sheet-search-contract.md) と [4関数のJSON Schema案](sheet-search-tools.schema.json) を追加した。下記のv1/v2集計は調査履歴として保持する。
以降のv0.1契約は初回案として残し、引数・演算の詳細はv0.2を優先する。

820ユニークの質問原文を全件読解し、明示的な個票ごとの意図タグを付けた。56件の同一hash重複へ継承して全876件のv3台帳を作成した。全件に必要source/field/操作/取得順・不足理由を付け、732行のシート表示値に対して候補IDと必要列の値の有無も照合した。
これはLLMの意図読解＋値の存在の機械的照合であり、候補の最終同定、期待回答値の人手gold、実装済み検索の精度ではない。生の質問・候補/値・個票はGit除外済みの `.llm-eval/issue-512-review-v3/` に保持する。旧抽出manifestの対象ファイルは変更していない。

| v3で確認した操作（複数該当、876投稿ベース） | 件数 |
| --- | ---: |
| 単純参照 | 424 |
| 一覧・絞り込み | 188 |
| 説明 | 150 |
| 関係 | 51 |
| 比較 | 46 |
| 集計・派生計算 | 45 |
| 時系列 | 38 |
| 引用/回答の再点検 | 13 |
| 主観・フィードバック | 18 |
| 外部情報・検索以外 | 9 |
| 会話・メタ要求 | 9 |

操作が重複するため合計は876を超える。全件読解は終えたが、曖昧な質問を無理に確定していない。前会話が必要/必要かもしれない投稿は58件。元のBot投稿検索では質問者・sessionの関係を復元できず、真の会話clusterは未確認のまま。
同一hashの重複群は確定できるが、表記揺れを含む近似群は未確定。独立評価用の分割には使わない。

平均年齢/身長、基準人物との同値/大小比較、最良の年別順位、満年数/序数年、配信済み集合の除外、全許可列取得を契約に具体化した。人工対応表は70ケースへ拡張した。
明示年の順位列が空、人物候補が未確定、元所属や在籍期間の時点根拠がない場合はgapを残す。ソースにない事実と、取得手段が未確立な状態を分ける。

今回の到達点は、全件の**意図・取得元/必要列・不足理由**のレビューとschema案の具体化。期待する正解値の全件確定、実行結果の検証、本番CSV同値性、意味検索の採用、token予算の確定は後続の検証事項であり、完了扱いにしない。

### descriptionの常時入力を維持する補足

ユーザーが毎回与えていた説明シートを再確認し、[契約v0.2](sheet-search-contract.md) に保持方針を追加した。人格/回答ルールと短い用語・別名/チームの区別は、ツール方式でも検索前から各モデル往復へ渡す。referenceへ検索を追加しても常時入力の代わりにはしない。
元シートは編集元として保ち、旧TSVのF列/先頭行等の案内は新経路でstable field/ツール結果の説明へ置換する。同じ質問のdescription・catalogを固定し、そのdigestと組立規則もsnapshotへ含める。シート自体は変更していない。

## 1. 根拠と未確認事項

| 資料 | 今回確認できたこと | 確認できていないこと |
| --- | --- | --- |
| ローカル `docs/jev-routing-study.md`、`HANDOFF.md` | 過去の抽出方法、集計、Jev評価の条件と限界 | 旧851件の原文、旧180件の個票、Workbook |
| 接続済みGoogle Sheets | 全20タブのメタ情報・見出し、`test!A1:BA999` の表示値、説明と一部の数式 | 本番サービスアカウントのCSV→parse→構造化snapshot→KVとの同値性 |
| 最新main、#467〜#474、#509、#510、PR #475/#478/#507 | 再利用する読み取り基盤、未mergeの人物索引、現在の回答経路 | ツール方式の品質・遅延・費用。まだ実装も計測もしていない |

旧レポートの原文はローカル未追跡のまま保護する。本書は公開可能な集計・設計だけを扱い、シートURL、個人別データ、Discord原文・生IDを載せない。

### 旧コーパスの所在確認

記録先は `outputs/jev-v5-review/jev-v5-review.xlsx` と `/private/tmp/yangbingyibot-jev-study/`。
主checkout、登録worktreeの実在ディレクトリと評価用ディレクトリ、`/private/tmp`、ホーム配下（Library・Trash・依存物等を除く）のファイル名を、Gitの無視対象を含めて探索した。Driveでも `jev`、ファイル名条件、`yangbingyibot` を検索したが原本は未発見。一部のworktreeは登録だけ、または評価成果物のない残存ディレクトリだった。Gitの全refから該当レポート/Workbookのcommit履歴も確認できなかった。

これは探索した範囲の結果であり、別端末・バックアップ・除外領域にも存在しないと断定しない。所在と探索条件の詳細はローカルHANDOFFへ追記する。2026-10-17の追加指示により、サブエージェントが認証済みChromeのDiscord UIから再抽出した。再抽出は旧851件・旧180件の復元とは区別する。

### 旧レポートの全体集計（原文再確認前）

889投稿 → 有効851、参加通知2、空18、エラー18。NFC・連続空白圧縮・trim後795ユニーク、重複群38、重複群内94件。180件は同じ集合で設計調整を繰り返しており、新方式の独立holdoutではない。

| 操作 | 件数 | 対象範囲 | 件数 |
| --- | ---: | --- | ---: |
| 単純参照 | 505 | 単一人物 | 639 |
| 一覧・絞り込み | 158 | チーム・グループ | 132 |
| 説明 | 106 | 期 | 40 |
| 集計・順位 | 26 | 複数人物 | 20 |
| 関係 | 20 | 全体 | 18 |
| 比較 | 18 | 未特定 | 2 |
| 時系列 | 18 | 合計 | 851 |

操作の合計も851。履歴依存らしい質問27、対象外2。これらは旧自動注釈であり、人手gold・今回の再集計・検索方式の精度ではない。必要列の旧分類は複数該当し、合計が851になる分類ではない。

### 2026-10-17の再抽出と全件台帳

同じBot投稿検索を認証済みChromeの検索結果DOMから37ページ巡回した。表示913件＝IDユニーク913件、重複ID0。1〜36ページは各25件、最終ページは13件。最新・中央・最古の3ページ63投稿を再読し、保存結果と一致した。質問者名は保存せず、質問用コーパスからBot回答を除いた。送信操作・Discord内部API・token取得は行っていない。

| 再抽出結果 | 件数 |
| --- | ---: |
| 質問として保持 | 876 |
| 正規化後ユニーク | 820 |
| エラー文だけのblockquote | 17 |
| 空投稿 | 18 |
| Bot参加通知 | 2 |

有効質問の期間は2024-05-25 23:31〜2026-10-17 00:41 JST。NFC・空白圧縮・trimのSHA-256を持ち、重複は除かず保持する（重複群38・群内94件）。実質問がありBot応答だけtimeoutした1件は有効質問へ残した。

旧レポート期間末の日付までに絞ると889投稿・有効852件・796ユニーク。上のtimeout質問1件を除けば有効851件・795ユニークとなり旧集計の数値と一致するが、**旧原本のID/hashがないため同一集合と証明できない**。旧180件の評価用選定は復元できていない。削除済み/非公開/検索不一致の投稿や会話全体の完全性も、この913件の一致からは保証しない。

原文、page checkpoint、parse/注釈script、audit、manifest、全876件の個票は、主checkoutのGit除外済み `.llm-eval/issue-512-corpus/` に保存した。`/private/tmp` のみには置かない。ただしローカルディスクの保存であり、別媒体へのバックアップまではしていない。manifestにファイルdigestと生成手順を記録し、公開側には原文/IDを移さない。

今回のmanifest SHA-256は `fb26e02cbadad585bc20b9036ccc48bd6f8f4fd5b621140a570bdc6be8382fa0`。主担当でもファイルdigestと原文/台帳のhash対応を検証した。raw pageには監査用のBot回答が残るため、同じく公開対象外とする。

全876件へ必要な台帳列を付与した一次注釈は `auto_provisional_regex_v1`。質問の意味やシート上の回答可能性を確認したgoldではない。

| 一次注釈の状態 | 件数 | 解釈 |
| --- | ---: | --- |
| proposed | 679 | ルールで取得候補を付けられた。実際の対応確認ではない |
| uncertain | 128 | 対象/必要列/意図のレビュー待ち |
| needs_context | 49 | 省略/継続らしい表現。元会話の復元は未完 |
| source_gap | 20 | 情報源の確認/別契約が必要らしい表現 |

一次注釈で操作を検出できない113件、対象範囲未確定239件がある。reference/概念探索の検出が0件になったことも方式の限界であり、「実際に質問がない」という結論にはしない。679件を対応済みやカバレッジ率の分子に使わない。全件の意味のレビュー、近似重複cluster、会話cluster、期待するシート根拠の確認は未完である。

uncertain/source_gap/needs_contextの計197件の質問原文を追加読解したところ、単語境界の誤り、一般語に見えるあだ名、明示比較を履歴依存とする誤り、多言語・短いチーム表記の見逃しがあった。一次注釈の全件見直しが必要である。追加読解はLLMによる意図調査であり、人手goldやシート根拠の検証ではない。

この197件だけのv2 auditはproposed124、needs_context22、semantic_gap5、design_extension24、uncertain15、non_lookup4、source_gap3。v1と別に保存し、v1 proposed679件を再確認済みと扱わない。前質問の想起や言い換えは人物検索不要でも、会話で回答できる質問として設計に含める。

## 2. 情報源とフィールドの棚卸し

現行コードが読むのは設定された `test` と `description!A1`。同じWorkbookに他タブがあることと、現行Botがそれを根拠に回答できることを区別する。質問全体を棚卸しした後に公開するdatasetを決め、人物用APIの都合で他の情報源を永久に対象外にしない。

| タブ群（全20タブ） | 確認した役割 | 検索契約への扱い案 |
| --- | --- | --- |
| `test` | 人物情報の統合表示、先頭3行はメタ情報 | `members` の主情報源。48列の意味を保持 |
| `description` | 用語、グループ/チーム、あだ名の区別、回答指示 | 用語・区別を `reference` の節として取得可能にする。回答指示は検索データと別管理 |
| `code_master`、`参照` | status・tid等の表示変換/参照表 | 読み取り契約の辞書。グループ/状態を推測で補完しない |
| `official_members`、`official_members_snapshot` | 公式由来の人物データと比較用snapshot | SID・更新時点・出典の検証。統合値を無条件に上書きしない |
| `official_performances`、`official_performances_snapshot`、`new_performances` | 公演、比較、検出/通知 | 公演質問の拡張候補。日時のtimezone、更新時点、開催/販売状態、重複キーを確認して `performances` を公開するかレビュー |
| `changed_members` | old/new値と検出日時の差分 | 検出日時を異動日と扱わない。経歴の完全な履歴と見なさない |
| `new_sid`、`official_raw` | 取込差分、raw/取得状態 | 取込検査に使用。raw JSONP全文をLLMへ渡さない |
| `总选` | 年/回別の順位・名前・チーム・票数 | `elections` の拡張候補。人物欄の年別順位と票数を区別する |
| `G2_20260518`、`G6_20260518`、`G7_20260518`、`Gmbti_20250412`、`Gfol_20241101` | 基礎プロフィール、応援色、大学、MBTI、フォロワー数の参照データ | 名称の日付だけで鮮度を断定しない。統合列の由来/時点として保持、未投影情報の必要性を評価 |
| `test_backup`、`2024改` | 旧配置。先頭付近に数式エラーもある | 現在値へ自動混合しない。履歴質問で必要なら版と出典を分離して設計 |

今回の `test` は999行×53列。名前あり732行、SID欠損0・重複0、同名の組15。statusは99が333行、44が388行、空が11行。いずれも今回の表示値の監査結果で、将来の不変条件ではない。
先頭の719は本所属列のCOUNTAで、人数総計ではない。AW:BAのデータ領域は今回空だった。

| 元列 | 情報 | 読み取り契約案 |
| --- | --- | --- |
| A:C | sid、status、sort_tid | SIDを人物IDの第一候補へ。状態コードと並び順を分離。現44列カタログには未収録 |
| D:F | 本所属、兼任先、新人組 | 多値・併記を保持。現在所属・期の加入グループ・状態を別属性にする |
| G | 直近の総選挙順位 | 現44列では未収録。年不明の値を2025/2026等へ自動帰属させない |
| H:I、K:M、X:Y | 名前/ピンイン/イニシャル/あだ名/由来/公式呼称 | 原文・正規化キー・一致元を保持。公式名とコミュニティ別名を区別 |
| J、N:R、AC | 年齢、誕生日、出道日、期数、身長、星座、出道時年齢 | 型と日付精度を付与。月日だけから生年/年齢を作らない |
| S:W、Z:AB | 出身、特徴、趣味、catchphrase、大学、血液型、MBTI | 全体投影・本文探索に対応。空、非公開、placeholder、数式エラーを区別 |
| AD | 口袋フォロワー数 | 数値単位と観測日を保持。シート取得日をフォロワー計測日と同一視しない |
| AE:AH | 応援色と詳細×2 | 4列presetを用意し、色名・詳細を組で返す |
| AI:AU | 2014〜2026年順位 | 年を明示。非空年と正の整数順位が存在する年を別に監査 |
| AV | 経歴 | 改行・長文・段落・出典を保持。切断位置と続きcursorを返す |

Gの非空値は55行、2026年別列は0行。Gを無視して最後の非空年を「最新順位」とする設計は採らない。年別順位の非空件数をそのままランクイン人数とも呼ばない。
SNH48 23期20行/24期9行を再確認した。24期にはstatus=99でも別欄に暫休/退団表示がある。SID違いの同名行や名前基準の兼任数式があるので、自動的に同一人物へ統合しない。

## 3. 質問カバレッジをレビューする方法

別紙 [質問対応表](sheet-search-coverage.csv) は人工質問と既存Issueの公開回帰例による設計レビュー用であり、旧851件の個票ではない。対応表の「期待」は必要能力と根拠で、実装済み・合格を意味しない。

対象範囲6種×操作7種を軸に、識別、任意列、概要、条件集合、同順位、欠損、経歴/時点、言い換え、用語、複合、複数ターン、情報源の限界を点検する。意味のない全直積を埋めるのではなく、空欄の理由と未検証を残す。

再抽出後の個票には `question_id`、原文hash、正規化hash、重複/近似cluster、抽出期間、scope、operations[]、required_sources/fields、history_dependency、expected_evidence、tool_sequence、coverage_status、gap_reason、review_status を持たせる。Bot回答・Jev判定は参考でありgoldにしない。原文不在や前後会話欠落を `missing_context` とし、対象外に押し込まない。

評価では、(1)情報源にあるか、(2)取得能力があるか、(3)モデルが正しく取得したか、(4)回答が根拠に忠実かを別に採点する。全件一覧はID集合の適合率/再現率・件数・重複・別集合混入を照合する。説明は人物と属性/関係の組合せを判定し、正しい否定や別人説明を禁止語の存在だけで失敗にしない。

## 4. ツール契約案 v0.1

Epicの人物向け4ツールを、同じ実行器を使うdataset付きの4操作へ一般化する案。今回の新しい提案であり、命名とschemaはレビュー対象。初期datasetは `members` と `reference`。他タブも上の台帳に残し、公開準備前はcatalog上 `unavailable/not_integrated` とする。「記載なし」と言い換えない。

| ツール | 入力（共通のsnapshotはWorkerが束縛） | 返却する根拠 |
| --- | --- | --- |
| `search_records` | dataset、query、mode=`identity/text/concept`、fields、where、cursor | ID候補、一致field/引用範囲、exact/normalized/alias/approximate/lexical等の方法、曖昧性 |
| `get_records` | dataset、ids、fieldsまたはpreset、cursor | 指定IDの値・欠損理由・出典。長文はfield内cursorでも続き取得 |
| `query_records` | dataset、where、fields、sort、page_size、cursor | 条件を満たす集合handle、全件数、ページ、適用条件、unknown件数 |
| `aggregate_records` | dataset、同じwhere、operation、field、group_by | count/group_count/min/max、分母、欠損/不正値数、同値ID集合handle |

`reference` は説明を節IDで持ち、用語・区別・グループ情報を本文として検索/取得できるようにする。モデルにGoogle Sheets全体への任意rangeやURLを渡さず、公開dataset/fieldの有限catalogを初回promptへ渡す。catalogには型、単位、日付精度、可能演算、状態解釈、presets、datasetの利用可否・時点を含める。

再抽出にはモデル/シート構造/情報源に関する質問のシグナルもある。シートschema・検索可能な項目はcatalogで説明できるが、実行時モデル等はシートの事実ではない。必要なら公開可能なアプリ設定だけの別契約をレビューし、環境変数一覧やsecretを取得するツールにはしない。未設計の間はsource gapとして残す。

### 引数文法と検証

JSON Schemaへの展開元となるレビュー用文法:

```text
Dataset = catalogに列挙されたdataset key
Field = そのdatasetで許可されたstable key
Scalar = string | finite number | boolean
Atom = {field: Field, op: eq|in|lt|lte|gt|gte|contains|is_missing,
        values: Scalar[]}
Where = {any: [{all: Atom[]}]}   # ORの内側にAND。深さ固定
Sort = [{field: Field, direction: asc|desc}]
Cursor = opaque string | null
```

`where=null` は全レコード。空OR/AND配列は拒否し、暗黙の全件化を防ぐ。`eq`は値1個、`in`は1個以上、大小比較は数値/日付のみ、`contains`は文字列のリテラル検索のみ、`is_missing`は値なし。値の型とfieldごとの演算は実行時にも照合する。日付範囲・誕生月日検索はcatalogの専用型へ展開し、任意式は受け付けない。

JSON Schemaは各objectで `additionalProperties:false`、全propertyをrequired、任意項目はnullableとする。field/dataset/operatorはenum化し、array長/文字数を制限する。SQL、正規表現、shell、任意URL、ユーザー指定の数式は公開しない。schemaが妥当でも意味上不正な引数は実行しない。strict対応subsetとSDKでの実検証は作業Eで行う。

所属等の集合型に対する `eq/in` は正規化済み要素との完全一致、`contains` は自由記述の部分文字列一致とする。Team CとTeam CIIを所属の部分一致で混同しない。sortの同値はstable IDで順序を固定し、欠損は末尾に置く。未定義field/演算は再解釈せず拒否する。

人工例:

```json
{
  "dataset": "members",
  "where": {"any": [{"all": [
    {"field": "generation_group", "op": "eq", "values": ["SNH48"]},
    {"field": "generation_number", "op": "in", "values": [23, 24]}
  ]}]},
  "fields": ["full_name", "pinyin", "generation", "primary_affiliation", "secondary_affiliation", "status"],
  "sort": [{"field": "generation_number", "direction": "asc"}],
  "page_size": 50,
  "cursor": null
}
```

これは `query_records` の例。加入グループと現在所属を区別し、グループ不明ならSNH48へ自動補完しない。status指定なしは全状態で、不明・矛盾の件数も返す。

### 共通結果と完全性

結果は `status`、`snapshot_id`、schema/catalog/normalization版、取得時刻、情報の観測時点、`applied_filters`、`records`/集計、`matched_count`、`returned_count`、`next_cursor`、`truncated`、`coverage`、`result_set_id` を持つ。各値はsourceのtab/元行・fieldを参照できる。ログには値や生行番号を出さない。

`coverage` は `exact_set` / `lexical_matches` / `candidate_only` / `partial_scan`。`matched_count`はその方式でヒットした数であり、概念に該当する人物総数ではない。型が不正・欠損の行は通常の大小比較から除外し、unknown件数を残す。0件・未記載・未特定・取得不能・schema不一致・予算超過を区別する。

`exact_set` が保証するのは適用条件に対する集合の完全性であり、自然文からその条件を選んだ解釈の正しさではない。評価では質問の対象・条件と適用条件の一致も独立に確認する。

countはID単位。複数チームへの所属はチーム別集計に複数回現れ得るので、group別合計とunique総数の差を説明する。同順位は全員保持。日付は精度が違えば安易に順序を確定しない。年齢はシート基準日を伴う値とし、質問日時との違いを明示する。

基準人物と同じ大学・同期・加入前後などの関係検索は、基準IDの値を取得してから同じsnapshotの条件集合へ結ぶ。在籍期間の重なりは開始/終了が分かる履歴intervalの交差で扱い、現在所属だけから作らない。期間根拠がなければsource gapを返す。経過年数、誕生日までの日数、数値/日付差分は有限の型付き派生演算として実行器で計算する案を追加する。任意式は許可せず、基準日・timezone・閏日・日付精度・加入日の定義をschemaへ明記する。具体的な派生演算schemaはレビュー待ち。

全件一覧は集合handleに対してWorkerがコード側で全ID/件数を検証・描画する。LLMにはpreviewだけを渡してもよいが、そのpreviewを「全員」と文章化させない。表示名ではなくIDで照合する。Discordの上限までに配信できない場合は未完了と範囲を示す。任意の説明文まで自動検算できるとは扱わない。

### 人物検索と自由記述の探索

人物索引は名前・ピンイン・別名・公式呼称を区別し、NFKC、Latin小文字/声調・区切り、最長一致、短表記、一般語、同名異人を評価する。#478の最大8候補・識別4列だけ・完全一致0件時だけ近似検索というJev用条件を、新APIの再現率の上限にしない。候補上限はcursor付きで、曖昧な候補を1人に確定しない。

自由記述は全人物の特徴・趣味・由来・経歴等を対象に、文字列検索と日中の同義語展開を基線として比較する。概念検索の手段（全文索引/意味検索/列投影を使ったLLM確認）は未決。意味検索のtop-kだけで全件を保証しない。全体の列投影とpage走査を可能にするが、実行予算内に走査できない場合は `partial_scan` を返す。「関連情報は存在しない」と断定しない。ここは一般有効化の前に残す評価ゲートである。

## 5. snapshot・会話・実行予算

SIDをsource名前空間付きIDへ変換し、重複/欠損があれば曖昧性を残す。配列添字を永続IDにしない。内容digest＋版＋情報源から不変snapshotを識別する。全ツール・cursor・集合handleはsnapshotと条件digestに束縛し、別snapshotの混在を拒否する。

5分の可変cacheキーを毎回読み直す方式では不十分。作業Bで内容digestによる不変保存と保持期間を決め、Workflow再開時の参照欠損は明示エラーにする。同一質問内で再取得snapshotへ黙って切り替えない。descriptionと複数datasetも、取得時刻/版の組をsnapshot bundleとして固定する。

会話は既存のuser/model互換、TTL300秒、20entry/64KiB、ユーザー/チャンネル分離を維持。「その人」「他には」「○期も」には、対象ID・条件・前結果の完全性・schema版をversion付き補助metadataとして保持する案。新しい質問では最新snapshotから事実を取り直し、前の回答を正解として再利用しない。明示された新条件が優先で、前ターンの人物/年/条件を無条件にunionしない。

前質問の想起・質問の言い換え・前回答の再点検も対象にする。前二者は同一会話内のuser履歴が根拠であり、人物検索を必須にしない。再点検では元の条件・集合の完全性・シートの値を取り直す。履歴がTTL/容量上限で失われた場合は、その制約を伝える。あだ名や多言語の表記を単語ルールだけで対象外へ分類しない。

以下は計測開始用の**仮予算**。品質やp95の実測値ではなく、実装着手前レビューと作業Gの計測で調整する。

| 項目 | 仮上限・扱い |
| --- | --- |
| 実行全体 | 既存120秒step内の100秒を共通deadlineとし、残りを配信/失敗通知へ確保 |
| モデル/ツール | 最大8tool call、最終回答を含め最大9モデル往復。retryも同じdeadline内 |
| 条件 | OR 8枝×AND 8条件、in 50値、sort 3列、検索query 512文字 |
| 取得 | 1page 50行（指定上限100）、1回20fields/20IDs、結果32KiB、累積128KiB |
| 長文 | 1field最大8KiBで続きcursor。黙って文末を落とさない |
| token | 累積入力/出力の上限を評価snapshotで計測して固定。有料run前に最悪費用もレビュー |

732人の全件一覧を50行ずつモデルに往復させると仮call上限を超える。完全な集合handleからのコード側描画で解決する。全員の長文比較など上限で対応できない質問は設計上のgapとして残し、黙って一部だけの回答にしない。

## 6. Gateway・Workflowの接続境界（後続作業）

現在のGatewayはtext/summary/usage/finishのみで、OpenAI adapterはtool callを表現しない。tools capability、完全な関数引数、call_id、tool結果、継続用opaque provider状態、最終回答/ツール要求の区別を追加する必要がある。SDK型はadapter内に閉じる。

公式の [Function calling](https://developers.openai.com/api/docs/guides/function-calling) に従い、`strict:true`、初期は `parallel_tool_calls:false`。部分引数stream中には実行しない。結果は対応するcall_idへ返し、reasoningを含むoutput itemを順序どおり継続する。[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) のstateless継続に従い `store:false` を維持する。内部reasoningをログや通常履歴へ露出させない。

全往復で `gpt-6-luna` / mediumを維持。Gemini等の既存text経路は保護し、今回ツール非対応時のモデル自動変更は行わない。tool中の推測文はDiscordへ流さず、取得・検算後に最終streamを開始する。一覧は検証完了後に描画する。既存 `streamGeminiAndEditDiscord` のstep名・retry 0・checkpoint互換を保つ設計を作業Fで確定する。

callCount=1固定を廃止する後続変更が必要。各往復のusage/cached input/reasoning、attempt/retry、全体合計、検索時間、最初の最終回答textまでの時間を計測する。ツール失敗でlegacyへ自動fallbackして完全な一覧を推測しない。比較用legacyはflagで明示選択する。

## 7. Jev資産の再利用と整理案

| 資産・Issue/PR | 推奨方針（今回は未実施） |
| --- | --- |
| #468/merged #475、列catalog、構造化snapshot、cache互換/テスト | 保持・48列/型/出典・不変snapshotへ拡張。Jevという命名だけで削除しない |
| #469/draft #478の人物索引・正規化・人工fixture | 必要部分を再スコープして再利用。stable ID/全候補/公式別名等へ契約変更。敬称付き部分一致とピンイン区切りの未対応指摘も検証 |
| #478のschema_mismatch懸念 | 本番CSV経路と年見出しの同値性を作業Bの必須ゲートへ。手で見出しを補った比較を本番検証に数えない |
| #478自体 | 既存PRを転用する案を第一候補とし、独立索引の意味をレビューしてから決定。移植する場合は二重mergeを防ぐ移行記録を残す |
| Jev client、46判定、A/B state、閾値、専用flag/secret/metrics | mainに実行経路は見つからない。新設しない。存在しないものを削除済みと報告しない |
| 人物概要・応援色・年別順位の展開 | presetとして再利用。確率/閾値から分離 |
| docs/jev-sheet-structure.md、catalogコメント | 検索基盤の文書へ改名/更新する案。過去の調査結果は履歴を保持 |
| #467、#470〜#474 | #512のA〜Gへの移行先と不要理由を記録して整理する。今回はcloseしない |
| #509、#510 | 完全性/描画とGateway接続のトラックとして継続。検索実行器を二重実装しない |
| ローカルレポート・HANDOFF・質問集・評価Workbook | cleanup対象外。生データはGitへ入れず、永続ローカル保管とmanifestで管理 |

## 8. レビューゲートと次作業

- [x] 旧資料の探索結果と再抽出の来歴・件数・hash・欠損を記録し、旧851件の全件確認と区別する。
- [x] 再抽出の全876件に個票とcoverage_status/gap_reasonを付け、一次注釈と会話復元不能を明示する。
- [x] 820ユニーク全件を読解し、全876件の意図・取得元/必要列・不足理由をv3個票へ反映する。
- [ ] 人物同定/期待回答値、近似重複/会話cluster、未確定意図を評価用に確定する。
- [ ] 人工対応表の不足、人物以外のdataset、4操作への一般化、概念検索の方法をレビューする。
- [ ] 元列48・SID/状態/年/欠損の契約、本番CSVとの同値性、不変snapshotの保持方式を確認する。
- [ ] strict schema、引数/応答/完全性・予算・例外経路を確定する。今回のv0.1を実装済みschemaとは扱わない。
- [ ] ユーザーレビュー後にB〜Fの実装へ進む。Aは原文棚卸しが終わるまで完了扱いにしない。

評価は再抽出の重複/近似・同じ会話を分割しないclusterで設計用と未使用評価用に分ける。旧180件を発見しても独立評価用に戻さない。人工複数ターン、別人/別グループ、状態矛盾、日中言い換え、長文、欠損、cursor改変、snapshot失効、失敗・再開・配信重複を加える。

再抽出集合には旧評価質問が含まれる可能性が高く、旧個票不在では混入を照合できない。単に再分割したものを独立holdoutと呼ばず、未使用の人工/新規質問を別に確保する。設計用に読んだ範囲と評価用の来歴も記録する。

同じsnapshot/モデル/effortで、全TSV・共通実行器の決定的ルート・LLMツールを比較する。ID集合/件数の回帰ケースは完全一致を要求し、その他はカテゴリ別の品質/保留/未対応とp50/p95遅延・実usage/費用を報告する。全体平均で未対応カテゴリを隠さない。品質の人手確認、token予算と費用上限のレビュー前には有料評価を開始しない。

今回の成果は作業Aの調査・設計であり、Jev整理や本番切替の完了ではない。実装後のreleaseは別途merge承認、main CI/deploy、HTTP/log、Discord E2Eのaction-time確認、scheduled health確認を必要とする。
