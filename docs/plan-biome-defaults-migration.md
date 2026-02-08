# Biome デフォルト設定への移行プラン

## Context

Biome 導入 PR では既存のコードスタイルを維持する設定（`lineWidth: 140`, `quoteStyle: "single"`）で開始した。
このプランでは Biome のデフォルト設定に移行し、設定ファイルをより最小限にする。

## 変更内容

### 1. `biome.json` から `lineWidth` と `quoteStyle` を削除

```diff
 {
 	"formatter": {
-		"lineWidth": 140
 	},
 	"javascript": {
-		"formatter": {
-			"quoteStyle": "single"
-		}
 	}
 }
```

これにより Biome デフォルトが適用される:
- `lineWidth`: 140 → 80
- `quoteStyle`: `"single"` → `"double"`

### 2. `biome check --write .` でコードベース全体をリフォーマット

- すべての文字列リテラルが double quotes に変更される
- 80 文字を超える行が折り返される（大幅な diff が発生する）

### 3. `.editorconfig` の整合性確認

現在の `.editorconfig` に `quote_style` の設定はないため変更不要。

## 注意事項

- コードベース全体に大きな diff が発生するため、他の PR とのコンフリクトに注意
- この PR は他の機能変更と混ぜずに単独で行う
