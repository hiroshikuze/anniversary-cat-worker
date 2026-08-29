# テスト方針・診断手順

## テストの種類

| スクリプト | 実行方法 | 外部API | 用途 |
| --- | --- | --- | --- |
| `scripts/test-bot.mjs` | `npm test` | 不要 | bluesky-bot.js / r2-storage.js / ウォーターマーク座標計算のロジック検証 |
| `scripts/test-suzuri.mjs` | `npm test`（2026-07よりCI接続） | 不要 | worker/suzuri.jsユニットテスト（商品生成・削除・リトライ） |
| `scripts/test-suzuri-api.mjs` | `node scripts/test-suzuri-api.mjs` | SUZURI API | SUZURI API動作確認（実商品が生成される） |
| `scripts/health-check.js` | GitHub Actionsのみ | 必要 | 本番Worker・Gemini APIのE2Eチェック |
| `scripts/test-gemini-image-timing.mjs` | `GEMINI_API_KEY=xxx node scripts/test-gemini-image-timing.mjs` | Gemini API | Gemini画像生成の所要時間計測（競合設計の根拠取得用） |
| `scripts/test-fal-models.mjs` | `FAL_KEY=xxx node scripts/test-fal-models.mjs` | fal.ai API | fal.aiモデル比較（解像度・サイズ・速度の実測） |
| `scripts/audit-suzuri-materials.mjs` | `SUZURI_API_KEY=xxx node scripts/audit-suzuri-materials.mjs [--delete]` | SUZURI API | 孤立SUZURIマテリアルの棚卸し・削除（デフォルトはdry-run・`--delete`時のみ実削除） |
| `scripts/query-worker-logs.mjs` | GitHub Actions推奨（`.github/workflows/query-worker-logs.yml`をworkflow_dispatchで手動発火）。ローカル実行も可: `CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx node scripts/query-worker-logs.mjs --grep fal --since 6h` | Cloudflare Workers Observability API | Cloudflare Workers Logs（`console.log`の内容）をキーワード検索。詳細は次項参照 |
| `scripts/test-sale.mjs` | `npm test`（2026-08よりCI接続） | 不要 | worker/sale.jsユニットテスト（`isSaleActive`/`getActiveSaleInfo`の正常系・境界値・エラー系） |

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

## health-check.jsのシークレット検証項目（2026-06追加）

`scripts/health-check.js`は、Cloudflare Workers/GitHub Actionsに設定した各APIキー・トークンが有効かどうかをCI上で検証する。キー更新時の設定ミス（typo・期限切れ・スコープ不足）を即座に検知する目的。

| 関数 | 検証対象 | 必要な環境変数 |
| --- | --- | --- |
| `checkGeminiReachable` / `checkImageModels` / `checkResearch` | Gemini API | `GEMINI_API_KEY` |
| `checkBlueskyAuth` | Bluesky AT Protocol認証 | `BLUESKY_IDENTIFIER` `BLUESKY_APP_PASSWORD` |
| `checkDiscordWebhook` | Discord Webhook | `DISCORD_WEBHOOK_URL` |
| `checkSuzuriAuth` | SUZURI API認証（`GET /api/v1/items`） | `SUZURI_API_KEY` |
| `checkMastodonAuth` | Mastodon API認証（`GET /api/v1/accounts/verify_credentials`） | `MASTODON_INSTANCE_URL` `MASTODON_ACCESS_TOKEN` |
| `checkCloudflareToken` | Cloudflare APIトークン（`GET /client/v4/user/tokens/verify`） | `CLOUDFLARE_API_TOKEN` |

- いずれも対応する環境変数が未設定の場合は検証をスキップする（CI失敗にしない）。`MASTODON_*`は片方のみ設定時に警告を出す（既存の`BLUESKY_*`と同じパターン）
- 認証失敗（401/403）はCI失敗として扱う。キーのローテーション・期限切れ・スコープ変更時に即座に気づける
- これらの関数に`scripts/test-bot.mjs`の単体テストは追加しない。`checkBlueskyAuth`・`checkDiscordWebhook`・`checkGeminiReachable`等の既存の同種関数も単体テストを持たない。本スクリプトは「GitHub Actionsのみ・外部API必要」（本セクション冒頭の表参照）に分類されたE2E専用スクリプトであり、モックでロジックを検証してもキー自体の有効性確認という目的を果たせないため
- `FAL_KEY`（fal.ai）の検証は未実装（2026-06時点）。fal.aiの公式ドキュメントがサンドボックスから403でアクセス不可だったため、エンドポイント仕様を一次情報で確認できておらず、誤判定リスクを避けて見送った。将来追加する場合は実際のcurl実行でエンドポイントを確認してから実装する

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

品質面では「`none`除外・重複除去が効かない」違いのみ。通常運用への影響は軽微。

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

## フロントエンド機能存在チェック（CI）

PR #121のリグレッション（マージ競合で英語機能が黙って削除）を受けて、CIに`frontend/index.html`の機能存在確認ステップを追加した（`.github/workflows/health-check.yml`）。

### 選定基準

以下の3条件をすべて満たす文字列のみチェックリストに追加する。

1. **ユーザーが体験できる機能の境界**（表示・操作・導線に直結する）
2. **削除されてもエラーにならない**（サイレントに消える・`npm test`や`health-check.js`で検出されない）
3. **マージ競合で失われるリスクがある**（複数の関数・UIブロックが同一ファイルを変更する場所）

### 現在のチェック一覧

| 文字列 | カテゴリ | 代表する機能 |
| --- | --- | --- |
| `MONTH_NAMES_EN` | 英語i18n | 英語月名定数 |
| `themeEn` | 英語i18n | 英語テーマ・説明文の表示 |
| `params.set("lang"` | 多言語i18n | `setLang()`の`?lang` URL同期 |
| `gallery-click` | 計測 | ギャラリーカードのUmami計測 |
| `umami?.track` | 計測 | `loadSharedImage()`内のUmami page view追跡 |
| `createSuzuriFromImage` | SUZURI登録 | SUZURI登録フローの入口関数 |
| `allSuzuriProductsRegistered` | SUZURI登録 | 全商品登録確認（部分登録バグ対策） |
| `resizeForSuzuri` | SUZURI登録 | 2048px高解像度リサイズ（印刷品質） |
| `applyWatermark` | 画像合成 | ウォーターマーク合成（著作権表示） |
| `generateKanjiTexture` | 画像合成 | 漢字背面印刷テクスチャ生成 |
| `loadSharedImage` | 共有URL | ボットリンク・共有URLの入口関数 |
| `lang-btn-kana` | かなモード | かなボタンのspan ID（翻訳定数とボタンが削除されてもサイレントに壊れる） |
| `setLang` | かなモード | JP/かな/EN 3択切り替え関数 |
| `formatDateKana` | かなモード | 日付ふりがな生成関数（削除されると日付の漢字が読めない状態になる） |
| `setErrText` | かなモード | エラーテキストのkana対応ヘルパー（削除されるとエラーメッセージにruby HTMLが露出する） |
| `loadSaleInfo` | SUZURIセール表示 | `/sale-info`取得関数（削除されるとセールバナーが常に非表示になる） |
| `renderSaleBanner` | SUZURIセール表示 | セールバナーの表示/文言組み立て関数 |
| `kanaForWeekday1Char` | かなモード | セールバナー曜日ふりがなヘルパー（`formatDateKana()`の`weekdayKana`対応表を再利用） |

### 運用ルール

- `frontend/index.html`に新機能を追加した場合は、上記の3条件に照らして追加要否を判断する
- チェック文字列を変更・削除した場合は、チェックリストも同時に更新する
- チェックリストへの追加は`CLAUDE.md`の「テスト制約」セクションのルールに従う

## SUZURI APIテストスクリプトの注意事項

`node scripts/test-suzuri-api.mjs`を実行すると実際にSUZURIに商品が作成される。
確認後はSUZURIの管理画面から手動削除すること。

```bash
export SUZURI_API_KEY=<APIキー>
node scripts/test-suzuri-api.mjs
```

## SUZURI孤立マテリアル棚卸しスクリプトの使い方（2026-06追加）

`scripts/audit-suzuri-materials.mjs`は、14日後の自動クリーンアップ（`scheduled()`）から漏れて残った孤立SUZURIマテリアルを検出する。背景: Bug#24（`materialIds`配列化以前は2グループ目のマテリアルIDがR2に保存されず削除対象から漏れていた）。

```bash
export SUZURI_API_KEY=<APIキー>

# dry-run（削除対象の一覧表示のみ・実削除なし）
node scripts/audit-suzuri-materials.mjs

# 一覧を確認したうえで実削除
node scripts/audit-suzuri-materials.mjs --delete
```

- 削除対象の判定は`description`に埋め込まれた`〇月〇日（日本時間）までの販売`という期限表記から行う（年は埋め込まれていないため、現在日時から90日以上未来になる場合は前年と判断する）
- 期限表記が見つからないマテリアル（手動作成・テスト商品等）は「判定不可」として一覧に出すが削除対象には含めない。手動で確認すること
- `--delete`を付けない限りAPIへのDELETE呼び出しは行われない

## Cloudflare Workers Logsのキーワード検索スクリプトの使い方（2026-08追加）

`scripts/query-worker-logs.mjs`は、Cloudflare Workers Observability Telemetry Query API（`POST /accounts/{account_id}/workers/observability/telemetry/query`）を使い、本番Workerの`console.log`出力（Cloudflare Logsダッシュボードで見えるものと同じ）をキーワード・時間範囲で検索する。背景: fal.aiポーリング未完了等の障害調査のたびにユーザーへCloudflareダッシュボードのログ確認を依頼していたが、ClaudeCodeセッションから直接ログを検索できるようにした。

**保持期間の制約**: Workers Freeプランは3日分・Paidプランは7日分のみ（[公式ドキュメント](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)で確認済み）。このプロジェクトはFreeプランのため、3日より前のログは検索しても出てこない。

**実行方法（GitHub Actions推奨）:**

```text
Actionsタブ → query-worker-logs → Run workflow
  grep: fal（検索したいキーワード。省略可）
  since: 6h（遡る期間。例: 30m, 6h, 2d。省略時は3h）
  limit: 200（取得件数上限。省略可）
  request_id: 9f2cd1a2088fa79b69202ac5c3d2e940（1回のWorker呼び出しの全ログ行を相関させたい場合。省略可）
```

**ローカル実行:**

```bash
export CLOUDFLARE_API_TOKEN=<APIトークン>
export CLOUDFLARE_ACCOUNT_ID=<アカウントID>
node scripts/query-worker-logs.mjs --grep fal --since 6h
node scripts/query-worker-logs.mjs --request-id 9f2cd1a2088fa79b69202ac5c3d2e940 --since 3d   # 1回のWorker呼び出しの全ログ行を相関させる
```

- `CLOUDFLARE_API_TOKEN`は既存のデプロイ用トークン（`checkCloudflareToken`が検証しているもの）を流用する想定だったが、追加のスコープ付与なしにそのまま認証成功することを実機（workflow_dispatch）で確認済み（2026-08）
- `--grep`は`$metadata.message`に対する部分一致（`includes`）フィルター。省略時は対象Workerの全ログを`--since`の範囲で返す
- `--request-id`は`$metadata.requestId`に対する完全一致（`eq`）フィルター。Cloudflare側が1回のWorker呼び出し（HTTPリクエスト1件・`ctx.waitUntil()`のバックグラウンド処理含む）に割り振る内部ID（`query-worker-logs.mjs`の出力では各行の`reqId=...`として表示される）で、`--grep`では拾えない「同一呼び出し内の全ログ行」を時系列で相関させたいとき（例: `ctx.waitUntil()`の実測所要時間の計測）に使う。`--grep`と併用可能（AND条件）
- `--service`は省略時`anniversary-cat-worker`固定
- 本スクリプトは実際のworkflow_dispatch実行（2026-08-14）でCloudflare APIから正常なレスポンスを取得できることを確認済み。想定外のレスポンス構造の場合は生レスポンスの一部を出力するので、必要に応じてパース処理を調整すること
