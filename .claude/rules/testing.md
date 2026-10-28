# テスト方針・診断手順

## テストの種類

| スクリプト | 実行方法 | 外部API | 用途 |
| --- | --- | --- | --- |
| `scripts/test-bot.mjs` | `npm test` | 不要 | bluesky-bot.js / r2-storage.js / ウォーターマーク座標計算のロジック検証 |
| `scripts/test-suzuri.mjs` | `npm test`（2026-07よりCI接続） | 不要 | worker/suzuri.jsユニットテスト（商品生成・削除・リトライ） |
| `scripts/test-suzuri-api.mjs` | `node scripts/test-suzuri-api.mjs` | SUZURI API | SUZURI API動作確認（実商品が生成される） |
| `scripts/health-check.js` | GitHub Actionsのみ | 必要 | 本番Worker・Gemini APIのE2Eチェック |
| `scripts/test-gemini-image-timing.mjs` | `GEMINI_API_KEY=xxx node scripts/test-gemini-image-timing.mjs` | Gemini API | Gemini画像生成の所要時間計測（競合設計の根拠取得用） |
| `scripts/test-theme-hook.mjs` | `GEMINI_API_KEY=xxx node scripts/test-theme-hook.mjs` | Gemini API | themeHook（テーマ連動のウィットに富んだ一言）のプロンプト品質検証（実装前の事前検証用・2026-10追加。[Issue #203](https://github.com/hiroshikuze/anniversary-cat-worker/issues/203)参照） |
| `scripts/test-fal-models.mjs` | `FAL_KEY=xxx node scripts/test-fal-models.mjs` | fal.ai API | fal.aiモデル比較（解像度・サイズ・速度の実測） |
| `scripts/audit-suzuri-materials.mjs` | `SUZURI_API_KEY=xxx node scripts/audit-suzuri-materials.mjs [--delete]` | SUZURI API | 孤立SUZURIマテリアルの棚卸し・削除（デフォルトはdry-run・`--delete`時のみ実削除） |
| `scripts/query-worker-logs.mjs` | GitHub Actions推奨（`.github/workflows/query-worker-logs.yml`をworkflow_dispatchで手動発火）。ローカル実行も可: `CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx node scripts/query-worker-logs.mjs --grep fal --since 6h` | Cloudflare Workers Observability API | Cloudflare Workers Logs（`console.log`の内容）をキーワード検索。詳細は次項参照 |
| `scripts/test-sale.mjs` | `npm test`（2026-08よりCI接続） | 不要 | worker/sale.jsユニットテスト（`isSaleActive`/`getActiveSaleInfo`の正常系・境界値・エラー系） |
| `scripts/test-post-sale-announcement.mjs` | `npm test`（2026-09よりCI接続） | 不要 | `scripts/post-sale-announcement.mjs`の純粋関数（文字数・ハッシュタグ数・Xの加重文字数の検証、Blueskyのfacet生成、Discordメッセージの組み立て）のユニットテスト |

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
- **現在日時に依存する状態はテストで固定する**: セール期間（`worker/sale.js`の`_currentSale`・`scripts/test-bot.mjs`の冒頭で`_setSaleForTest(null)`）や、季節の花・`new Date()`に依存する結果は、実日付のままにしない。セール期間中にだけ`runBot()`系のテストが失敗した事故がある（Bug#46）。セールを使うテストは`_setSaleForTest(SALE)`で自分で設定し、終わったら`null`に戻す
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
| `[generate] Gemini prepayment credits depleted` | Gemini APIの前払いクレジット枯渇（2026-10-28追加）。Discordに`💳`の専用通知が1時間に1回出る。Google AI Studioの請求ページでチャージする |
| `[pollinations] model=xxx failed status=402` | Pollinationsの当該モデルがHTTPエラーで失敗（402は支払い要求。2026-10-26に追加したログ。`[pollinations] model=xxx failed: メッセージ`は通信例外・タイムアウト） |
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

Cloudflareダッシュボードのコード編集画面から「HTTP」→「Scheduled」に切り替えて「送信」する（**この用途に限り使用可**。下記「Botの手動テスト・手動復旧」で廃止したのはBot Cron分岐に流れ込む想定外の値のケースで、`event.cron === "0 15 * * *"`に正しく一致する場合は投稿を伴わないため引き続き問題ない）。

- `event.cron === "0 15 * * *"` の分岐が発火し、当日の `research-pool/YYYY-MM-DD.json` をR2に保存する
- 既存プールがある場合は「既存プールあり・スキップ」ログを出して冪等に終了する
- 手動発火はBluesky投稿を行わないため、**投稿の手動削除は不要**

## Botの手動テスト・手動復旧（`POST /bot/manual-run`・2026-09追加・Bug#40）

**Cloudflareダッシュボードのコード編集画面から「HTTP」→「Scheduled」に切り替えて「送信」する方法は使わない。** この方法は`scheduled()`を直接呼び出すため監査ログ（Audit Log）に一切記録が残らず、かつCloudflare Cronイベントログにも記録されない。2026-09にこの方法（または同等の手段）によるものとみられる想定外の本番投稿が発生し、実行者を特定できなかった（詳細は`.claude/bugs-history.md`のBug#40参照）。

代わりに`BYPASS_TOKEN`で保護された`POST /bot/manual-run`エンドポイントを使う。これは通常のHTTPリクエストとして`fetch()`ハンドラーを経由するため、少なくともWorkers Logsに記録が残り、`BYPASS_TOKEN`を知らない第三者は実行できない。

### 手順

```bash
# デフォルト: dryRun=true（投稿・R2保存を行わず、Discordに投稿予定内容のプレビューのみ送信）
curl -X POST https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"

# 本番投稿を伴う手動発火（Cron未発火時の当日分リカバリー等、意図的に投稿したい場合のみ）
curl -X POST "https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run?dryRun=false" \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"
```

- `dryRun=true`（デフォルト・省略可）: `handleResearch()`/`handleGenerate()`は実際に呼ばれる（Gemini APIクォータを消費する）が、Bluesky/Mastodonへの投稿・R2への保存は行わない。Discordに「🧪 テスト実行（投稿は行われていません）」を明記したうえで、実際に投稿されるはずだったテキスト（`buildPostText()`/`buildMastodonText()`の出力）をプレビューとして送信する。**投稿の手動削除は不要**
- `?dryRun=false`: `runBot()`本来の処理（本番Cronと完全に同一）を実行する。Bluesky/Mastodonに実際に投稿されるため、確認後は投稿の手動削除が必要（従来のダッシュボード手順と同じ）
- レスポンスは`runMonthlyWallpaperPost()`と同じパターンのJSON（`{ dryRun, bskyOk, mastoOk, theme }`または`{ error }`）
- 実行結果はCloudflareダッシュボードの「分析とログ」→「ログ」（Begin log stream）、または`query-worker-logs.mjs`（`--grep "[bot]"`）で確認できる

### 片方のSNSだけ投稿に失敗したときの再投稿（`mode=repost`・2026-10追加）

BlueskyまたはMastodonの一方だけ失敗した場合は、`?dryRun=false`の通常実行（新しいテーマ・画像を生成して両方に投稿するため二重投稿になる）ではなく、`mode=repost`を使う。**先に確認のみ（dryRun）で、未投稿かどうかをプラットフォーム別に確認する**。`502`等でも実際には投稿されていることがあるため。

```bash
# 1. 確認のみ（投稿しない）
curl -X POST "https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run?mode=repost&date=YYYY-MM-DD" \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"

# 2. 「未投稿」と出たSNSにだけ投稿する
curl -X POST "https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run?mode=repost&date=YYYY-MM-DD&platform=bluesky&dryRun=false" \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"
```

詳細（判定方法・`unknown`の扱い・投稿内容）は`.claude/docs/architecture/bot-posting.md`の「再投稿モード」参照。

### iPhoneから`POST /bot/manual-run`を実行する（ショートカットアプリ・2026-10追加）

`curl`が使えない環境（iPhoneだけ）では、標準の「ショートカット」アプリで同じリクエストを送れる。2026-10-21の復旧で実際にこの方法で本番投稿に成功した。

1. 「ショートカット」アプリで新規作成し、アクション「**URLの内容を取得**」を追加する
2. URLに`https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run`を入力する
3. 「›」（詳細）で、方法を**POST**にし、ヘッダに**`X-Bypass-Token`**（値は`BYPASS_TOKEN`）を追加する。本文は空のままでよい（本文を要求がJSONでも問題ない）
4. 下に「**結果を表示**」を追加し、「URLの内容」を渡す。返ってきたJSONで成否を確認する
5. 確認のみ（デフォルトのdryRun）を実行して、Discordの通知（先頭に「🧪 テスト実行」）を確認する。問題なければ、ショートカットを複製してURLの末尾に`?dryRun=false`を付けて実行する

注意点:

- **パラメーターは大文字小文字を区別する**。`?dryRun=false`（dは小文字・Rは大文字・falseはすべて小文字）と完全に一致したときだけ本番投稿になる。`False`・`FALSE`・`dryrun`は**テスト実行のまま**（安全側）。iPhoneの自動大文字・自動修正で変わることがあるため、URLは**コピー＆貼り付け**を推奨する。結果のJSONに`"dryRun":false`と出ているかで判別できる
- 結果が`{"error":"X-Bypass-Tokenが必要です"}`のときは、ヘッダのキーまたは値の誤り
- テスト実行でも画像生成（Gemini）を行い、Discord通知まで十数秒〜30秒ほどかかる。本番実行も同様に待つ
- 成功時のJSON例: `{"mastoOk":true,"bskyOk":true,"theme":"...","dryRun":false}`（dryRun時は`bskyOk`・`mastoOk`が常に`false`で正常）
- 同日に本番実行を2回以上行うと、保存先は`bot/YYYY-MM-DD-2`〜`-9`になる。投稿のリンクは新しい保存先を指す
- トークンはショートカット内（端末）にだけ保存し、チャットやリポジトリには貼らない

#### `BYPASS_TOKEN`の所在・再設定

- 本体は**Cloudflare Workerのシークレット**。登録後は値を表示できない（GitHubのシークレットも同様）
- GitHub Actionsのシークレットには**登録されていない**（2026-10-21確認。任意項目のため、未登録でもhealth-checkのE2Eはレート制限なしで動く）
- 値を忘れた場合は、Cloudflareダッシュボード（iPhoneのSafariから可）→ Workers → `anniversary-cat-worker` → 設定 → 変数とシークレット → `BYPASS_TOKEN`を新しい値で上書きする。値は英数字だけの長いランダム文字列にする。ショートカットのヘッダの値も同じに更新する。デプロイは不要。GitHub側に同名のシークレットを後から登録した場合は、そちらも同じ値に更新する

### Cronイベント履歴の確認（実際のCron Triggerの発火状況を見たい場合）

- 設定タブ → **トリガーイベント** → Cronイベント一覧（実行時刻・CPU時間・ステータス表示）
- 「成功」が表示されればCron自体は正常動作。ただし`POST /bot/manual-run`経由の実行はここには表示されない（Cronスケジューラーを経由しないHTTPリクエストのため）

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
| `application/ld+json` | SEO/AIO | サイト全体の構造化データ（削除されてもエラーにならない） |
| `createSuzuriFromImage` | SUZURI登録 | SUZURI登録フローの入口関数 |
| `allSuzuriProductsRegistered` | SUZURI登録 | 全商品登録確認（部分登録バグ対策） |
| `resizeForSuzuri` | SUZURI登録 | 2048px高解像度リサイズ（印刷品質） |
| `suzuriInFlight` | SUZURI登録 | 登録中のr2Idを覚える二重起動防止（削除されても動作はするが重複登録が再発する・Bug#49） |
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
- Tシャツ背面画像のマテリアル（自アカウント・タイトルなし・非公開・15日以上経過。Bug#42）は、期限表記がなくても`isOrphanBackTextureMaterial()`（`worker/suzuri.js`）の判定で削除対象に含める
- 上記以外で期限表記が見つからないマテリアル（手動作成・テスト商品等）は「判定不可」として一覧に出すが削除対象には含めない。手動で確認すること
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
