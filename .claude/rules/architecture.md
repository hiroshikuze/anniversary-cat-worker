# システム設計・API仕様・将来拡張

## ファイル構成

```text
anniversary-cat-worker/
├── CLAUDE.md                    ← 判断品質ルール（最重要原則6つ含む）
├── .claude/
│   ├── revision_log.md          ← ミスパターン記録（毎セッション冒頭で読む）
│   ├── settings.json            ← フォーマッタ等の自動発火処理
│   └── rules/
│       ├── coding.md            ← コーディング規約・Markdown執筆ルール
│       ├── testing.md           ← テスト方針・診断手順
│       ├── git-workflow.md      ← Gitワークフロー・デプロイ手順
│       └── architecture.md     ← このファイル（設計・仕様・将来拡張）
├── worker/
│   ├── index.js                 ← Cloudflare Worker本体（fetch + scheduledハンドラ）
│   └── bluesky-bot.js           ← Bluesky Botロジック（index.jsからimport）
├── frontend/
│   └── index.html               ← フロントエンド（GitHub Pages）
├── scripts/
│   ├── health-check.js              ← E2E診断スクリプト（GitHub Actionsで自動実行）
│   ├── test-bot.mjs                 ← bluesky-bot.jsのユニットテスト（外部API不要）
│   ├── test-suzuri-api.mjs          ← SUZURI API動作確認スクリプト
│   ├── test-fal-models.mjs          ← fal.aiモデル比較スクリプト（FAL_KEY必要）
│   └── test-gemini-image-timing.mjs ← Gemini画像生成の所要時間計測（GEMINI_API_KEY必要）
└── wrangler.toml                ← Cloudflareデプロイ設定（Cron Trigger含む）
```

---

## APIエンドポイント一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/research` | Gemini + Google Searchで記念日テキスト取得 |
| POST | `/generate` | Gemini画像生成（Pollinationsフォールバックあり） |
| GET | `/proxy-image?url=...` | Pollinations.ai画像のCORSプロキシ |
| GET | `/image/:id` | R2保存画像+メタデータの取得（`bot/YYYY-MM-DD`または`user/{uuid}`） |
| GET | `/meta/:id` | R2メタデータのみ取得（画像なし・ポーリング用軽量エンドポイント） |
| GET | `/hires/:id` | fal.ai高解像度画像をR2から返す（SUZURI向け安定URL） |
| GET | `/thumb/:id` | R2画像バイナリを直接返却（ギャラリーサムネイル用・base64不要） |
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
  "slugs": ["t-shirt", "sticker"]
}
```

- `slugs`は任意。指定時はそのスラッグのみSUZURI登録する（未指定時は全4商品）。
- `r2Id`は任意。指定時はSUZURI登録完了後にR2の`meta.json`を`materialId`/`products`で更新する。最初の呼び出しにのみ指定する。
- `hiresImageData`は任意。t-shirt/stickerグループのみ送る。フロントがCanvas `imageSmoothingQuality:"high"`（Chrome: Lanczos / Firefox・Safari: bicubic）で2048pxにリサイズした画像。fal.ai失敗時のフォールバックとして使用し、元画像（~1024px）より印刷品質が向上する。`imageData`はfal.ai投入用として元サイズのまま維持する（2048px入力→ESRGAN→4096px≈24MBとなりSUZURI 20MB超過を招くため）。

**重複防止チェック（2026-04追加）:**

`r2Id`と`slugs`が両方指定された場合、R2メタの`products`に対象スラッグが全件存在すれば既存データを返して登録をスキップする。これによりボット画像への複数ユーザー同時訪問による二重登録を防ぐ。

**レスポンス:**

```json
{
  "products": [{ "slug": "t-shirt", "sampleUrl": "...", "available": true }, ...],
  "materialId": 12345
}
```

- `SUZURI_API_KEY`未設定時は503を返す
- レート制限なし（`/generate`のレート制限が上流で機能するため）

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

---

## Bluesky Bot

### 設計方針

- Botアカウント: `@nyanmusu.bsky.social`
- 投稿スケジュール: 月〜金 19:00 JST（UTC 10:00）、Cron式: `0 10 * * 2-6`
- ハッシュタグ: `#AIart #cat #kitten #ほのぼの #猫`（固定）＋テーマ由来の動的タグ1件（AT Protocol facets形式で付与）
- エラー時: リトライなし（`/generate`内部にPollinationsフォールバックあり）

### 投稿テキスト形式

```text
今日は「{theme}」の日！🐱       ← theme が「の日」で終わる場合は「の日」を省略
{description}

あなたも今日の #にゃんバーサリー を作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー #{theme正規化}
```

300 grapheme以内に収まる設計（実測 ~210 grapheme）。

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

### Discord成功通知フォーマット

Bluesky投稿完了後に`notifyDiscord()`で送信される通知（Discord上限2,000文字・通常~1,200文字）。

```text
✅ にゃんバーサリーBot
✅ Bluesky投稿完了 {dateStr}
📅 テーマ: {theme}
📝 説明: {description}           ← descriptionがある場合のみ
🎨 視覚ヒント: {visualHint}      ← visualHintがある場合のみ
🐱 毛柄: {persona}               ← personaがある場合のみ
😺 性格: {personality}           ← personalityがある場合のみ
🖼 ソース: {source}

📋 Geminiプロンプト（採用）:     ← Gemini採用時は「（採用）」付き
{prompt}                         ← promptがある場合のみ

📋 Pollinationsプロンプト:       ← Pollinations採用時は「（採用）」付き
{pollinationsPrompt}             ← pollinationsPromptがある場合のみ

📣 投稿テキスト（Mastodon・X・Instagram等に転載用）:
{buildPostText()の出力全文}      ← Blueskyと同一テキスト・ハッシュタグ・URL含む
```

**設計意図**: 📣セクションをそのままコピーして他SNSに貼り付けられる。🔗行は投稿テキスト内にURLが含まれるため省略。どちらのAIが採用されたかは「（採用）」表示で確認できる。採用されなかった方のプロンプトも記載されるため、手動で再実行して比較検証が可能。

### Bluesky AT Protocolエンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 認証 | `POST https://bsky.social/xrpc/com.atproto.server.createSession` |
| 画像アップロード | `POST https://bsky.social/xrpc/com.atproto.repo.uploadBlob` |
| 投稿作成 | `POST https://bsky.social/xrpc/com.atproto.repo.createRecord` |

---

## フロントエンド機能概要（`frontend/index.html`）

| 機能 | 詳細 |
| --- | --- |
| 多言語対応 | JP/EN切り替えボタン（`translations`オブジェクトで管理） |
| 画像共有 | Web Share API対応端末は「共有する」ボタン、非対応はダウンロード |
| PWA | Service Worker登録済み（`/anniversary-cat-worker/sw.js`） |
| クライアント側レート制限キャッシュ | `localStorage`に制限済みフラグを保存し二重送信を防止 |
| リトライ | 500系エラーは指数バックオフで最大3回リトライ（429はリトライしない） |
| OGP/Twitter Card | `og:image`と`twitter:image`設定済み |

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
- **プロンプト順序**: `kawaii watercolor cat, [subject/visualHint], [persona], [personality], [style]`
  - 先頭に「kawaii watercolor cat」を置き、サービスの根幹（可愛い水彩猫）を宣言
  - subject/visualHintをその直後に置くことでFluxモデルがテーマを構図の主軸として扱う（前半トークン重視の特性を利用）

---

## 過去に修正した問題（再発防止）

### 1. Gemini画像生成が404になる（2026-03）

- **原因**: `gemini-2.0-flash-preview-image-generation`が廃止
- **修正**: `KNOWN_CANDIDATES`の先頭を`gemini-2.5-flash-image`に変更
- **場所**: `worker/index.js` L222-228

### 2. sourceUrlがvertexaisearchリダイレクトURLになり404（2026-03）

- **原因**: フィルター条件が`"<vertexaisearch.cloud.google.com>"`と角括弧付きで誤っていた
- **修正**: `!uri.includes("vertexaisearch.cloud.google.com")`に修正
- **場所**: `worker/index.js` L205

### 3. BotがHTTP自己呼び出しでURL設定ミスにより動作しない（2026-03）

- **原因**: `WORKER_URL`環境変数が未設定でURLがundefinedになっていた
- **修正**: `handleResearch()`/`handleGenerate()`を直接関数として呼び出すよう変更
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `scheduled()`

### 4. Cron曜日指定がずれていた（2026-03）

- **原因**: Cloudflare Workersは`1=日曜日`で標準cronと異なる。`1-5`では日〜木になっていた
- **修正**: `0 10 * * 1-5` → `0 10 * * 2-6`（月〜金）
- **場所**: `wrangler.toml` L8

### 5. Bluesky画像アップロードがサイズ超過で失敗（2026-03）

- **原因**: Gemini生成画像（PNG）がBluesky上限1,000,000 bytesを超えることがある（実測 ~1.3MB）
- **修正**: `shrinkImageIfNeeded()`を追加。Photon（WASM）でJPEG圧縮し、それでも超過する場合はPollinationsで512×512を再取得
- **場所**: `worker/bluesky-bot.js` `shrinkImageIfNeeded()` / `ensurePhoton()`

### 6. 記念日の根拠リンクが表示されない（2026-03）

- **原因**: リファクタリング時に`sourceUrl`の表示コードがフロントから消えていた
- **修正**: `<p>`を`<a>`タグに変更し`researchData.sourceUrl`を`href`に設定
- **場所**: `frontend/index.html` L155, L450-458

### 7. SUZURI在庫切れ商品の購入リンクが有効になっていた（2026-03）

- **原因**: 全商品に`<a>`タグを生成していたため、在庫切れでも遷移できた
- **修正**: `GET /api/v1/items`で事前在庫チェック、`available: boolean`を返し、フロントでグレーアウト＋タップ時トースト表示
- **場所**: `worker/suzuri.js` `fetchAvailableItemIds()` / `frontend/index.html` `showGoods()`

### 8. SUZURIの全商品が在庫切れ表示になる（2026-03）

- **原因**: `createdMap`のキーを`p.item?.name`（文字列スラッグ）で作成していたが、SUZURIが返す`item.name`が`SUZURI_ITEM_IDS`のキーと表記が一致しなかった（例: `"StandardTshirt"` vs `"t-shirt"`）
- **修正**: `p.item?.id`（整数）でマップを作成し、`createdMap.get(SUZURI_ITEM_IDS[slug])`で照合するよう変更。文字列の表記ゆれに依存しない
- **再発防止**: `scripts/test-bot.mjs`に`【回帰】item.name表記ゆれ時も全商品available:true`テストを追加
- **場所**: `worker/suzuri.js` `createSuzuriProducts()`

### 9. SUZURIに著作権表示なし画像がアップロードされていた（2026-03）

- **原因**: 画像生成後そのままSUZURI登録していた
- **修正**: `/generate`からSUZURI登録を分離し、フロントCanvas合成（`applyWatermark()`）でウォーターマーク付与後に`POST /suzuri-create`で登録
- **ウォーターマーク仕様**: margin 12px・`© nyanmusu`・半透明黒背景（rgba(0,0,0,0.35)）・白テキスト・JPEG quality 0.92で出力
- **位置**: `position`引数で制御。`'bottom-right'`（右下）または`'bottom-center'`（中央下）。商品グループごとに使い分ける
- **場所**: `frontend/index.html` `applyWatermark(imageData, mimeType, position)` / `_calcWatermarkLayout(imgW, imgH, textW, position)` / `worker/index.js` `/suzuri-create`ハンドラ

### 10. fal.ai AuraSRのCDN画像をbase64変換してWorkers CPU時間超過（2026-04）

- **原因**: `upscaleWithFal()`がfal.ai CDN URLから画像をfetch→ArrayBuffer→base64変換していた。4096×4096 PNG（約4MB）の変換がWorkers CPU時間上限（Paid Bundled: 50ms）を超過
- **修正**: CDNダウンロードを廃止。`upscaleWithFal()`は`{ cdnUrl, mimeType }`を返すだけにし、CDN URLを直接SUZURIの`texture`フィールドに渡す（SUZURI APIはURLを受け付ける）
- **場所**: `worker/fal.js` `upscaleWithFal()` / `worker/index.js` / `worker/bluesky-bot.js`

### 11. fal.ai CDN URLをSUZURIに直接渡すと0バイトエラー（2026-04）

- **原因**: fal.aiが返すCDN URL（`v3b.fal.media`）をSUZURIの`texture`フィールドに直接渡すと、SUZURIのサーバーがfetchした際に0バイトが返りstatus=422エラーになる。CDN URLへのアクセス制限・一時URL等が原因と推測
- **修正**: fal.ai CDN URL → Worker内でfetch → R2にバイナリ保存（I/Oのみ・CPU不要）→ `GET /hires/:id`エンドポイント経由のWorker自身のURLをSUZURIに渡す。Worker URLはSUZURIから安定してアクセスできる
- **教訓**: 外部CDN URLを第三者APIの`texture`等に直接渡す設計は、アクセス制限・TTL・リダイレクト等で失敗するリスクがある。自分で管理するURL（R2経由）に変換してから渡す
- **場所**: `worker/index.js` `/suzuri-create`ハンドラ / `GET /hires/:id`エンドポイント

### 12. AuraSR 4xがSUZURI 20MB上限を常に超過し実質アップスケールなしに（2026-04）

- **原因**: AuraSR 4xは1024px入力→4096px PNG≈24MBとなりSUZURIの20MB上限を超過。`upscaling_factor: 2`パラメータは**完全に無視**され、常に4x出力になる
- **修正**: `fal-ai/aura-sr` → `fal-ai/esrgan`に切り替え（`worker/fal.js` `FAL_QUEUE_BASE`）。ESRGANは2x（2048px/≈6MB）でSUZURI上限内に収まる
- **モデル比較実測**（400px JPEG入力で計測）:

| モデル | 出力 | 1024px推定 | 速度 |
| --- | --- | --- | --- |
| AuraSR 4x | 1600px | ~24 MB ❌ | 3.2秒 |
| ESRGAN 2x | 800px | **~6 MB ✅** | 3.2秒 |
| Clarity 2x | 800px | ~6 MB ✅ | 9.6秒（遅い） |

- **教訓**: アップスケールの目的は「印刷品質の向上」であり倍率の厳密さではない。SUZURI上限（20MB）を超えるモデルは結局フォールバックになり効果なし。切り替え前にサイズを実測すること
- **場所**: `worker/fal.js` `FAL_QUEUE_BASE`

### 13. fal.ai運用イベントのDiscord通知（2026-04）

- **対応内容**: fal.ai関連の以下イベントでDiscordに通知するよう追加
  - 403エラー（残高不足の可能性）→ チャージURLを含む警告通知
  - ジョブFAILED → requestIdを含む通知
  - ポーリング3回未完了→base64フォールバック → requestIdを含む警告
  - 出力20MB超→base64フォールバック → byteLengthを含む警告
- **実装**: `worker/fal.js`に`notifyFalDiscord()`ヘルパーを追加。`worker/index.js`では`bluesky-bot.js`の`notifyDiscord()`をimportして使用
- **制約**: fal.aiのクレジット残高を事前取得するREST APIエンドポイントが非公開のため、残高が0になった時点（403）でのみ通知。事前通知（$0.5以下等）はfal.aiダッシュボードのメール通知で補完する
- **場所**: `worker/fal.js` `notifyFalDiscord()` / `worker/index.js` ctx.waitUntil()ブロック・`/resume-hires`

---

## 将来の拡張に関する設計方針メモ

### ユーザーによる記念日の自由入力（未実装・保留中）

現状は事前に用意された候補から選ぶ形のみ。自由入力を実装しない理由はCLAUDE.mdの「変えてはいけない設計判断」を参照。

将来検討する場合の前提条件:

1. このサービス専用のGoogleアカウントを作成し、そちらにGemini APIキーを移す（メインアカウントとリスク分離）
2. その上でサーバーサイドでの入力フィルタリング・文字数制限等を実装する

### SUZURIグッズ連携（未実装・実装予定）

#### 市場調査結果（2026-03時点）

- 売れ筋カテゴリ: Tシャツ（圧倒的首位）、ステッカー、スマホケース、缶バッジ、アクリルキーホルダー
- 売れるデザイン傾向: 猫・動物系が最強、ゆるかわ・シンプル、色数3色以内のワンポイント配置
- AI生成画像はSUZURI公式が容認スタンス（商用利用可のサービス使用が条件）
- 「水彩画風」は汎用的なスタイル指定であり著作権上問題なし

#### 想定するユーザーフロー

```text
Bluesky投稿（Bot）
  └→ リンクをクリック
      └→ Webページ（Web用画像を表示）
          ├→ 再作成ボタン
          ├→ 共有するボタン
          └→ グッズを買うボタン
              └→ 商品選択（ステッカー / 缶バッジ / アクリルキーホルダー / Tシャツ）
                  └→ 透過処理オプション（ステッカー・バッジ等で有効）
                      └→ SUZURIへ遷移
```

既存サイト（生成ボタン押下時）も同様に3種類の画像を生成してストレージに格納する。

#### 画像3種類の仕様

| 用途 | 仕様 | 備考 |
| --- | --- | --- |
| Bluesky用 | 現行のまま（1MB以内） | 実装済み |
| Web表示用 | 現行のまま | 変更不要 |
| グッズ用高画質 | SUZURI推奨3000×3000px以上 | Geminiの出力解像度確認が必要 |

#### ストレージ設計

- **Cloudflare R2**を使用（KVはバイナリ保存に不向き）
- 保持期間: **14日間**
- クリーンアップ: Cron Trigger起動時に14日以上前の画像を削除
- 期限切れアクセス時: 「この記念日画像は期限が切れました」＋再作成ボタンを表示

#### SUZURI API連携

SUZURIアカウントがあれば即時利用可能（招待制ではない）。

- Developer Center（`https://suzuri.jp/developer`）にログイン状態でアクセスしAPIキーを取得する
- 認証: `Authorization: Bearer <APIキー>`ヘッダー
- レートリミット: レスポンスヘッダー `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` で確認可能

```text
画像生成完了
  └→ POST /api/v1/materials（SUZURIに商品を動的生成）
      └→ レスポンスのproducts[].sampleUrlを「グッズを買う」ボタンのリンクに使う
```

**POST /api/v1/materials リクエスト仕様:**

```json
{
  "texture": "https://example.com/image.png",
  "title": "タイトル（任意）",
  "products": [
    {
      "itemId": 1,
      "price": 594,
      "published": true
    }
  ]
}
```

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `texture` | string | 必須 | 画像のURLまたはbase64データURI（どちらも可） |
| `title` | string | 任意 | マテリアルのタイトル |
| `products[].itemId` | integer | 必須 | アイテム種別ID（`GET /api/v1/items`で確認） |
| `products[].price` | integer | 任意 | トリブン（クリエイター利益額）。0〜5000の範囲。商品ごとに個別設定 |
| `products[].published` | boolean | 任意 | `true`=公開、`false`=非公開 |

**POST /api/v1/materials レスポンス仕様（重要フィールド）:**

| フィールド | 説明 |
| --- | --- |
| `material.id` | 作成されたマテリアルID（DELETE時に使用） |
| `products[].sampleUrl` | SUZURIの商品詳細ページURL（「グッズを買う」ボタンのリンク先） |
| `products[].sampleImageUrl` | グッズのプレビュー画像URL（WebP形式） |
| `products[].pngSampleImageUrl` | グッズのプレビュー画像URL（PNG形式） |
| `products[].item.id` | アイテム種別ID |
| `products[].item.humanizeName` | アイテム名（日本語、例: `"スタンダードTシャツ"`） |

**アイテムID一覧（2026-03確認済み）:**

| itemId | name（英語スラッグ） | 商品名 |
| --- | --- | --- |
| 1 | `t-shirt` | スタンダードTシャツ |
| 11 | `sticker` | ステッカー |
| 17 | `can-badge` | 缶バッジ |
| 147 | `acrylic-keychain` | アクリルキーホルダー |

注意: APIの`name`フィールドは英語スラッグ（`"t-shirt"`等）を返す。日本語名ではフィルタリングできない。全件は`GET /api/v1/items`または`scripts/test-suzuri-api.mjs`（Step 1）で確認できる。

**マテリアル削除:**

```
DELETE /api/v1/materials/{material_id}
```

テスト後の商品削除や、7日経過したマテリアルのクリーンアップに使用する。

#### SUZURIショップ設定（完了済み・2026-03）

- **ショップ名**: にゃんむす / **アカウント**: nyanmusu
- **Webサイト**: `https://hiroshikuze.github.io/anniversary-cat-worker/`
- 表示項目: グッズのみON（デジタルコンテンツ・コミッション・デザイン等はOFF）
- トリブン: ベース価格の30%（`worker/suzuri.js` `SUZURI_TORIBUN`で定義）

| 商品 | ベース価格 | トリブン（30%） | 販売価格 |
| --- | --- | --- | --- |
| スタンダードTシャツ | 1,980円 | 594円 | 2,574円 |
| ステッカー | 385円 | 115円 | 500円 |
| 缶バッジ | 385円 | 115円 | 500円 |
| アクリルキーホルダー | 495円 | 148円 | 643円 |

ベース価格はSUZURI側の改定で変わる場合がある。変わった場合は`SUZURI_BASE_PRICES`の値を`GET /api/v1/items`の`price`フィールドで更新する。
- 振込先申請（「金にする」ボタン）は実際に売れてから対応

#### 透過処理

背景除去には外部API（remove.bg等）が必要。追加コスト・処理時間が発生するため後回しでよい。Tシャツは透過不要なので商品種別によって制御する。

---

### fal.ai ESRGANアップスケーリング（実装済み・ctx.waitUntil()方式で有効化）

#### 目的

Gemini生成画像（通常1024px前後）をSUZURI印刷に適した解像度に引き上げ、Tシャツ等の印刷品質を改善する。SUZURI推奨3000×3000px以上には届かないが、2048px（2倍）でも元画像比で品質が改善する。

#### 現状ステータス（2026-04）

`worker/fal.js`として実装済み。Queue API方式を採用（`queue.fal.run`）。

#### モデル選定経緯（2026-04）

当初AuraSR（4倍）を採用していたが、1024px入力→4096px PNG≈24MBとなりSUZURIの20MB上限を常に超過し、結果的にbase64フォールバック（元画像）になっていた。ESRGAN（2倍）に切り替えることで1024px→2048px PNG≈6MBとなり安定してSUZURIに高解像度登録できる。

| モデル | 出力 | 1024px入力時サイズ | 速度 | 採否 |
| --- | --- | --- | --- | --- |
| AuraSR（4x） | 4096px PNG | ~24 MB ❌ SUZURI超過 | 3.2秒 | 廃止 |
| AuraSR `upscaling_factor=2` | 4096px PNG（パラメータ無視） | ~24 MB ❌ | 3.2秒 | 廃止 |
| **ESRGAN（2x）** | **2048px PNG** | **~6 MB ✅** | **3.2秒** | **採用** |
| Clarity Upscaler（2x） | 2048px PNG | ~6 MB ✅ | 9.6秒 | 遅いため不採用 |

#### アーキテクチャ（Queue API + ctx.waitUntil()方式）

フロントエンドが2リクエストを並列送信し、ユーザーの待ち時間を最小化する。

```text
【Request A】slugs=["can-badge","acrylic-keychain"]（bottom-center画像・fal.aiなし）
  → Worker が即時SUZURI登録 → 即返答（products含む）
  → r2Id付きで呼び出し → R2 meta.json に products を書き込む

【Request B】slugs=["t-shirt","sticker"]（bottom-right画像・fal.ai挑戦）
  フロント送信前: Canvas imageSmoothingQuality:"high" で 2048px にリサイズ（hiresImageData）
  → { imageData: 1024px, hiresImageData: 2048px bicubic } を送信
  → fal.ai Queue に imageData(1024px) でジョブ投入（<1s）→ request_id を R2 meta.json に保存
  → 即返答（{ queued: true }）← ユーザーを待たせない
  → ctx.waitUntil() バックグラウンド:
      queue ステータスを5秒間隔で最大3回ポーリング（15秒）
      15秒以内に完了 → CDN URL → R2 hires.png → Worker URL → ESRGAN 2048px SUZURI登録
      完了しない → hiresImageData(2048px bicubic) でSUZURI登録（~3秒、計~20秒で完了）
  → R2 meta.json に products をスラッグ単位でマージ

  ※ hiresImageData を fal.ai に投入しない理由: 2048px 入力 → ESRGAN 2x → 4096px PNG ≈ 24MB で
    SUZURI 20MB上限を超過するため。imageData(1024px) を fal.ai 用に維持する。

【フロントエンドのポーリング】
  → Request B の queued:true を受け取ったら polling 開始
  → GET /meta/{r2Id} を5秒間隔で最大12回（60秒）確認
  → products に t-shirt エントリが現れたらボタンを有効化（通常~20秒で完了）
  → 60秒超過かつ meta.falRequestId あり → GET /resume-hires/{r2Id} を呼ぶ（安全網）
```

#### /resume-hires/:id エンドポイント（安全網）

ctx.waitUntil()が途中終了した稀なケース向け。フロントの60秒ポーリングが失敗した後に呼ばれる。

| レスポンス | 意味 |
| --- | --- |
| `{ products: [...] }` | 登録完了（t-shirt既存 or 今回登録成功） |
| `{ stillProcessing: true }` | fal.ai がまだ処理中（CDN TTL内なら後で再試行も可） |
| `{ error: "..." }` | 画像データなし等の致命的エラー |

処理順序: ①t-shirt重複チェック（既存なら即返却）→ ②fal.ai queue結果取得 → ③R2オリジナル画像でbase64フォールバック → ④SUZURI登録

#### ポーリング中のボタン表示

| 状態 | t-shirt / sticker ボタン |
| --- | --- |
| queued中 | 「準備中…」グレーアウト（クリック不可） |
| 登録完了（通常~20秒） | 通常のSUZURI遷移ボタン |
| 60秒タイムアウト→resume完了 | 通常のSUZURI遷移ボタン |
| resume→stillProcessing | 「準備できませんでした」（クリック不可） |

#### productsマージロジック（r2-storage.js）

2グループが別々に meta.json を更新するため、`updateMetaInR2` にスラッグ単位のマージを追加。

```text
既存: [{ slug: "can-badge", ... }, { slug: "acrylic-keychain", ... }]
新規: [{ slug: "t-shirt", ... }, { slug: "sticker", ... }]
→ Map by slug で upsert → 全4件になる
```

`materialId` は最初に書き込んだグループ（Request A）のものを保持。Request B のバックグラウンドタスクは `materialId` を更新しない。

#### GET /meta/:id エンドポイント

ポーリング専用の軽量エンドポイント。`/image/:id` と異なり画像データを含まないため、ポーリングのトラフィックを最小化できる。

```json
{ "theme": "...", "products": [...], "materialId": 123, "createdAt": "..." }
```

#### 技術仕様

| 項目 | 内容 |
| --- | --- |
| 使用モデル | `fal-ai/esrgan`（2倍アップスケール） |
| 出力解像度 | 1024px → 2048px PNG（≈6MB・SUZURI 20MB上限内） |
| レイテンシ | 実測 ~3.2秒（Queue API経由） |
| 入力 | base64 data URI（フロントCanvas合成後のJPEG） |
| API方式 | Queue API（`queue.fal.run`）。submitFalJob()でジョブ投入→getFalResult()で結果取得 |
| 出力 | CDN URL（R2経由でSUZURIに渡す） |
| Cloudflare Workers対応 | Cloudflare AI Gatewayと公式統合済み ✅ |
| 認証 | `Authorization: Key <FAL_KEY>` ヘッダー |
| 料金 | 従量課金（残高不足の場合はstatus=403） |

#### 必要なシークレット

| シークレット名 | 登録先 | 状態 |
| --- | --- | --- |
| `FAL_KEY` | Cloudflare Workers（設定 → 変数とシークレット） | 登録済み |
| `FAL_KEY` | GitHub Actions（Settings → Secrets → Actions） | 登録済み |

取得先: `fal.ai` ダッシュボード → API Keys → Add key

#### 注意事項

- `FAL_KEY`未設定時はアップスケールをスキップして元画像でSUZURI登録する（best-effortで継続）
- CDN URLを直接SUZURIに渡す設計（base64変換はしない）→ Workers CPU時間節約
- 残高不足時はstatus=403「Exhausted balance」エラー → Discordに通知＋`fal.ai/dashboard/billing`でチャージ
- ジョブFAILED時・ポーリング未完了base64フォールバック時・出力20MB超時もDiscordに通知
- fal.aiのクレジット残高をREST APIで事前取得するエンドポイントは非公開のため、0になった時点（403）でのみ通知が届く
- bluesky-bot.jsの`runBot()`ではfal.ai呼び出しは引き続き無効（scheduledハンドラではctx.waitUntil()の効果が限定的）

---

### 共有URL機能（未実装・実装予定）

#### 概要

ユーザーが生成した画像にも`?id=user/{uuid}`付きの共有URLを付与し、そのURLを受け取った人が同じ画像・SUZURIグッズ購入画面を見られるようにする。

#### ボタン仕様（共有URLから遷移した場合）

| ボタン | 動作 | 備考 |
| --- | --- | --- |
| 「✨ 新しく生成」 | `startResearch()`呼び出し | 通常の「🔄 もう一度生成」と差し替え |
| 「共有する」/「保存する」 | 現行のまま | `?id=`付きURLを共有 |
| SUZURIグッズ4ボタン | 現行のまま | `data.products`があれば表示 |
| ~~「グッズを生成」~~ | **非表示** | `data.products`がある場合は重複作成防止のため非表示 |

- `bot/YYYY-MM-DD`（Bluesky経由）と`user/{uuid}`（ユーザー共有）の両方に適用
- `loadSharedImage()`実行時にフラグを立てて出し分け

#### SUZURI重複作成の防止

- 判定基準: R2 meta.jsonの`products`フィールドの有無（SUZURIのAPIは「登録済み確認」エンドポイント非提供）
- `data.products?.length > 0`の場合はグッズ生成ボタンを非表示にする

---

### 14. Pollinationsが常に先着し、Gemini画像が使われない（2026-04）

- **原因1（フィルターバグ）**: `listImageModelCandidates()`のフィルター条件が`name.includes("image-generation") || name.includes("imagen") || name.includes("flash-exp")`だったため、`gemini-2.5-flash-image`（末尾が`-image`）が発見されず「discovery found no image models」警告が毎回発生
- **原因2（Discovery APIオーバーヘッド）**: `tryGemini()`冒頭でモデル一覧APIを呼び出していたため、Gemini生成前に1〜2秒の余計なオーバーヘッドが発生
- **原因3（Pollinations高速）**: Pollinationsの`turbo`モデルが約2秒で完了するため、並列レース（`Promise.any`）では常にPollinationsが先着
- **修正**:
  - `listImageModelCandidates()`を廃止し`KNOWN_IMAGE_CANDIDATES`定数に置き換え（Discovery API呼び出しを撤廃）
  - `Promise.any`並列レースから**2フェーズ方式**に変更（上記「Pollinations.aiフォールバック」セクション参照）
- **実測検証**: `scripts/test-gemini-image-timing.mjs`で3回計測し、12秒ウィンドウの設計根拠を確認してから実装（数値先行実装を避けた）
- **場所**: `worker/index.js` `handleGenerate()` / `KNOWN_IMAGE_CANDIDATES` / `buildPollinationsUrl()`

### 15. Geminiプロンプトの「holding or surrounded」制約がvisualHintと競合（2026-04）

- **原因**: `visualHint`（例: `lotus flower, baby Buddha statue, sweet tea ceremony`）が場面・小道具を既に指定しているにもかかわらず、「The cat is holding or surrounded by items related to the theme.」という空間的制約が残っていた
- **問題**: Geminiが「猫がお釈迦様の像を抱えている」等の不自然な構図に引き寄せられ、visualHintが意図する雰囲気・背景としての使い方ができなかった
- **修正**: 該当文を削除。visualHintによる場面指示に一本化し、Geminiの構図判断を尊重する
- **場所**: `worker/index.js` `handleGenerate()` `prompt`定数

### 16. ボット経由のTシャツが1024px低解像度のままSUZURI登録されていた（2026-04）

- **原因**: `runBot()`が直接`createSuzuriProducts()`を呼んでいたため、ブラウザ側の`resizeForSuzuri()`（2048px bicubic）もfal.ai ESRGAN 2xも適用されていなかった
- **修正**: ボットでのSUZURI登録を廃止。初回訪問者のブラウザで`createSuzuriFromImage()`（手動生成と同じフロー）を実行する設計に変更
- **重複防止**: `/suzuri-create`冒頭にR2メタチェックを追加。対象スラッグが全件登録済みなら既存データを返してスキップ（複数ユーザー同時訪問でも二重登録しない）
- **誰も訪問しない場合**: productsが未作成のままR2が14日で期限切れになる（許容設計）
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `/suzuri-create`ハンドラ / `frontend/index.html` `createSuzuriFromImage()` `loadSharedImage()`

### 未対応バグ・改善項目（次回実装時にまとめて対応）

現在、積み残し項目なし。

---

---

## ボット作品ギャラリー（実装済み・2026-04）

### 概要

直近14日間のボット生成画像をトップページに横スクロールギャラリーで表示する。
SUZURIグッズが登録済みの日のみカードを表示し、購買導線として機能する。

### フロー

```text
ページ読み込み
  → /meta/bot/YYYY-MM-DD × 14日分を並列fetch（JST基準で過去にさかのぼる）
  → products.length > 0 の日 → カード表示（サムネイル + 日付 + テーマ名）
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

ギャラリー閲覧者が複数いる場合でも、`/suzuri-create` 冒頭の重複防止チェック（R2メタ参照）が二重登録を防ぐ。

### R2保存期間との関係

| 保存期間 | 平日最大カード数 | 理由 |
| --- | --- | --- |
| 7日（旧） | 5枚 | 週5日 |
| **14日（現行）** | **10枚** | 週5日 × 2週 |

---

### 将来の改善アイデア（検討中・未実装）

#### Geminiにイラスト用プロンプトを生成させる（imagePrompt方式）

- **背景**: 現状のテンプレート（`The cat is holding or surrounded by items related to the theme`）は構図が単調。「花見」なら桜の下でピクニックシートに座る猫が描けるはずだが、現状はテーマ関連アイテムを持った猫にとどまる
- **アイデア**: `handleResearch()`のJSON出力に`imagePrompt`フィールドを追加し、Geminiにシーン・構図・小道具・雰囲気を英語で描写させる。追加APIコールなしで実現できる
- **設計の注意点**:
  - Geminiが担当する部分: 場面・構図・小道具・雰囲気（テーマ依存）
  - コードが固定する部分: 猫の毛柄・性格・画風（watercolor kawaii・テキスト禁止）。混ぜるとスタイルがブレる
  - Pollinationsフォールバックはプロンプトが長文・日本語に弱いため、短縮形か現行形式を継続する必要あり
- **実装タイミング**: 「猫だけ写ってテーマが全く伝わらない」ケースが継続するようであれば着手する

