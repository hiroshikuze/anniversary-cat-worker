# システム設計・API仕様・将来拡張

## ファイル構成

```text
anniversary-cat-worker/
├── CLAUDE.md                         ← 判断品質ルール（最重要原則6つ含む）
├── package.json
├── wrangler.toml                     ← Cloudflareデプロイ設定（Cron Trigger含む）
├── .github/workflows/
│   ├── health-check.yml              ← push時: ユニットテスト + E2Eチェック
│   ├── deploy-worker.yml             ← main push時: Cloudflare Workersデプロイ
│   ├── deploy-pages.yml              ← main push時: GitHub Pagesデプロイ
│   ├── query-worker-logs.yml         ← workflow_dispatch: Cloudflare Workers Logsのキーワード検索（2026-08追加）
│   └── sale-announcement.yml         ← claude/**へのpush: tmp-sale-announcement/の告知をBluesky・Mastodonへ投稿しDiscordへ送信（2026-09追加）
├── .claude/
│   ├── revision_log.md               ← ミスパターン記録（毎セッション冒頭で読む）
│   ├── bugs-history.md               ← バグ履歴 Bug#31〜と全バグの一覧表（都度参照・自動ロードなし）
│   ├── future-ideas.md               ← 将来拡張アイデア（都度参照・自動ロードなし）
│   ├── docs/                         ← 詳細仕様（都度参照・自動ロードなし・2026-10追加）
│   │   ├── architecture/             ← architecture.mdから移動した大きな節（suzuri-create・sale-check-and-cleanup・gemini・bot-posting・monthly-wallpaper）
│   │   └── suzuri-api-unused-features.md ← future-ideas.mdから移動したSUZURI APIの未使用機能一覧
│   ├── settings.json                 ← PostToolUseフック（Markdownスペース検証）
│   ├── skills/
│   │   └── sale-announcement/        ← スキル: SNSセール告知の作成・投稿手順と合成スクリプト（`/sale-announcement`・2026-09追加）
│   ├── archive/
│   │   ├── revision_log_2026-03.md   ← アーカイブ済みの旧revision_log（2026-03分）
│   │   ├── revision_log_2026-04-07.md ← アーカイブ済みの旧revision_log（2026-04〜2026-07分・2026-09追加）
│   │   ├── revision_log_2026-08.md   ← アーカイブ済みの旧revision_log（2026-08分・2026-10追加）
│   │   └── bugs-history_01-30.md     ← アーカイブ済みのバグ履歴（Bug#1〜30・2026-10追加）
│   └── rules/                        ← 以下は毎セッション自動ロード
│       ├── coding.md                 ← コーディング規約・Markdown執筆ルール
│       ├── testing.md                ← テスト方針・診断手順
│       ├── git-workflow.md           ← Gitワークフロー・デプロイ手順
│       ├── architecture.md           ← このファイル（設計・仕様の目次。大きな節の本文は.claude/docs/architecture/）
│       └── suzuri-api-reference.md   ← SUZURI APIリファレンス抜粋
├── worker/
│   ├── index.js                      ← Cloudflare Worker本体（fetch + scheduledハンドラ）
│   ├── bot.js                        ← Bluesky/Mastodon Botロジック・Discord通知（旧 bluesky-bot.js）
│   ├── fal.js                        ← fal.ai ESRGAN 2xアップスケーリング（Queue API）
│   ├── suzuri.js                     ← SUZURI API連携（商品生成・削除）
│   ├── http-utils.js                 ← 共通HTTPユーティリティ（fetchWithRetry・2026-07追加）
│   ├── image-utils.js                ← Photon共有ローダー・自動トリミング（2026-08追加）
│   ├── sale.js                       ← SUZURIセール期間・金額の一元管理（2026-08追加）
│   ├── sale-check.js                 ← SUZURIニュース一覧のセール自動検知Cron（2026-08追加）
│   └── r2-storage.js                 ← Cloudflare R2ストレージ操作
├── frontend/
│   ├── index.html                    ← フロントエンド（PWA対応、JP/EN切り替え）
│   ├── manifest.json
│   ├── sw.js
│   └── images/                       ← faviconアイコン類
└── scripts/
    ├── health-check.js               ← E2E診断（GitHub Actionsのみ実行）
    ├── test-bot.mjs                  ← ユニットテスト（外部API不要）← npm test
    ├── test-suzuri.mjs               ← worker/suzuri.jsユニットテスト（外部API不要）← npm test（2026-07よりCI接続）
    ├── test-sale.mjs                 ← worker/sale.jsユニットテスト（外部API不要）← npm test（2026-08よりCI接続）
    ├── test-suzuri-api.mjs           ← SUZURI API動作確認（実商品が生成される）
    ├── test-fal-models.mjs           ← fal.aiモデル比較（FAL_KEY必要）
    ├── test-gemini-image-timing.mjs  ← Gemini画像生成の所要時間計測（GEMINI_API_KEY必要）
    ├── test-gemini-research-batch.mjs ← バッチ vs シングル精度比較（GEMINI_API_KEY必要）
    ├── test-pool-30days.mjs          ← 事前リサーチプール方式シミュレーション（GEMINI_API_KEY必要）
    ├── generate-kana-translations.mjs ← translations.kanaブランチのruby HTML一括生成（kuroshiro使用・一回限りユーティリティ）
    ├── preview-kana.mjs              ← かなモードのrubyふりがなをブラウザでプレビュー（引数: theme description）
    ├── query-worker-logs.mjs         ← Cloudflare Workers Logsのキーワード検索（CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID必要・2026-08追加）
    ├── post-sale-announcement.mjs    ← SNSセール告知の検証・Bluesky/Mastodon投稿・Discord送信（sale-announcement.ymlから実行・2026-09追加）
    └── test-post-sale-announcement.mjs ← 上記の純粋関数のユニットテスト（外部API不要）← npm test（2026-09追加）
```

---

## APIエンドポイント一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/research` | Gemini + Google Searchで記念日テキスト取得（`themeEn`/`descriptionEn`含む） |
| POST | `/generate` | Gemini画像生成（Pollinationsフォールバックあり） |
| GET | `/proxy-image?url=...` | Pollinations.ai画像のCORSプロキシ |
| GET | `/image/:id` | R2保存画像+メタデータの取得（`bot/YYYY-MM-DD`または`user/{uuid}`）。`themeEn`/`descriptionEn`が保存済みの場合はレスポンスに含まれる |
| GET | `/meta/:id` | R2メタデータのみ取得（画像なし・ポーリング用軽量エンドポイント） |
| GET | `/hires/:id` | fal.ai高解像度画像をR2から返す（SUZURI向け安定URL） |
| GET | `/thumb/:id` | R2画像バイナリを直接返却（ギャラリーサムネイル用・base64不要） |
| GET | `/back/:id` | TシャツSUZURI背面印刷テクスチャをR2から返す（sub_materials.textureはURLのみ対応のため） |
| GET | `/rss.xml` | RSSフィード（直近14日のボット作品・サムネイル画像付き） |
| GET | `/usage` | Gemini APIトークン使用量（直近30日・認証なし・`{days:[{date,textCalls,textTokens,textModel,imageCalls,imageTokens}]}`） |
| GET | `/cpu-usage` | ステップ別CPU時間集計（直近30日・認証なし・`{days:[{date,{step}:{calls,totalMs,maxMs}}]}`） |
| GET | `/sale-info` | 現在有効なSUZURIセール情報（認証なし・`{active:true,endUtcMs,discountYen,endDisplay}`または`{active:false}`・`Cache-Control: public, max-age=300`） |
| POST | `/suzuri-create` | ウォーターマーク済み画像を受け取りSUZURI登録・R2メタ更新 |
| POST | `/monthly-wallpaper/regenerate` | 月替わり壁紙の手動再生成（`X-Bypass-Token`ヘッダー必須。月末Cronと同じ`runMonthlyWallpaperPost()`を呼ぶ） |
| POST | `/bot/manual-run` | Bot Cronの手動実行・テスト（`X-Bypass-Token`ヘッダー必須。`?dryRun=false`指定時のみ実投稿。詳細は「Bluesky Bot」の「手動実行エンドポイント」参照） |

### /proxy-imageのセキュリティ制約

`https://image.pollinations.ai/`以外のURLはすべて403で拒否する（オープンプロキシ化防止）。

---

## /suzuri-createエンドポイント仕様

> **詳細は[`.claude/docs/architecture/suzuri-create.md`](../docs/architecture/suzuri-create.md)に移動した**（2026-10・自動読み込みの軽量化）。この節を参照する指示があったら移動先を読むこと。

フロントがウォーターマーク合成済み画像を2回（右グループ・中央グループ）送ってSUZURI登録し、R2メタの`materialIds`/`products`を更新するエンドポイント。重複防止チェック・`updateMetaInR2()`のCAS＋リトライ・失敗時のSUZURIマテリアル削除ロールバック・Tシャツ背面画像が3つ目のマテリアルになる件（Bug#42）を含む。

移動先に収録している小見出し（太字の見出し）:

- ウォーターマーク位置ルール
- リクエスト
- 重複防止チェック（2026-04追加）
- SUZURIマテリアルは画像1件につき2つ作成される（2026-06明確化）
- Tシャツ背面画像は3つ目のマテリアルになる（2026-10判明・Bug#42）
- `updateMetaInR2()`の並行書き込み耐性（2026-09追加・Bug#34）
- `updateMetaInR2()`最終失敗時のSUZURIマテリアル削除ロールバック（`_updateMetaOrRollback()`・2026-09追加）
- レスポンス
- フロントのグッズ表示（`showGoods()`）
- SUZURIプレビュー画像のCDN遅延対策（2026-04）
- SUZURIマテリアル説明文（`buildDescription()`・2026-04）
- `createSuzuriProducts()`のシグネチャ（2026-04更新）

---

## SUZURIセール情報の一元管理（`worker/sale.js`・2026-08追加）

### 背景

SUZURIのセール（例: 2026-08「ニンニンSALE」、最大800円OFF）が開催されるたび、`frontend/index.html`内のセールバナー（期間の日時定数＋ja/en/kana各言語の文言に日付・金額を直書き、実質4箇所以上）をセッションごとに手動更新していた。更新漏れの事故リスクを避けるため、情報源を`worker/sale.js`の1箇所に集約した。

### 設計

`worker/sale.js`はPhoton（`image-utils.js`）と同じ「モジュールスコープの状態＋テスト用差し替え関数」パターンを踏襲する。

```js
let _currentSale = {
  id:          "ninnin-sale-2026-08",
  startUtcMs:  Date.UTC(2026, 7, 28, 3, 0),
  endUtcMs:    Date.UTC(2026, 8, 3, 14, 59),
  discountYen: 800,
  endDisplay:  { month: 9, day: 3, weekdayJa: "木" },
  url:         "https://suzuri.jp/nyanmusu",
}; // セールがない期間はnullに書き換える

export function isSaleActive(now = Date.now()) { ... }
export function getActiveSaleInfo(now = Date.now()) { ... } // セール中はsaleオブジェクト、それ以外はnull
export function _setSaleForTest(sale) { ... } // テスト用
```

- **次のセール開催が決まったら`_currentSale`を差し替えるだけでよい**。frontendのバナー表示・Bot投稿のリプライ判定の両方に自動的に反映される
- `worker/index.js`・`worker/bot.js`双方が`worker/sale.js`から直接importする（新規の一方向import、既存の循環importは増やさない）
- frontendは別デプロイ（GitHub Pages・ビルドステップなしの静的HTML）のためWorkerのコードを直接import出来ない。代わりに`GET /sale-info`エンドポイント経由でJSONを取得する

### frontend側の連携（`frontend/index.html`）

- `SALE_START_UTC`/`SALE_END_UTC`のハードコード定数は廃止。ページ初期化時に`loadSaleInfo()`が`/sale-info`をfetchし、結果をモジュールスコープの`saleInfo`に保持する（fetch失敗時は`null`＝バナー非表示にフォールバックし、サービス継続を優先する）
- `renderSaleBanner()`が`saleInfo`と`currentLang`から`#g-sale-banner`の表示テキストを組み立てる。**文章の骨格（テンプレート）は言語ごとに固定文字列として保持し、日付・金額のみ動的に埋め込む**方針（機械生成の不自然な文章化を避けつつ、更新漏れが起きやすい数値部分だけを一元化する）
- かなモードの曜日ふりがなは、既存の`formatDateKana()`内の`weekdayKana`対応表（`"日曜日": "にちようび"`等）をモジュールスコープに引き上げて再利用する`kanaForWeekday1Char(char)`ヘルパー経由で参照する。**新しい変換表は作らない**（過去に曜日読み間違いのバグがあったため、対応表を二重管理しない）
- `setLang()`（言語切り替え時）でも`renderSaleBanner()`を再呼び出しする
- `scripts/health-check.js`（`WORKER_URL`設定時のE2Eチェック）が`GET /sale-info`の到達性・レスポンス形式をCIで検証する（`/usage`・`/cpu-usage`と同じパターン）

---

## SUZURIセール自動検知Cron（`worker/sale-check.js`・2026-08追加）

> **詳細は[`.claude/docs/architecture/sale-check-and-cleanup.md`](../docs/architecture/sale-check-and-cleanup.md)に移動した**（2026-10・自動読み込みの軽量化）。この節を参照する指示があったら移動先を読むこと。

`0 16 * * *`でSUZURIニュース一覧からセール記事を検知しDiscordへ通知する（本番反映は人手）。同じCronで期限切れR2/SUZURIエントリのクリーンアップ（Bug#41で移設）とTシャツ背面画像マテリアルの一括削除（Bug#42）も行う。

移動先に収録している小見出し:

- 背景
- 方針: 自動検知はするが「本番反映は自動化しない」
- Worker側`fetch()`のsuzuri.jp疎通確認（実装前の検証結果）
- Cronトリガー
- 期限切れR2/SUZURIエントリのクリーンアップ（2026-09移設）
- Tシャツ背面画像マテリアルの一括削除（`cleanupOrphanBackTextureMaterials()`・2026-10追加・Bug#42）
- 処理フロー（`checkForNewSale(env, ctx, notifyFn)`）
- テスト・実装上の注意
- 初回Cron発火で判明した問題（2026-08・修正済み）

---

## 外部通信のリトライ方針（`fetchWithRetry()`・2026-07追加）

**背景（Bug#28）**: 外部通信箇所を監査した結果、Gemini API呼び出し以外の多くの箇所にリトライがなく、一時的な通信不良で即座にエラー・機能低下（低画質フォールバック等）になる設計だった。

### `worker/http-utils.js` `fetchWithRetry(url, options, maxRetries=3, baseDelayMs=1000)`

5xxエラーと`fetch()`自体が投げるネットワーク例外（DNS失敗・接続断等）の両方を指数バックオフで最大`maxRetries`回リトライする共通ヘルパー。`worker/index.js`の旧`fetchWithRetry()`（非export・5xxのみ対応）を置き換える形で新設した。

- 429（クォータ超過）はリトライしても無駄なため即座にレスポンスを返す
- `AbortError`（`AbortSignal.timeout()`によるタイムアウト）はリトライしても同じ結果になるため即座にthrowする
- `baseDelayMs`は`_twoPhaseRace()`の`priorityMs`と同じ狙いのテスト用引数。本番は省略時1000ms（既存動作と同一）
- `worker/index.js`と`worker/suzuri.js`の両方から使うため独立ファイルとして新設（`worker/index.js`が`worker/suzuri.js`をimportしているため循環import回避）

### リトライ対象一覧

| 箇所 | 状態 |
| --- | --- |
| Gemini `/research`・画像生成（`worker/index.js`） | `fetchWithRetry()`使用（従来から） |
| `worker/suzuri.js` `createSuzuriProducts()`の`POST /materials` | `fetchWithRetry()`使用（2026-07追加） |
| `worker/index.js` `/proxy-image`ハンドラー | `fetchWithRetry()`使用（2026-07追加） |
| フロントエンド`/research`・`/generate`・`/suzuri-create`（`apiFetch()`） | 従来からリトライあり |
| フロントエンド`loadSharedImage()`の`/image/:id`取得 | `apiFetch()`のGET対応により2026-07追加 |

### 意図的にリトライ対象外の箇所

| 箇所 | 理由 |
| --- | --- |
| Bluesky/Mastodon投稿（`worker/bot.js`） | 外側リトライは二重投稿のリスクがあるため意図的に非リトライ（`/generate`側の冗長化で担保）。既存コメントに明記済み |
| Discord Webhook通知全般 | 通知失敗時はログ出力のみで処理をブロックしないbest-effort設計 |

### fal.aiポーリングループの早期break修正（`_pollFalAndGetTexture()`）

`/suzuri-create`の`ctx.waitUntil()`内でfal.ai Queueを3回×5秒ポーリングする処理を`_pollFalAndGetTexture(falRequestId, env, r2Id, workerOrigin, deps)`としてexport・切り出した（`_twoPhaseRace()`と同じ「依存関数を引数で受け取る」パターン）。

- **修正前の問題**: ポーリング中に例外（一時的な通信不良等）が発生すると`catch`節で即座に`break`しており、3回の試行予算のうち1回でも失敗すると残りの試行を放棄し、低画質base64フォールバックに落ちていた
- **修正後**: 例外時は`console.warn`でログを出すのみで、残りのポーリング試行を継続する。3回すべて失敗・タイムアウトした場合のみ最終的にbase64フォールバックする
- `deps`引数（`getFalResultFn`・`fetchFn`・`waitFn`・`pollIntervalMs`・`maxAttempts`）はテスト用。本番呼び出しは省略時のデフォルト値（実際の`getFalResult`・`fetch`・5秒間隔・3回）で動作する

**ポーリング予算（3回×5秒）は実測に基づき現状維持と判断（2026-08）:**

fal.aiアップスケール未完了のDiscord通知が連日発生した際、「`ctx.waitUntil()`の~28秒予算にまだ余裕があるならポーリング回数を増やせないか」という案を検討したが、`query-worker-logs.mjs`の`--request-id`フィルターで実際のログを相関させ実測した結果、増やさない方針とした。

| ケース | `bg開始`→`right グループ完了`の実測時間 | 内訳 |
| --- | --- | --- |
| 失敗（3回とも`IN_QUEUE`→base64フォールバック） | 約20.3秒 | ポーリング約16.0秒 + フォールバック登録約4.3秒 |
| 成功（3回目のポーリングで`COMPLETED`） | **約25.6秒**（28秒予算に対しmargin約2.4秒） | ポーリング約16.0秒 + CDN取得→R2保存→SUZURI登録約9.7秒 |

成功ケースの方が完了後の処理（CDN fetch・R2保存・SUZURI登録）が重く、ポーリングを伸ばすほど「3回目でギリギリ完了しそうなケース」が後処理の重さで28秒予算を超過し、強制終了＝何も保存されない方向に倒れるリスクが高い。詳細な調査経緯は`.claude/archive/revision_log_2026-08.md`参照。`CLAUDE.md`の「変えてはいけない設計判断」にも追記済み。

---

## レート制限

### 設定値（`worker/index.js`の`RATE_LIMITS`）

| エンドポイント | IP別上限 | グローバル上限 | TTL |
| --- | --- | --- | --- |
| `/generate` | 3回/日 | 50回/日 | 25時間 |
| `/research` | 10回/日 | なし | 25時間 |

Cloudflare KV（`RATE_KV`）で管理。日付はUTC基準でリセット。

### BYPASS_TOKEN（開発用）

```js
localStorage.setItem('bypassToken', '<シークレット値>')
```

フロントエンドはこの値を`X-Bypass-Token`ヘッダーに付与し、Workerが照合する。

---

## 猫ペルソナ（CAT_PERSONAS / pickPersona）

`worker/index.js`の`CAT_PERSONAS`配列と`pickPersona()`関数で、生成される猫の毛柄・品種をランダムに決定する。

### レアリティ設計

猫の毛柄遺伝的頻度に基づいた重み付き確率を採用。景品表示法の射幸心規制は**金銭・景品を伴う商取引**が前提のため、無料の画像生成サービスである本サービスは非該当。

| レアリティ | 重み合計 | 確率 | 例 |
| --- | --- | --- | --- |
| Common | 60 | 60% | オレンジタビー、白黒タキシード等 |
| Uncommon | 25 | 25% | トーティシェル、スコティッシュフォールド等 |
| Rare | 12 | 12% | 三毛、ベンガル |
| Ultra Rare | 3 | 3% | オスのトーティ（約1/3000匹）、スモークペルシャ |

### 設計方針

- `pickPersona()`は`handleGenerate()`内で**1回だけ**呼び出し、GeminiプロンプトとPollinationsプロンプトの**両方に同じペルソナ**を渡す（フォールバック時も見た目が揃う）
- ペルソナ文字列は**ASCIIのみ**（Pollinations APIのURL埋め込みで安全）
- ペルソナのカスタマイズ・追加は`CAT_PERSONAS`配列を編集するだけでよい

---

## 猫の性格（CAT_PERSONALITIES / pickPersonality）

`worker/index.js`の`CAT_PERSONALITIES`配列と`pickPersonality()`関数で、猫のポーズ・表情・テーマアイテムとの関わり方をランダムに決定する。毛柄（`CAT_PERSONAS`）とは**独立したランダム選択**であり、両者を組み合わせることで「オレンジタビーのHunter Cat」など多様な組み合わせが生まれる。

### 性格タイプと重み

リンカーン大学Finka(2017)の5タイプ分類をベースに、本サービスのトーン（記念日・かわいい）に合わせて調整。攻撃的・神経質・触られ嫌い・衝動的なタイプは除外し、ツンデレ（Cantankerous）はRareとして残した。

| タイプ | 重み | 確率 | プロンプト的表現 |
| --- | --- | --- | --- |
| Human Cat（甘えん坊） | 35 | 35% | シーンを見つめる・寄り添う・満ち足りた表情 |
| Hunter Cat（遊び好き） | 30 | 30% | 前傾姿勢・明るい目・テーマアイテムに手を伸ばす |
| Inquisitive Cat（好奇心旺盛） | 25 | 25% | 大きな目・身を乗り出してテーマアイテムを調べる |
| Cat's Cat（マイペース） | 7 | 7% | セルフグルーミング・落ち着いた佇まい |
| Cantankerous Cat（ツンデレ） | 3 | 3% | 背を向けつつそっと振り返る・気品ある表情 |

### 設計方針

- `pickPersonality()`は`handleGenerate()`内で`pickPersona()`と同じタイミングで**1回だけ**呼び出す
- 性格文字列は**ASCIIのみ**（Pollinations APIのURL埋め込みで安全）
- 攻撃性・神経質・衝動性に関連する表現は意図的に除外している

---

## 猫の感情の瞬間（CAT_EMOTIONS / pickEmotion）

`worker/index.js`の`CAT_EMOTIONS`配列と`pickEmotion()`関数で、猫がその瞬間に感じている感情状態をランダムに決定する。毛柄（`CAT_PERSONAS`）・性格（`CAT_PERSONALITIES`）とは**独立したランダム選択**。

### personality との違い

- `personality`（性格）:「このキャラクターはどんな気質・傾向か」（普遍的な性格）
- `emotion`（感情の瞬間）:「この絵の中で今何を感じているか」（一瞬の感情状態）

両者の組み合わせにより「甘えん坊な猫が驚いている瞬間」「ツンデレな猫が口を開けて笑っている」のように物語が生まれ、見た人の感情を動かす絵になることを意図している。

### 感情タイプと重み

Florkiewicz & Scott（2023）の276表情研究（友好的45%・攻撃的37%・曖昧18%）およびスロウブリンク研究（Humphrey & McComb 2020）をベースに設計。攻撃的・ストレス系表情は除外。

| タイプ | 重み | 確率 | プロンプト的表現 |
| --- | --- | --- | --- |
| 澄ましている | 25 | ~21% | serene composed expression, dignified and self-possessed |
| 真剣に遊ぶ | 25 | ~21% | eyes narrowed with intense focus, completely absorbed in play |
| 驚き | 20 | ~17% | eyes wide with surprise, ears pricked forward, caught off-guard |
| 笑い・プレイフェイス | 20 | ~17% | open-mouth play face, pure joyful delight |
| 安らか・うとうと | 20 | ~17% | eyes peacefully closed, warm drowsy contentment, slow-blink expression |
| おまかせ | 10 | ~8% | （プロンプトに含めない） |

笑い・プレイフェイスは人間・霊長類と共通の表情として論文で注目された表情（Florkiewicz 2023）。スロウブリンクは「里親引き渡しが速くなる」と実験で実証された最も好感を持たれる表情（Humphrey 2020）。

### 設計方針

- `pickEmotion()`は`handleGenerate()`内で`pickPersona()`・`pickPersonality()`と同じタイミングで**1回だけ**呼び出す
- 感情文字列は**ASCIIのみ**（Pollinations APIのURL埋め込みで安全）
- Geminiプロンプトでは`Cat facial expression and emotion: {emotion}.`として挿入
- Pollinationsプロンプトではpartsの5番目（personality直後）に追加
- Discord通知に`💭 感情: {emotion}`行として追加済み

---

## Geminiモデル管理

> **詳細は[`.claude/docs/architecture/gemini.md`](../docs/architecture/gemini.md)に移動した**（2026-10・自動読み込みの軽量化）。この節を参照する指示があったら移動先を読むこと。

画像生成モデルの候補・自動切替（KV記憶）、テキストモデルのコスト最適化スコアリング、トークン/CPU時間のKV集計（`/usage`・`/cpu-usage`）、Gemini/Pollinationsのプロンプト設計（季節カラー・余白削減・擬人化禁止）、生成後の自動トリミング、visualHintの役割。

移動先に収録している小見出し:

- 画像生成モデル（`worker/index.js`の`KNOWN_IMAGE_CANDIDATES`）
- 画像生成モデルの自動切替・記憶（`_resolveImageModel()`・2026-06追加）
- Researchモデル（テキスト用）・コスト最適化スコアリング（2026-06更新）
- Gemini画像生成プロンプト（`handleGenerate()`・2026-05変更）
- Style行の季節カラー（`getSeasonalStyleTone()`・2026-06追加）
- 構図の余白削減指示（2026-08追加）
- 猫以外への顔・擬人化の禁止（Bug#33・2026-09追加）
- 生成後の自動トリミング（コード側補正・2026-08追加・計測フェーズ）
- visualHintの役割（2026-05変更）

---

## Bluesky Bot

> **詳細は[`.claude/docs/architecture/bot-posting.md`](../docs/architecture/bot-posting.md)に移動した**（2026-10・自動読み込みの軽量化）。この節を参照する指示があったら移動先を読むこと。

平日7:00 JSTのBluesky/Mastodon同時投稿（`runBot()`）。Cron明示チェックと手動実行エンドポイント（Bug#40）、投稿テキスト形式と文字数の安全網、CTAローテーション、セール告知リプライ、altテキスト、Discord通知（2通構成・投稿URL付き）、各SNSのAPIエンドポイント。

移動先に収録している小見出し:

- 設計方針
- `scheduled()`のCron明示チェック（2026-09追加・Bug#40）
- 手動実行エンドポイント（`POST /bot/manual-run`・2026-09追加・Bug#40）
- 投稿フォーマットの選択（short/full・2026-10追加）
- 投稿テキスト形式
- テーマタグ正規化（`buildThemeTag`）
- 画像altテキスト形式
- Discord通知（`notifyDiscord()`）
- Discord成功通知フォーマット
- Bluesky AT Protocolエンドポイント
- Mastodon APIエンドポイント

---

## 月替わり壁紙プレゼント機能（`worker/bot.js` `runMonthlyWallpaperPost()`・2026-09追加）

> **詳細は[`.claude/docs/architecture/monthly-wallpaper.md`](../docs/architecture/monthly-wallpaper.md)に移動した**（2026-10・自動読み込みの軽量化）。この節を参照する指示があったら移動先を読むこと。

月末にカレンダー付き/なしの壁紙2枚をBluesky/Mastodonへ投稿する機能。Satori+resvgによるカレンダー合成、署名PNGアセット、セーフエリア調整、error 1102対策（540×960で配信）、手動再生成エンドポイント、`0 15 * * *`への相乗りCron。

移動先に収録している小見出し:

- 背景
- 月テーマの決定（新規データテーブルなし）
- 画像生成: 既存`handleGenerate()`の拡張利用
- カレンダー・月名の合成（`worker/image-utils.js` `compositeMonthlyWallpaper()` + `worker/svg-render.js`）
- 署名を事前生成PNGアセット化（2026-09・Bug#39）
- 最終拡大の撤回・540×960のまま配信（2026-09追加）
- 投稿本体（`worker/bot.js` `runMonthlyWallpaperPost(env, handleGenerate, ctx = null, deps = {})`）
- 手動再生成エンドポイント
- Cron（月末自動生成）
- 公開後フォローアップ（運用ルール）

---

## フロントエンド機能概要（`frontend/index.html`）

| 機能 | 詳細 |
| --- | --- |
| 多言語対応 | JP/かな/EN の3択切り替えボタン（`translations`オブジェクトで管理・`setLang(lang)`で切り替え・`?lang=kana`/`?lang=en`URLパラメーター対応） |
| かなモード（2026-05） | `?lang=kana`で全UIテキストにrubyふりがなを表示。UIテキスト43キーは`translations.kana`（kuroshiro生成済み）。動的コンテンツ（theme/description）はGeminiが`themeKana`/`descriptionKana`（ruby HTML）を返し、R2に保存・`/image/:id`レスポンスに含む。既存R2データ（`themeKana`なし）は日本語にフォールバック。SUZURI商品説明は日本語のみ（変更なし） |
| 英語ページのテーマ表示（2026-05） | `?lang=en`時かつ`themeEn`/`descriptionEn`が存在する場合、テーマ名・説明文を英語で表示。取得できない場合は日本語にフォールバック。ギャラリーカードも同様（テーマ: `meta.themeEn`、日付: `May 3`形式） |
| 日付バッジの「今日の記念日」ラベル（2026-05） | 日付バッジ（`#today-date`）の前に`#today-date-label`スパンを追加。`updateDateDisplay(date=null)`でdateがnullの場合（通常表示）は`今日の記念日`（EN: `Today's Anniversary`）を表示し、dateが指定された場合（共有ビュー）は空文字にして非表示にする。言語切り替え時も`updateDateDisplay()`の再呼び出しで連動する |
| ギャラリーカード日付の「の記念日」サフィックス（2026-05） | `buildGalleryCard()`内で日本語表示時のみ日付ラベルを`5月8日の記念日`形式に変更。英語表示は`May 8`のまま（変更なし） |
| ボタンサブテキスト（2026-05） | `#g-waiting`の🔍ボタン直下に`data-i18n="researchSubtitle"`の`<p>`を追加。ja: `AIが今日の記念日に合わせた猫のイラストを作ります`、en: `AI will create a cat illustration for today's anniversary` |
| 画像共有 | Web Share API対応端末は「共有する」ボタン、非対応はダウンロード |
| PWA | Service Worker登録済み（`/anniversary-cat-worker/sw.js`） |
| クライアント側レート制限キャッシュ | `localStorage`に制限済みフラグを保存し二重送信を防止 |
| リトライ | 500系エラーは指数バックオフで最大3回リトライ（429はリトライしない） |
| エラー画面の再試行分岐（2026-07・Issue#149） | `#g-error`の再試行ボタンは`showGenerate("error")`のたびに`updateErrorRetryButton()`が`isSharedView`を見て`.onclick`を動的設定。共有URL閲覧中（`loadSharedImage()`失敗）なら`loadSharedImage(currentSharedId)`を再実行し、通常生成中の失敗なら`startResearch()`を実行する。`#g-result`の`updateResultButtons()`と同じ分岐パターン |
| OGP/Twitter Card | `og:image`と`twitter:image`設定済み |
| Umamiアナリティクス | `cloud.umami.is/script.js`でページビュー自動収集。共有ページ（`loadSharedImage()`成功時）は`window.umami?.track(props => ({ ...props, url: "/anniversary-cat-worker/{id}", title: "{theme} - にゃんバーサリー" }))`で明示的にページビューを送信。**`track({url,title})`形式はUmami v2ではカスタムイベント扱いになりAPIが400を返すため不可。関数形式が正しいページビュートラッキングAPI。**`defer`によるロード順の競合を`window.addEventListener("load", fn, { once: true })`で回避。SUZURIボタンクリックを`data-umami-event="suzuri-click"`＋`data-umami-event-slug={slug}`で計測。ギャラリーカードクリックを`data-umami-event="gallery-click"`＋`data-umami-event-theme={theme}`で計測 |

---

## Pollinations.aiフォールバック

画像生成時、GeminiとPollinationsを**2フェーズ方式**で競合させる。

### フェーズ設計（2026-04実測データに基づく）

| フェーズ | 期間 | 動作 |
| --- | --- | --- |
| Phase1 | 0〜12秒 | GeminiとPollinationsを同時開始。12秒以内にGeminiが完了すればGeminiを採用 |
| Phase2 | 12秒〜 | タイムアウトまたはGemini失敗時に移行。先に完了した方を採用 |

**実装:** `_twoPhaseRace(tryGemini, tryPollinations, priorityMs=12_000)`として`worker/index.js`からexport。`priorityMs`を引数化することでユニットテストで短縮実行できる（`test-bot.mjs`で500msを使用）。

**設計根拠（`scripts/test-gemini-image-timing.mjs`で計測）:**
- Gemini所要時間: 最小6363ms / 最大10203ms / 平均8361ms
- Pollinationsの`turbo`モデルは約2秒で完了
- 12秒ウィンドウ: Gemini最大10.2s < 12s → 通常はGemini先着
- Phase2開始時点でPollinationsは既に完了済み（t=2s）→ Phase2移行時は即返却

**ネットワーク負荷増大時の挙動:**
- 両者同時開始のため、どちらかが先に回復した時点で即返せる
- Pollinations遅延方式（旧設計）と異なり、人工的な待機時間がない

### Pollinationsプロンプト設計

- 使用モデル: `flux` / `turbo` / `flux-realism` / `flux-anime`（4モデル同時並列）
- **プロンプトはASCIIのみ**（日本語等の非ASCII文字はサーバー500エラーの原因になるためフィルタリング済み）
- タイムアウト: 20秒/モデル
- **プロンプト順序（2026-05変更）**: `kawaii watercolor cat, [visualHint], [themeEn], [descriptionEn_excerpt], [persona], [personality], [emotion], [eatingAction], [guestPart], [style]`
  - 先頭に「kawaii watercolor cat」を置き、サービスの根幹（可愛い水彩猫）を宣言
  - `visualHint`（主役名詞＋背景・小物・雰囲気）をその直後に置きFluxモデルが最優先で解釈（前半トークン重視の特性を利用）
  - `themeEn`（英語テーマ名）・`descriptionEn`の先頭30文字をvisualHintの後に追加してコンテキストを補完
  - `themeEn`が未取得の場合は`theme`をASCII化した`themeAscii`（日本語テーマは空文字になる）を使用。`themeAscii`も空の場合は`visualHint`の先頭トークンをテーマの代替として使用（安全網）
  - `_buildPollinationsPrompt(theme, description, persona, personality, visualHint, emotion, eatingAction, guest, themeEn, descriptionEn)`

---

## 過去に修正した問題（再発防止）

[過去のバグ履歴：過去に修正した問題（再発防止）](../bugs-history.md)参照

---

## 将来の拡張に関する設計方針メモ

[将来拡張メモ：将来の拡張に関する設計方針メモ](../future-ideas.md)参照

---

## ボット作品ギャラリー（実装済み・2026-04）

### 概要

直近14日間のボット生成画像をトップページに横スクロールギャラリーで表示する。
SUZURIグッズが登録済みの日のみカードを表示し、購買導線として機能する。

### フロー

```text
ページ読み込み
  → /meta/bot/YYYY-MM-DD × 14日分を並列fetch（JST基準で過去にさかのぼる）
  → products.length > 0 の日 → カード表示（サムネイル + 日付 + テーマ名・EN時は英語）
  → products.length = 0 の日 → カード表示 + バックグラウンドでSUZURI登録を開始
      ↓
      /image/bot/YYYY-MM-DD をfetch（base64 imageData取得）
      createSuzuriFromImage() → Canvas WMあり → /suzuri-create
      （fal.ai ESRGAN 2x or ブラウザ 2048px bicubic フォールバック）
  → カードクリック → ?id=bot/YYYY-MM-DD へ遷移（共有ビュー）
```

### /thumb/:id エンドポイント

ギャラリーサムネイル専用。`/image/:id` がJSON+base64を返すのと異なり、R2画像バイナリを直接レスポンスする。

- ブラウザの `<img loading="lazy">` と組み合わせて帯域を節約
- `Cache-Control: public, max-age=86400` を付与してブラウザキャッシュを活用
- 404時（期限切れ・存在しない日）はそのまま404を返す

### 重複SUZURI登録の防止

`/suzuri-create` 冒頭の重複防止チェック（R2メタ参照）が二重登録を防ぐ。ただしWorker側チェックはTOCTOUギャップがあるため、フロントエンド側で同時呼び出し自体を防ぐことが重要（下記参照）。

**この重複防止チェック自体のTOCTOUギャップと、`updateMetaInR2()`のロストアップデートは別の問題（2026-09追記・Bug#34）:** ほぼ同時の2リクエストが両方「未登録」と判定してしまうチェック自体の競合（本節冒頭のTOCTOU）は、フロントエンド側の同時呼び出し防止で緩和しているのみで完全には閉じていない。一方、Bug#34で修正したのは「その結果生まれた重複登録の片方がR2メタの記録から完全に消えて孤立する」という別レイヤーの問題（`updateMetaInR2()`の非アトミック性）。修正後は、仮に重複登録自体が発生しても両方のmaterialIdが必ずR2メタに記録されるため14日後の自動クリーンアップで確実に片付く＝「孤立して見えなくなる」実害はなくなった。

**フロントエンド側の重複防止（2026-04追加）:**

`?id=bot/YYYY-MM-DD` を開いたとき、`loadGallery()` のバックグラウンド登録と `loadSharedImage()` が同じidに対して同時に `createSuzuriFromImage()` を呼び出す競合が発生していた。`loadGallery()` でURLの `?id` と一致するidはバックグラウンド登録をスキップし、`loadSharedImage()` に一本化することで解消。

```js
const currentPageId = new URLSearchParams(location.search).get("id");
if (!(meta.products?.length > 0) && id !== currentPageId) {
  registerGalleryItemInBackground(id, meta);
}
```

### R2保存期間との関係

| 保存期間 | 平日最大カード数 | 理由 |
| --- | --- | --- |
| 7日（旧） | 5枚 | 週5日 |
| **14日（現行）** | **10枚** | 週5日 × 2週 |

---

## RSSフィード（実装済み・2026-04）

### 概要

ボット作品ギャラリーと同じR2メタデータをRSS 2.0形式で配信する。
RSSリーダーから購読でき、ボットの新規投稿を受け取れる。

### エンドポイント仕様

- **URL**: `GET /rss.xml`
- **Content-Type**: `application/rss+xml; charset=utf-8`
- **Cache-Control**: `public, max-age=3600`（1時間）
- **件数**: 直近14日分（R2にデータがある日のみ）

### フロー

```text
GET /rss.xml
  → 直近14日分の id（bot/YYYY-MM-DD）を生成（JST基準）
  → getMetaFromR2() × 14日分を並列fetch
  → metaが存在する日のみ <item> として出力
  → RSS 2.0 XML を返却（1時間キャッシュ）
```

### <item> の構成

| フィールド | 内容 |
| --- | --- |
| `<title>` | `4月13日 - 決闘の日` 形式 |
| `<link>` | `https://hiroshikuze.github.io/anniversary-cat-worker/?id=bot/YYYY-MM-DD` |
| `<description>` | CDATA: サムネイル `<img>` + 説明テキスト `<p>` |
| `<pubDate>` | R2メタの `createdAt` をRFC 822形式に変換（例: `Mon, 13 Apr 2026 10:00:43 GMT`） |
| `<guid>` | `<link>` と同一（isPermaLink="true"） |
| `<enclosure>` | `/thumb/:id` URL・type="image/png"・length=0 |

### autodiscovery

`frontend/index.html` の `<head>` に以下を追加済み。RSSリーダーやブラウザが自動検出する。

```html
<link rel="alternate" type="application/rss+xml" title="にゃんバーサリー"
  href="https://anniversary-cat-worker.hiroshikuze.workers.dev/rss.xml">
```

ギャラリーセクションのタイトル横にもRSSアイコン（SVG）リンクを表示している。

### 実装上の注意点

- `enclosure` 要素の `length` は動的に取得できないため `0` を設定している。一部のRSSバリデータは警告を出すが、主要RSSリーダーでは問題なく動作する
- Worker内のJST変換は `toJSTDateStringWorker()` として定義（フロントエンドの `toJSTDateString()` と同一ロジック）
- XML特殊文字（`&` `<` `>` `"` `'`）は `escapeXml()` でエスケープし、descriptionはCDATAセクションで出力

---

### 将来の改善アイデア（検討中・未実装）

[将来拡張メモ：将来の改善アイデア（検討中・未実装）](../future-ideas.md)参照
