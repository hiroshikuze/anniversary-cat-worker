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
│   └── deploy-pages.yml              ← main push時: GitHub Pagesデプロイ
├── .claude/
│   ├── revision_log.md               ← ミスパターン記録（毎セッション冒頭で読む）
│   ├── bugs-history.md               ← バグ履歴 Bug#1〜（都度参照・自動ロードなし）
│   ├── future-ideas.md               ← 将来拡張アイデア（都度参照・自動ロードなし）
│   ├── settings.json                 ← PostToolUseフック（Markdownスペース検証）
│   ├── archive/
│   │   └── revision_log_2026-03.md   ← アーカイブ済みの旧revision_log
│   └── rules/                        ← 以下は毎セッション自動ロード
│       ├── coding.md                 ← コーディング規約・Markdown執筆ルール
│       ├── testing.md                ← テスト方針・診断手順
│       ├── git-workflow.md           ← Gitワークフロー・デプロイ手順
│       ├── architecture.md           ← このファイル（設計・仕様）
│       └── suzuri-api-reference.md   ← SUZURI APIリファレンス抜粋
├── worker/
│   ├── index.js                      ← Cloudflare Worker本体（fetch + scheduledハンドラ）
│   ├── bot.js                        ← Bluesky/Mastodon Botロジック・Discord通知（旧 bluesky-bot.js）
│   ├── fal.js                        ← fal.ai ESRGAN 2xアップスケーリング（Queue API）
│   ├── suzuri.js                     ← SUZURI API連携（商品生成・削除）
│   └── r2-storage.js                 ← Cloudflare R2ストレージ操作
├── frontend/
│   ├── index.html                    ← フロントエンド（PWA対応、JP/EN切り替え）
│   ├── manifest.json
│   ├── sw.js
│   └── images/                       ← faviconアイコン類
└── scripts/
    ├── health-check.js               ← E2E診断（GitHub Actionsのみ実行）
    ├── test-bot.mjs                  ← ユニットテスト（外部API不要）← npm test
    ├── test-suzuri.mjs               ← worker/suzuri.jsユニットテスト（外部API不要）
    ├── test-suzuri-api.mjs           ← SUZURI API動作確認（実商品が生成される）
    ├── test-fal-models.mjs           ← fal.aiモデル比較（FAL_KEY必要）
    ├── test-gemini-image-timing.mjs  ← Gemini画像生成の所要時間計測（GEMINI_API_KEY必要）
    ├── test-gemini-research-batch.mjs ← バッチ vs シングル精度比較（GEMINI_API_KEY必要）
    ├── test-pool-30days.mjs          ← 事前リサーチプール方式シミュレーション（GEMINI_API_KEY必要）
    ├── generate-kana-translations.mjs ← translations.kanaブランチのruby HTML一括生成（kuroshiro使用・一回限りユーティリティ）
    └── preview-kana.mjs              ← かなモードのrubyふりがなをブラウザでプレビュー（引数: theme description）
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
| POST | `/suzuri-create` | ウォーターマーク済み画像を受け取りSUZURI登録・R2メタ更新 |

### /proxy-imageのセキュリティ制約

`https://image.pollinations.ai/`以外のURLはすべて403で拒否する（オープンプロキシ化防止）。

---

## /suzuri-createエンドポイント仕様

フロントエンドがCanvasでウォーターマーク合成した画像をSUZURIに登録するエンドポイント。
`/generate`からSUZURI登録処理を分離することで、合成済み画像のみSUZURIに送れる。

商品ごとにウォーターマーク位置が異なるため、フロントから**2回**呼び出す（右下グループ・中央下グループ）。

**ウォーターマーク位置ルール:**

| 商品 | position | 理由 |
| --- | --- | --- |
| `t-shirt` / `sticker` | `bottom-right` | 矩形商品なのでコーナーが見切れない |
| `can-badge` / `acrylic-keychain` | `bottom-center` | 円形・変形クロップでコーナーが切れるため |

**リクエスト:**

```json
{
  "imageData": "<base64>",
  "hiresImageData": "<base64>",
  "mimeType": "image/jpeg",
  "theme": "記念日テーマ",
  "r2Id": "user/{uuid}",
  "slugs": ["t-shirt", "sticker"],
  "description": "記念日の説明文",
  "backTexture": "data:image/jpeg;base64,..."
}
```

- `slugs`は任意。指定時はそのスラッグのみSUZURI登録する（未指定時は全4商品）。
- `r2Id`は任意。指定時はSUZURI登録完了後にR2の`meta.json`を`materialId`/`products`で更新する。最初の呼び出しにのみ指定する。
- `hiresImageData`は任意。t-shirt/stickerグループのみ送る。フロントがCanvas `imageSmoothingQuality:"high"`（Chrome: Lanczos / Firefox・Safari: bicubic）で2048pxにリサイズした画像。fal.ai失敗時のフォールバックとして使用し、元画像（~1024px）より印刷品質が向上する。`imageData`はfal.ai投入用として元サイズのまま維持する（2048px入力→ESRGAN→4096px≈24MBとなりSUZURI 20MB超過を招くため）。
- `description`は任意。`/research`が返す記念日説明文。SUZURIマテリアルの`description`フィールドに使用する。
- `backTexture`は任意。t-shirt/stickerグループのみ送る。フロントが`generateKanjiTexture(kanjiChar)`でCanvas生成した漢字テクスチャ（`data:image/jpeg;base64,...`形式）。`kanjiChar`がnullまたは無効値の場合は🐾フォールバックで生成し、必ず送信する。Tシャツのみ`sub_materials`（背面印刷）として適用。

**重複防止チェック（2026-04追加）:**

`r2Id`と`slugs`が両方指定された場合、R2メタの`products`に対象スラッグが全件存在すれば既存データを返して登録をスキップする。これによりボット画像への複数ユーザー同時訪問による二重登録を防ぐ。

**レスポンス:**

```json
{
  "products": [{ "slug": "t-shirt", "sampleUrl": "...", "previewImageUrl": "...", "available": true }, ...],
  "materialId": 12345
}
```

| フィールド | 説明 |
| --- | --- |
| `slug` | 商品種別（`t-shirt` / `sticker` / `can-badge` / `acrylic-keychain`） |
| `sampleUrl` | SUZURIの商品詳細ページURL |
| `previewImageUrl` | グッズプレビュー画像URL（`pngSampleImageUrl` → `sampleImageUrl` の優先順）。フロントでサムネイルカード表示に使用 |
| `available` | 在庫あり: true / 在庫切れ: false |
| `queued` | t-shirt/sticker のfal.ai処理中: true（`previewImageUrl`なし） |

**フロントのグッズ表示（`showGoods()`）:**

| 状態 | 表示 |
| --- | --- |
| `available: true` + `previewImageUrl`あり | サムネイル画像カード（`<img>` + 商品名ラベル）。SUZURIへリンク |
| `available: true` + `previewImageUrl`なし | テキストボタン（後方互換） |
| `queued: true` | 生成済み猫画像を`opacity-40`に暗転 + 商品アイコンオーバーレイ（「準備中」トースト） |
| それ以外（在庫切れ等） | `btn-disabled`グレーボタン |

**SUZURIプレビュー画像のCDN遅延対策（2026-04）:**

商品登録直後、SUZURIはプレビュー画像を非同期生成する。生成完了前にブラウザがURLを叩くと404が返りネガティブキャッシュされる。`<img onerror>`で3秒後に1回だけリトライ（`?r=1`クエリ付加でキャッシュ回避）。

- `SUZURI_API_KEY`未設定時は503を返す
- レート制限なし（`/generate`のレート制限が上流で機能するため）

**SUZURIマテリアル説明文（`buildDescription()`・2026-04）:**

`POST /api/v1/materials`の`description`フィールドは任意文字列として公式APIが対応していることを確認済み（[developer docs](https://suzuri.jp/developer/documentation/v1)）。

```text
{M}月{D}日の「{theme}」をテーマにしました。
【期間限定！】{期限日}（日本時間）までの販売🐱

{description}          ← 空の場合はこのブロックごと省略

にゃんバーサリー {URL}  ← r2Id指定時は?id={r2Id}付き画像ページ、未指定はTOPページ
#AIイラスト #猫 #水彩画 #記念日 #にゃんバーサリー #{themeTag} #{guestSuzuriTag}
```

- 登録日のJST日付と期限日（+14日JST）は`buildDescription(theme, description, r2Id, nowMs)`内で算出
- `nowMs`はテスト用引数（デフォルト`Date.now()`）。固定値で日付ロジックの回帰テストが可能
- SUZURI自動削除（14日）は`scheduled()`のcleanupブロックで実装済み。R2と期限を統一している
- `{themeTag}`はthemeの末尾の「の日」を除去してタグ化（例: 大仏の日 → `#大仏`）。記号のみになる場合は省略
- `{guestSuzuriTag}`はゲスト登場時のみ追加（例: `#犬` `#うさぎ`）。伴侶猫・子猫は`#猫`と重複するため追加しない

**`createSuzuriProducts()`のシグネチャ（2026-04更新）:**

```js
createSuzuriProducts(imageUrl, theme, env, slugFilter = null, backTexture = null, description = "", r2Id = null, guestSuzuriTag = null)
```

- `backTexture`: Tシャツのみ`sub_materials`（背面印刷）に使用。`data:image/jpeg;base64,...`形式。nullの場合は背面印刷なし
- `description`・`r2Id`はフロントから`/suzuri-create`のリクエストボディで受け取り、`/resume-hires`ではR2メタから取得する
- can-badge/acrylic-keychainグループの呼び出しでは`backTexture=null`を渡す（Tシャツへの背面印刷は右グループのみ）
- 全商品に`resizeMode: "contain"`を設定（画像がアスペクト比を保ったまま収まる）

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
| Human Cat（甘えん坊） | 35 | 35% | 見つめる・寄り添う・穏やか表情 |
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

- `personality`（性格）: 「このキャラクターはどんな気質・傾向か」（普遍的な性格）
- `emotion`（感情の瞬間）: 「この絵の中で今何を感じているか」（一瞬の感情状態）

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

### 画像生成モデル（`worker/index.js`の`KNOWN_CANDIDATES`）

```js
const KNOWN_CANDIDATES = [
  "gemini-2.5-flash-image",              // 2026-03現在のstable（メイン）
  "gemini-2.0-flash-exp",                // 廃止済みの可能性あり
  "gemini-2.0-flash-preview-image-generation",  // 廃止済み（404）
];
```

**モデルが404になったら:**

1. Actionsタブでhealth-checkの失敗を確認（またはCloudflareログで`unavailable(404)`を確認）
2. [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models)で現行モデルを確認
3. `KNOWN_CANDIDATES`の先頭を新しいモデルに更新してpush → Actionsで確認

### Researchモデル（テキスト用）

`selectBestModel()`がスコアリングで自動選択。手動設定不要。ログ: `[model-select] selected: gemini-xxx`

### Gemini画像生成プロンプト（`handleGenerate()`・2026-05変更）

`themeEn`/`descriptionEn`が利用可能な場合は英語版を使用し、未取得の場合のみ日本語の`theme`/`description`にフォールバックする。

```text
Theme: {themeEn || theme}.
Context: {descriptionEn || description}.
Setting and surrounding atmosphere; the cat may naturally interact with theme-related items...: {visualHint}.
```

- altテキスト・SUZURI商品説明は**日本語のみ**（`theme`/`description`を使用。変更しない）
- `themeEn`/`descriptionEn`は`handleGenerate(body)`の`body`経由で受け取る（ボット: `research.themeEn`/`research.descriptionEn`から渡す。ユーザー生成: `/generate`リクエストボディに含めてもよいが必須ではない）

### visualHintの役割（2026-05変更）

旧役割: テーマが日本語のみのときPollinationsプロンプトのASCII化で内容が失われる問題を補完（「日本語回避」）。

新役割: テーマに依存せず**ビジュアル演出**に特化。`themeEn`で英語テーマが確保されるため、visualHintは主役名詞＋背景・小物・雰囲気の提示に集中する。

**`handleResearch()`のvisualHint生成指示（2026-05更新）:**

```text
今日の記念日テーマから主役となる名詞（動物・物・人物）を1〜2語で先頭に抽出し、
続いて関連する背景・小物・雰囲気を3〜6語で続ける。ASCII英語、計5〜8語。
例: 図書館記念日 → library books, warm reading nook, wooden bookshelves, soft lamplight
例: 象の日 → large friendly elephant, Kyoto imperial garden, pine trees, stone lanterns
```

**Pollinationsでのvisualの使い方（安全網ロジック）:**

`_buildPollinationsPrompt`の`usedVhAsSubject`ロジックは`themeEn`が空の稀なフォールバック用に残存する。`themeEn`が存在する場合は`usedVhAsSubject=false`となり、visualHint全体がビジュアル演出として使われる。

---

## Bluesky Bot

### 設計方針

- Botアカウント: `@nyanmusu.bsky.social`
- 投稿スケジュール: 月〜金 7:00 JST（UTC 22:00 前日）、Cron式: `0 22 * * 1-5`（2026-05-01より。変更前: `0 10 * * 2-6`（19:00 JST））
- ハッシュタグ: テーマ由来の動的タグ1件を先頭に置き、固定タグ`#AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー`を後続（Instagramで末尾タグを省略しやすくするため）
- エラー時: リトライなし（`/generate`内部にPollinationsフォールバックあり）
- Mastodon同時投稿: `Promise.allSettled`で並列実行。Mastodon失敗はBluesky投稿に影響しない。シークレット未設定時はスキップ
- **Mastodon設定エラー検出**: `MASTODON_INSTANCE_URL`が`https://`で始まらない場合は`throw new Error(...)`でPromise.allSettledに拒否を返し、Discordの`mastoLine`に`❌ Mastodon投稿失敗: 設定エラー`として表示する（旧: `return null`でスキップしていたが、Discordに何も出ず原因不明になるため変更）。投稿後にstatus=401/403が返った場合も「設定エラー（認証失敗）」として`console.error`に分類して出力する
- **Mastodon未設定時**: `mastoLine`に`⏭️ Mastodon未設定・スキップ`を表示し、`console.log`でCloudflareログにも記録する（旧: Discord通知から行ごと省略していたため処理状態が不明だった）
- **R2保存キーのスロット方式（`bot/YYYY-MM-DD-n`）**: 同日に複数回`runBot()`が実行された場合（意図的・偶発的を問わず）、既存のR2キーを上書きせず`bot/YYYY-MM-DD-2`、`bot/YYYY-MM-DD-3`…とスロットをずらして保存する。`findAvailableR2Id(bucket, jstDateISO)`がmeta.jsonの存在確認で次のスロットを決定する（最大`-9`まで、超過時は`-9`を上書き）。ギャラリー・RSSは`bot/YYYY-MM-DD`（1スロット目）のみ参照。2スロット目以降のBluesky共有URLは`?id=bot/YYYY-MM-DD-2`形式で有効。削除は`listExpiredIds()`がスロット単位で自然に処理する（変更不要）

### 投稿テキスト形式

#### Bluesky（`buildPostText()`・日本語のみ）

```text
今日は「{theme}」の日！🐱       ← theme が「の日」で終わる場合は「の日」を省略
{description}

📸 {artworkUrl}                  ← R2保存成功時のみ挿入（?id=bot/YYYY-MM-DD）

あなたも今日の #にゃんバーサリー を作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー #{guestSnsTag}
```

- `{guestSnsTag}`はゲスト登場時のみ末尾に追加（例: `#dog` `#rabbit`）。伴侶猫・子猫は`#cat` `#kitten`と重複するため追加しない
- `artworkUrl`は`pageUrl !== SITE_URL`のとき（R2保存成功）のみ追加される。失敗時はCTAのみ（~210 grapheme）
- 300 grapheme以内に収まる設計（`artworkUrl`あり時の実測 ~270 grapheme・ゲストタグ追加後も余裕あり）。テーマタグを先頭にすることでInstagram手動投稿時に末尾タグを省略しやすくしている。

#### Mastodon（`buildMastodonText()`・英語優先・日英二言語）

英語を先に置くことで海外ユーザーへのリーチを優先する。CTAは日英ともに汎用URL（`SITE_URL`）を指し、個別作品URLは日本語セクション末尾の`📸`行で案内する。

```text
Today is "{themeEn}"!
{descriptionEn}

Why don't you try making your own #Nyaniversary today?
https://hiroshikuze.github.io/anniversary-cat-worker/?lang=en

今日は「{theme}」！🐱
{description}

📸 {artworkUrl}                  ← R2保存成功時のみ挿入（?id=bot/YYYY-MM-DD）

あなたも今日の #にゃんバーサリー を作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #Nyaniversary #にゃんバーサリー #{guestSnsTag}
```

- `themeEn`・`descriptionEn`は`handleResearch()`がGeminiから取得する英語フィールド
- `themeEn`が空の場合は英語セクション全体を省略し、Blueskyと同一テキスト（`buildPostText()`）にフォールバック
- `descriptionEn`が空の場合は英語説明行のみ省略
- `artworkUrl`は`pageUrl !== SITE_URL`のとき（R2保存成功）のみ挿入。失敗時は省略
- 想定文字数: ~460文字（artworkUrlあり時・Mastodon標準上限500文字以内）
- altテキスト・SUZURI商品説明は**日本語のみ**（変更しない）

**「の日」重複防止ロジック（`buildPostText`）:**

- `theme.endsWith("の日")` が true の場合 → `今日は「{theme}」！🐱`（重複なし）
- false の場合 → `今日は「{theme}」の日！🐱`（通常通り付与）
- 例: `"大仏の日"` → `今日は「大仏の日」！🐱` / `"お花見"` → `今日は「お花見」の日！🐱`

### テーマタグ正規化（`buildThemeTag`）

`research.theme`から記念日テーマをハッシュタグ文字列へ変換する。

- Unicode文字・数字・アンダースコア以外（空白・句読点・記号等）を除去
- 空文字になる場合は`null`を返し、タグ行に追加しない
- 最大30文字でトリム
- 例: `"世界猫の日"` → `#世界猫の日`、`"ロールプレイング・ゲームの日"` → `#ロールプレイングゲームの日`

### 画像altテキスト形式

```text
にゃんバーサリー - 「{theme}」の日！{description}（AIが生成した水彩画風の猫イラスト）
```

- descriptionが空の場合は従来形式: `にゃんバーサリー - 「{theme}」をテーマにAIが生成した水彩画風の猫イラスト`
- テーマと記念日説明を含めることで、スクリーンリーダーユーザーへの情報提供と検索流入の両立を図る

### Discord通知（`notifyDiscord()`）

**制約・動作（2026-04）:**

- Discord Webhook `content` フィールドは**2,000文字上限**（超過するとHTTP 400）
- `notifyDiscord()`は先頭ヘッダー（`{emoji} にゃんバーサリーBot\n`）を確保したうえで本文を上限内に切り詰め、末尾に`\n...`を付加する
- 送信後は`res.ok`を確認し、失敗時は`console.warn`でログを出力する
- タイムアウト: `AbortSignal.timeout(10_000)`（10秒）
- `webhookUrl`が未設定の場合は即座にreturnしてスキップ

**2通目分割方式（2026-04追加・2026-05再編）:**

`runBot()`内で`notifyDiscord()`を2回`await`順次呼び出しすることで全文を送信する。各通の文字数が2000字上限に対して均等になるよう、Geminiプロンプトを1通目・Pollinationsプロンプトとすべての投稿テキストを2通目に振り分けている（1通目 ~1,100字・2通目 ~1,200字）。

- **1通目** (`✅`/`❌`): 投稿成否 + テーマ情報 + Geminiプロンプト（採用/不採用いずれも表示）
- **2通目** (`📣`): 成否再掲 + Pollinationsプロンプト + Bluesky投稿テキスト + Mastodon投稿テキストまたは注記
  - `themeEn`あり（日英二言語）: `📣 Mastodon投稿テキスト（二言語・転載用）:\n{mastoText}`
  - `themeEn`なし（日本語のみ）: `⚠️ themeEn未取得のためMastodon投稿テキストはBlueskyと同一（日本語のみ）`
- 2通目に成否を再掲することで、1通目が文字数で省略されても結果を確認できる
- 2通目が失敗しても1通目は送信済みのため情報損失はBluesky部分に限られない

### Discord成功通知フォーマット

投稿完了後に`notifyDiscord()`で送信される通知（2通構成）。

```text
✅ にゃんバーサリーBot
✅ Bluesky投稿完了 {dateStr}      ← Bluesky失敗時は ❌ Bluesky投稿失敗: {エラー}
✅ Mastodon投稿完了               ← 設定済みの場合。失敗時は ❌ Mastodon投稿失敗: {エラー}。未設定時は ⏭️ Mastodon未設定・スキップ
📅 テーマ: {theme}
📝 説明: {description}           ← descriptionがある場合のみ
🎨 視覚ヒント: {visualHint}      ← visualHintがある場合のみ
🐱 毛柄: {persona}               ← personaがある場合のみ
😺 性格: {personality}           ← personalityがある場合のみ（子猫ゲスト時は保護者修飾を含む）
💭 感情: {emotion}               ← emotionがある場合のみ
🍴 食べ物アクション: {eatingAction} ← eatingActionがある場合のみ
🐾 ゲスト外見: {guest.appearance}   ← ゲスト登場時のみ
🐾 ゲスト性格: {guest.personality}  ← ゲスト登場時のみ
🈁 裏面漢字: {kanjiChar}（採用）    ← 常に表示（無効値は「なし→🐾」）
🖼 ソース: {source}

📋 Geminiプロンプト（採用）:     ← Gemini採用時は「（採用）」付き
{prompt}                         ← promptがある場合のみ
```

**2通目フォーマット（themeEnあり）:**

```text
📣 にゃんバーサリーBot
✅ Bluesky投稿完了 {dateStr}      ← 1通目と同じ成否ステータスを再掲
✅ Mastodon投稿完了               ← 同上（失敗/未設定時はそれぞれ表示）

📋 Pollinationsプロンプト:       ← Pollinations採用時は「（採用）」付き
{pollinationsPrompt}             ← pollinationsPromptがある場合のみ

📣 Bluesky投稿テキスト（X・Instagram等に転載用）:
{buildPostText()の出力全文}      ← 日本語のみ・ハッシュタグ・URL含む

📣 Mastodon投稿テキスト（二言語・転載用）:
{buildMastodonText()の出力全文}  ← 日英二言語・ハッシュタグ・URL含む
```

**2通目フォーマット（themeEn未取得）:**

```text
📣 にゃんバーサリーBot
✅ Bluesky投稿完了 {dateStr}
✅ Mastodon投稿完了

📋 Pollinationsプロンプト:
{pollinationsPrompt}

📣 Bluesky投稿テキスト（X・Instagram等に転載用）:
{buildPostText()の出力全文}

⚠️ themeEn未取得のためMastodon投稿テキストはBlueskyと同一（日本語のみ）
```

**設計意図**: 1通目は「採用プロンプト確認」、2通目は「転載用テキスト一式 + フォールバックプロンプト」として役割を分離。どちらのAIが採用されたかは「（採用）」表示で確認でき、採用されなかった方のプロンプトも2通目に記載されるため手動比較検証が可能。

### Bluesky AT Protocolエンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 認証 | `POST https://bsky.social/xrpc/com.atproto.server.createSession` |
| 画像アップロード | `POST https://bsky.social/xrpc/com.atproto.repo.uploadBlob` |
| 投稿作成 | `POST https://bsky.social/xrpc/com.atproto.repo.createRecord` |

### Mastodon APIエンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 画像アップロード | `POST {MASTODON_INSTANCE_URL}/api/v2/media` |
| 投稿作成 | `POST {MASTODON_INSTANCE_URL}/api/v1/statuses` |

**認証**: `Authorization: Bearer {MASTODON_ACCESS_TOKEN}` ヘッダー

**画像アップロード**: `multipart/form-data`。`file`フィールドに画像、`description`フィールドにaltテキスト（最大1500文字）。

**投稿作成**: `application/x-www-form-urlencoded`。`status`フィールドにテキスト、`media_ids[]`フィールドにmediaId。重複投稿防止のため`Idempotency-Key: {uuid}`ヘッダーを付与。

**タイムアウト（Bluesky）**: 認証・画像アップロード・投稿作成それぞれ`AbortSignal.timeout(10_000)`（各10秒）。

**タイムアウト（Mastodon）**: アップロード・投稿ともに`AbortSignal.timeout(10_000)`（各10秒）。Workerのwall-clock制限内で収めるため30秒から短縮（2026-04）。

**テキスト**: `buildMastodonText()`で生成した**英語優先・日英二言語テキスト**を使用（`pageUrlEn`含む）。Mastodonはハッシュタグを自動認識するためAT Protocol facetsは不要。`themeEn`未取得時は`buildPostText()`（日本語）にフォールバック。

**シークレット設定**:
```bash
wrangler secret put MASTODON_INSTANCE_URL   # 例: https://mstdn.jp（末尾スラッシュなし）
wrangler secret put MASTODON_ACCESS_TOKEN   # Mastodon設定→開発→アプリ→アクセストークン
```
必要スコープ: `write:statuses` + `write:media`

**未設定時の動作**: `MASTODON_INSTANCE_URL` または `MASTODON_ACCESS_TOKEN` が未設定の場合、Mastodon投稿をスキップして`Promise.resolve(null)`を返す。Bluesky単体で動作継続。

---

## フロントエンド機能概要（`frontend/index.html`）

| 機能 | 詳細 |
| --- | --- |
| 多言語対応 | JP/EN切り替えボタン（`translations`オブジェクトで管理） |
| 英語ページのテーマ表示（2026-05） | `?lang=en`時かつ`themeEn`/`descriptionEn`が存在する場合、テーマ名・説明文を英語で表示。取得できない場合は日本語にフォールバック。ギャラリーカードも同様（テーマ: `meta.themeEn`、日付: `May 3`形式） |
| 日付バッジの「今日の記念日」ラベル（2026-05） | 日付バッジ（`#today-date`）の前に`#today-date-label`スパンを追加。`updateDateDisplay(date=null)`でdateがnullの場合（通常表示）は`今日の記念日`（EN: `Today's Anniversary`）を表示し、dateが指定された場合（共有ビュー）は空文字にして非表示にする。言語切り替え時も`updateDateDisplay()`の再呼び出しで連動する |
| ギャラリーカード日付の「の記念日」サフィックス（2026-05） | `buildGalleryCard()`内で日本語表示時のみ日付ラベルを`5月8日の記念日`形式に変更。英語表示は`May 8`のまま（変更なし） |
| ボタンサブテキスト（2026-05） | `#g-waiting`の🔍ボタン直下に`data-i18n="researchSubtitle"`の`<p>`を追加。ja: `AIが今日の記念日に合わせた猫のイラストを作ります`、en: `AI will create a cat illustration for today's anniversary` |
| 画像共有 | Web Share API対応端末は「共有する」ボタン、非対応はダウンロード |
| PWA | Service Worker登録済み（`/anniversary-cat-worker/sw.js`） |
| クライアント側レート制限キャッシュ | `localStorage`に制限済みフラグを保存し二重送信を防止 |
| リトライ | 500系エラーは指数バックオフで最大3回リトライ（429はリトライしない） |
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
