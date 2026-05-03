# テスト方針・診断手順

## テストの種類

| スクリプト | 実行方法 | 外部API | 用途 |
| --- | --- | --- | --- |
| `scripts/test-bot.mjs` | `npm test` | 不要 | bluesky-bot.js / r2-storage.js / ウォーターマーク座標計算のロジック検証 |
| `scripts/test-suzuri-api.mjs` | `node scripts/test-suzuri-api.mjs` | SUZURI API | SUZURI API動作確認（実商品が生成される） |
| `scripts/health-check.js` | GitHub Actionsのみ | 必要 | 本番Worker・Gemini APIのE2Eチェック |
| `scripts/test-gemini-image-timing.mjs` | `GEMINI_API_KEY=xxx node scripts/test-gemini-image-timing.mjs` | Gemini API | Gemini画像生成の所要時間計測（競合設計の根拠取得用） |
| `scripts/test-fal-models.mjs` | `FAL_KEY=xxx node scripts/test-fal-models.mjs` | fal.ai API | fal.aiモデル比較（解像度・サイズ・速度の実測） |

## ユニットテスト方針

- 外部APIへの接続は`globalThis.fetch`をモックして代替する
- Cloudflare Workers専用API（WASM等）はexportした差し替え関数（`_setXxxForTest`）でモックする
- Cloudflare R2バケットはget/putを持つモックオブジェクトで代替する
- ブラウザ専用API（Canvas・Image等）を使う関数は、**純粋な計算ロジックを切り出して**テストする
  - `applyWatermark()`の座標計算 → `_calcWatermarkLayout()`として切り出し、`window._calcWatermarkLayout`に公開
  - テストファイルに同名の同等関数を定義して計算結果を検証する
- 外部API呼び出しを含む非同期ロジックは、**依存関数を引数で受け取る形に切り出して**テストする
  - `handleGenerate()`の2フェーズレース → `_twoPhaseRace(tryGemini, tryPollinations, priorityMs)`としてexport
  - テストでは`priorityMs`を短縮（500ms等）し、遅延関数を引数に渡してモック不要でロジックを検証する
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
| `[bot] Mastodon 投稿 完了 id=xxx` | Mastodon投稿成功 |
| `[bot] Mastodon 投稿 失敗: xxx` | Mastodon投稿失敗（error級。シークレット設定済みでも発生する） |
| `[bot] Mastodon 未設定・スキップ` | MASTODON_INSTANCE_URLまたはMASTODON_ACCESS_TOKEN未設定（正常スキップ） |
| `[bot] Discord 通知失敗: status=400` | Discord 2000文字超過（`notifyDiscord()`の切り詰めロジックで本来は発生しない） |
| `[bot] Discord 通知失敗: xxx` | Discord Webhookへの接続失敗またはタイムアウト |
| `[bot] エラー: xxx` | どこかで失敗（メッセージで原因特定） |
| `[pool] YYYY-MM-DD 完了 N件` | プール生成成功。Discord通知にも `📊 生成...` が届く |
| `[pool] YYYY-MM-DD 既存プールあり・スキップ` | 同日に2回以上Cronが発火した（冪等・問題なし） |
| `[research] pool hit date=... theme="..."` | プールから記念日を取得（正常） |
| `[research] pool hit date=... fallback=true` | 季節の花補充エントリを使用（プール候補不足） |
| `[bot] research プール取得 theme="..."` | Bot CronがプールからテーマをピックアップDone |

## リサーチプールCronが未発火だった場合

**Cron式**: `0 15 * * *`（毎日 0:00 JST）

### 影響：サービスは自動継続する

プールが存在しない場合、Bot Cronとユーザーの`/research`リクエスト両方が`handleResearch()`をリアルタイム呼び出しするフォールバックに自動移行する。**Bot投稿もユーザー手動生成も止まらない**。

| 利用元 | プールあり | プールなし（Cron未発火時） |
| --- | --- | --- |
| 7:00 JST Bot Cron | プールから1件選択 | リアルタイムGeminiリサーチにフォールバック |
| ユーザーの`/research` | プールから1件選択 | リアルタイムGeminiリサーチにフォールバック |

品質面では「`google-search-fallback`除外・重複除去が効かない」違いのみ。通常運用への影響は軽微。

### 未発火の検出

1. 0:00 JST 頃に Discord の `📊 生成...` 通知が来なかった
2. Cloudflareダッシュボード → 設定タブ → **トリガーイベント** で `0 15 * * *` のエントリが存在しない

エントリが存在しない場合はインフラ側の問題（コードバグではない）。

### 手動復旧（プールを後から生成する場合）

Bot Cronと同じ手順で Scheduled を送信するだけでよい（下記「Botの手動テスト」参照）。

- `event.cron === "0 15 * * *"` の分岐が発火し、当日の `research-pool/YYYY-MM-DD.json` をR2に保存する
- 既存プールがある場合は「既存プールあり・スキップ」ログを出して冪等に終了する
- 手動発火はBluesky投稿を行わないため、**投稿の手動削除は不要**

## Botの手動テスト（本番発火）

Cloudflareダッシュボードは日本語UIの場合、英語UIとナビゲーションが異なる。

### 手順（日本語UI）

1. `wrangler secret list`で必要なシークレットが揃っているか確認
2. Workers & Pages → `anniversary-cat-worker` → **「コードを編集する」**ボタンをクリック
3. エディタ右上の「HTTP」プルダウンを**「Scheduled」**に切り替える
4. **「送信」**ボタンをクリック（Cron Triggerが即時発火）
5. Workers & Pages → `anniversary-cat-worker` → **設定タブ** → **トリガーイベント**で実行履歴を確認
6. ログ確認: 左サイドバー **「分析とログ」** → **「ログ」** → Begin log stream
7. 確認後、Blueskyアプリ（`@nyanmusu.bsky.social`）で投稿を手動削除

### 実行履歴の確認場所

- 設定タブ → **トリガーイベント** → Cronイベント一覧（実行時刻・CPU時間・ステータス表示）
- 「成功」が表示されればCron自体は正常動作

## SUZURI APIテストスクリプトの注意事項

`node scripts/test-suzuri-api.mjs`を実行すると実際にSUZURIに商品が作成される。
確認後はSUZURIの管理画面から手動削除すること。

```bash
export SUZURI_API_KEY=<APIキー>
node scripts/test-suzuri-api.mjs
```
