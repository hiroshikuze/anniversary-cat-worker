# テスト方針・診断手順

## テストの種類

| スクリプト | 実行方法 | 外部API | 用途 |
| --- | --- | --- | --- |
| `scripts/test-bot.mjs` | `npm test` | 不要 | bluesky-bot.jsのロジック検証 |
| `scripts/test-suzuri-api.mjs` | `node scripts/test-suzuri-api.mjs` | SUZURI API | SUZURI API動作確認（実商品が生成される） |
| `scripts/health-check.js` | GitHub Actionsのみ | 必要 | 本番Worker・Gemini APIのE2Eチェック |

## ユニットテスト方針

- 外部APIへの接続は`globalThis.fetch`をモックして代替する
- Cloudflare Workers専用API（WASM等）はexportした差し替え関数（`_setXxxForTest`）でモックする
- テストケースは「正常系」「境界値」「エラー系」の3パターンを書く
- 新しい関数を追加したら対応するテストを`scripts/test-bot.mjs`に追加する

## 問題発生時の手順

1. ユーザーにCloudflare WorkersのLogsタブ（Begin log stream）を確認してもらう
2. ログパターンから原因を特定（下記参照）
3. コードを修正してpush → GitHub Actionsタブで確認

## Cloudflare Workersログパターン

| ログパターン | 意味 |
| --- | --- |
| `[research] model=... sourceUrlKind=grounding` | 正常。grounding チャンクからURL取得 |
| `[research] ... sourceUrlKind=vertexaisearch-skipped` | vertexaisearch URLを除外してフォールバックへ |
| `[research] ... sourceUrlKind=google-search-fallback` | 直接URLが取れずGoogle検索URLで代替 |
| `[generate] Gemini success model=gemini-2.5-flash-image` | 正常 |
| `[generate] model=xxx unavailable(404)` | そのモデルは廃止済み → `KNOWN_CANDIDATES`を更新 |
| `[generate] model=xxx quota exceeded` | クォータ超過 |
| `[generate] ALL SOURCES FAILED` | GeminiもPollinationsも全滅 |
| `[bot] research 完了 theme="xxx"` | 記念日取得成功 |
| `[bot] generate 完了 source=gemini` | 画像生成成功 |
| `[bot] Bluesky 投稿 完了` | 投稿成功 |
| `[bot] エラー: xxx` | どこかで失敗（メッセージで原因特定） |

## Botの手動テスト（本番発火）

1. `wrangler secret list`で必要なシークレットが揃っているか確認
2. Workers & Pages → `anniversary-cat-worker` → Triggersタブ
3. Cron Triggersセクションの「Execute」ボタンをクリック
4. Logsタブ → Begin log streamで結果を確認
5. 確認後、Blueskyアプリで投稿を手動削除

## SUZURI APIテストスクリプトの注意事項

`node scripts/test-suzuri-api.mjs`を実行すると実際にSUZURIに商品が作成される。
確認後はSUZURIの管理画面から手動削除すること。

```bash
export SUZURI_API_KEY=<APIキー>
node scripts/test-suzuri-api.mjs
```
