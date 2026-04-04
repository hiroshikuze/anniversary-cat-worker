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
│   ├── health-check.js          ← E2E診断スクリプト（GitHub Actionsで自動実行）
│   ├── test-bot.mjs             ← bluesky-bot.jsのユニットテスト（外部API不要）
│   └── test-suzuri-api.mjs      ← SUZURI API動作確認スクリプト
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
  "mimeType": "image/jpeg",
  "theme": "記念日テーマ",
  "r2Id": "user/{uuid}",
  "slugs": ["t-shirt", "sticker"]
}
```

- `slugs`は任意。指定時はそのスラッグのみSUZURI登録する（未指定時は全4商品）。
- `r2Id`は任意。指定時はSUZURI登録完了後にR2の`meta.json`を`materialId`/`products`で更新する。最初の呼び出しにのみ指定する。

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
今日は「{theme}」の日！🐱
{description}

あなたも今日のにゃんバーサリーを作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#AIart #cat #kitten #ほのぼの #猫 #{theme正規化}
```

300 grapheme以内に収まる設計（実測 ~210 grapheme）。

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

画像生成時、GeminiとPollinationsを並列実行（`Promise.any`）し、先に成功した方を返す。

- 使用モデル: `flux` / `turbo` / `flux-realism` / `flux-anime`（4モデル同時並列）
- **プロンプトはASCIIのみ**（日本語等の非ASCII文字はサーバー500エラーの原因になるためフィルタリング済み）
- タイムアウト: 20秒/モデル

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
- 保持期間: **7日間**
- クリーンアップ: Cron Trigger起動時に7日以上前の画像を削除
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

### fal.ai AuraSRアップスケーリング（実装済み・ctx.waitUntil()方式で有効化）

#### 目的

Gemini生成画像（通常1024px前後）をSUZURI推奨解像度（3000×3000px以上）に引き上げ、Tシャツ等の印刷品質を改善する。

#### 現状ステータス（2026-04）

`worker/fal.js`として実装済み。同期ハンドラ内での直接呼び出しはwall-clock制限により常にタイムアウトしていたため、`ctx.waitUntil()`を使った非同期アーキテクチャに移行した。

#### アーキテクチャ（ctx.waitUntil()方式）

フロントエンドが2リクエストを並列送信し、ユーザーの待ち時間を最小化する。

```text
【Request A】slugs=["can-badge","acrylic-keychain"]（bottom-center画像・fal.aiなし）
  → Worker が即時SUZURI登録 → 即返答（products含む）
  → r2Id付きで呼び出し → R2 meta.json に products を書き込む

【Request B】slugs=["t-shirt","sticker"]（bottom-right画像・fal.ai挑戦）
  → Worker が ctx.waitUntil() でバックグラウンド処理を開始
  → 即返答（{ queued: true }）← ユーザーを待たせない
  → バックグラウンド: fal.ai → SUZURI登録 → R2 meta.json に products をスラッグ単位でマージ
  → 失敗時: 元画像でSUZURI登録（ベストエフォートフォールバック）

【フロントエンドのポーリング】
  → Request B の queued:true を受け取ったら polling 開始
  → GET /meta/{r2Id} を5秒間隔で最大12回（60秒）確認
  → products に t-shirt エントリが現れたらボタンを有効化
  → 60秒超過 → ボタンを「準備できませんでした」状態に更新
```

#### ポーリング中のボタン表示

| 状態 | t-shirt / sticker ボタン |
| --- | --- |
| queued中 | 「準備中…」グレーアウト（クリック不可） |
| 登録完了 | 通常のSUZURI遷移ボタン |
| 60秒タイムアウト | 「準備できませんでした」（クリック不可）。フォールバック画像で登録成功の場合も通常ボタンに切り替わる |

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
| 使用モデル | `fal-ai/aura-sr`（4倍アップスケール・GANベース） |
| レイテンシ | 1024px入力 → 約0.25秒（公称）。実測では30秒超のことあり |
| 入力 | base64 data URI（フロントCanvas合成後のJPEG） |
| 出力 | CDN URL（`{ cdnUrl, mimeType }`を返し、SUZURIに直接URL渡し） |
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
- 残高不足時はstatus=403「Exhausted balance」エラー。`fal.ai/dashboard/billing`でチャージ
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

### 未対応バグ・改善項目（次回実装時にまとめて対応）

| 項目 | 詳細 | 場所 |
| --- | --- | --- |
| fal.ai無効化（UX改善） | タイムアウト待ち30秒がかかるようになったため、fal.ai呼び出しを一時コメントアウトして以前の速度に戻す | `worker/index.js` `/suzuri-create`ハンドラ / `worker/bluesky-bot.js` `runBot()` |
