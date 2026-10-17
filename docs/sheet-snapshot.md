# 検索用snapshot基盤（Epic #512・作業B）

## レビュー要点（約2分）

**今回の判断点は、この基盤PRをmergeしてよいかの1点です（推奨）。**
人物データ・説明文・列定義を質問開始時の版へ固定する保存基盤です。
検索ツールの回答経路への接続は作業C〜Fで行います。

- 元シートの48列と元行番号を保存し、SIDで人物を識別します。同名人物をまとめず、数式エラーも隠しません。
- description全体とdigest・規則の版を同じsnapshotへ保存します。毎回のモデル入力から説明を外す変更はありません。
- 不変snapshotは**24時間・最大2MiB**。消失・期限切れ・破損時は読み取り失敗を返し、別の最新版へすり替えません。従来の回答は既存TSV経路を使います。

merge前の承認と、後続の検索実装・有料評価・本番切替の承認は区別します。

## 読み取り契約

| 対象 | 今回の契約 |
| --- | --- |
| 列/行 | catalog/schema version 2。従来44列にSID・status・sort_tid・年不明の直近順位を追加。旧44列の並びは維持し、全48列を保存。元の1始まり行番号も保持 |
| 人物ID | `member:<source fingerprint>:<SID>`。名前・並び順をIDにしない。SIDは正の10進文字列で保持し、欠損・不正・重複時は人物読み取り全体をunavailableにする |
| 空行/名前エラー | SIDと識別4列が全て空の行だけを人物集合から除き、除外元行番号を返す。snapshotの元行自体は保持。SID付きの氏名数式エラーは人物行へ残し、field stateを区別する |
| 期とグループ | 原文＋加入グループ＋整数期。漢数字/全角数字を解釈。不明書式はnull。加入グループから現在の所属グループを生成しない |
| 状態 | status 99をactive、44をinactiveと読む。ただし99と本所属/兼任欄の暫休・退団等が矛盾する場合はconflicting。その他はunknown。active条件はconflictingを含めない |
| 年 | 年別の正整数順位からavailableYears/latestDataYearを検証。G列の直近順位は年不明のまま保存し、最新の年別列へ結び付けない |
| 欠損 | empty/placeholder/not_public/formula_error/valueを分離。数値・日付等のfield別妥当性と演算は作業Cで追加 |
| description | 元文を変更せず保存し、descriptionDigestとdescriptionPolicyVersion=1を保持。ツール向け指示の決定的な組立は後続。元シートを編集元として維持 |

SIDの将来の再利用や誤った付け替えを自動検出できる保証はありません。
source fingerprintは既存cacheと同じくspreadsheet ID・データtab名・説明tab名から作ります。
名前検索・現在所属の辞書・概念検索・reference datasetはこのPRでは提供しません。

## 不変性、保存、再開

`sheet_snapshot:v1:<source fingerprint>:<snapshot ID>` を既存KVへ保存します。
contentDigestは行・説明・source・各versionを含む正規化された内容をhash化します。
snapshot IDはさらにcapture時刻と期限を含む完全な保存JSONのhashです。
同じ内容でも取得時刻が違えば別IDになり、同じキーへの書込みは常に同じbytesになります。
capture前の入力や読み出し結果を変更しても保存済みの値は変わりません。

capturedAtはアプリが取得結果を保存した時刻であり、シート自体の更新時刻ではありません。
Sheetsのデータtabと説明tabの読み取りは原子的ではありません。両方の取得後にbundleを固定する保証です。
TTLはcaptureから24時間の絶対期限です。再開のたびに延長しません。
24時間を超える再開はsnapshot_expired等として後続経路が明示処理する必要があります。
退避・更新履歴の永久保存を目的にしていません。

不変キーへのputをawaitした後に、従来の5分cacheへ小さなsnapshotRefを保存します。
Workflowの既存step名/TSV/descriptionを維持し、戻り値には参照だけを任意追加します。
構造化本体をstepの戻り値へ追加しません。旧checkpointには参照がなくても互換です。
cache更新後の再開は保存済みrefを指定して同じbundleを読みます。
読み出し時にはsource・各version・期限・内外digest・行形状・SID一意性を検証します。

KVには[結果整合性](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)があり、put成功直後の別拠点での取得まで保証するものではありません。
missingはnot_found、KVエラーはstorage_error、破損はinvalid_snapshotとして返します。
いずれも最新の可変cacheへfallbackしません。後続のツール経路でのretry/ユーザーへの説明は作業Fの責務です。
保存失敗・説明空・サイズ超過等ではrefを作らず、既存TSV cacheの保存を試みます。

version 1の構造情報を含む旧cacheはTSV/descriptionを保持して再取得します。
再取得失敗時のinvalid_snapshot sentinelと既存の5分fallbackを維持します。
snapshot未作成のready cacheは最大で既存の5分TTLが切れるまでrefなしで使われます。

## 実データの読み取り確認（2026-10-17 JST）

本番ライブラリgoogle-spreadsheetが利用するCSV exportと同じURL形式から、HTTP 200のCSVを読み取りました。
接続済みSheetsから取得済みの表示値と全999行×48列を比較し、差分は0セルでした。
サービスアカウントの認証を使う本番コードの疎通確認は未実施です。
nativeシートの編集、LLM API実行、デプロイはしていません。

| 確認項目 | 結果 |
| --- | --- |
| CSV / 既存規則で保持するデータ行 | 400,468 bytes / 996行（見出し3行を除く） |
| SIDあり人物行 | 732行、SID欠損/重複なし。うち氏名が値721行・数式エラー11行 |
| 識別子が空の非人物行 | 264行。行の削除ではなく人物投影からの除外 |
| 状態 | active 292 / conflicting 41 / inactive 388 / unknown 11 |
| 期の書式 | 値ありの全セルを解釈。現在所属の保証には使わない |
| 年 | 最新の年別データは2025。2026の見出しやG列から補完しない |
| 説明 | 1,692文字を同じbundleへ保存し、読み戻し成功 |
| 保存サイズ | 不変bundle 505,085 bytes / TSV併存cache 947,620 bytes / ref 194 bytes |

以前の棚卸しで「名前あり732」とした件数には11件の氏名数式エラーが含まれていました。
732は今回確認したSID付き行の件数であり、正常な氏名が732件得られたという意味ではありません。
実データ・比較結果詳細はGit除外のローカル調査領域へ保存し、公開fixtureは人工データだけを使います。

この確認は本日時点の情報源の形状・保存可能性の検証です。将来のschemaや、質問への正答率を保証しません。
テストでは版更新後の旧snapshot再読込、source不一致、期限/破損/消失、SID衝突、説明空、容量上限、KV保存失敗、旧cache/checkpoint互換を確認します。
