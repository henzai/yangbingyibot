# English Discussion TTS

英語ディスカッションの準備用テキストを音声(MP3)に変換するツール。

## セットアップ

```bash
cd tools/english-tts
npm install
```

### Google Cloud の認証

以下のいずれかで認証:

1. **サービスアカウントJSON (ファイル)**
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
   ```

2. **サービスアカウントJSON (環境変数)**
   ```bash
   export GOOGLE_SERVICE_ACCOUNT='{"type":"service_account",...}'
   ```

> Google Cloud プロジェクトで **Cloud Text-to-Speech API** を有効にしておく必要があります。

## 使い方

```bash
# テキストファイルから音声を生成（output/ ディレクトリに保存）
node tts.js example.txt

# 出力先を指定
node tts.js example.txt my-speech.mp3
```

## 設定

`tts.js` の先頭で音声設定を変更できます:

- `VOICE.name` - 音声の種類（[利用可能な音声一覧](https://cloud.google.com/text-to-speech/docs/voices)）
- `AUDIO_CONFIG.speakingRate` - 読み上げ速度（0.25〜4.0、デフォルト: 0.95）
- `AUDIO_CONFIG.pitch` - 声の高さ（-20.0〜20.0、デフォルト: 0）

おすすめの音声:
- `en-US-Neural2-J` (男性、デフォルト)
- `en-US-Neural2-C` (女性)
- `en-US-Studio-O` (男性、高品質)
- `en-US-Studio-Q` (女性、高品質)
