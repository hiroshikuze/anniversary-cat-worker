# 将来拡張メモ

## Cloudflare Workers AI移行調査（2026-05・完了・保留）

### 調査の背景

2026年4月のGemini API費用¥2,609削減を目的に、Cloudflare Workers AIへの移行可否を調査した。

### コストの主因（重要）

月額¥2,609の大部分はテキストトークン費ではなく**Google Search grounding費**と推定される。

```
プール生成Cron: 10並列 × 30日 = 300クエリ/月
ユーザー/research: 推定150クエリ/月
合計: ~450クエリ × $0.035/クエリ = $15.75/月 ≒ ¥2,400
```

残り¥200前後がテキストトークン費（入力~400 tokens + 出力~200 tokens/リクエスト）と画像生成費。

### 月間Gemini呼び出し数（実コード確認済み）

| 呼び出し元 | モデル | 月間回数 | 備考 |
| --- | --- | --- | --- |
| プール生成Cron（`0 15 * * *`）| `gemini-2.5-flash`系（自動選択） | 300回 | 10並列 × 30日 |
| Bot Cron（`0 22 * * 1-5`）| `gemini-2.5-flash-image` | 22回 | 画像生成のみ（プールヒット時はresearch不要） |
| ユーザー`/research` | 同上 | 不定（上限なし） | プールヒット時は呼ばれない |
| ユーザー`/generate` | 同上 | 不定（上限50回/日） | |

### Workers AI代替可否

| 機能 | 代替可否 | 理由 |
| --- | --- | --- |
| `handleResearch()`（テキスト＋検索） | **実質不可** | `google_search: {}`ツールがWorkers AIにない。Llamaで特定日の記念日を生成するとハルシネーションリスクが高い |
| `handleGenerate()`（画像生成） | 技術的には可だが意味なし | FLUXはPollinationsフォールバックとして**すでに実装済み**。Workerに移行しても品質は現在の「Gemini失敗時」と同等 |

### Workers AI画像生成のNeurons試算

```
FLUX.1 Schnell: ~580 neurons/画像

最大利用時: 50回/日 × 580 = 29,000 neurons/日
無料枠: 10,000 neurons/日
課金対象: 19,000 × $0.011/1,000 ≈ $0.21/日 ≈ ¥6,200/月（最大時）
```

最大利用時は現状¥2,609より**高コスト**になるリスクがある。

### 推奨アクション（未実施）

1. **Google AI Studio無料tierへの移行可否を確認する（優先度高）**
   - 現在のエンドポイント`generativelanguage.googleapis.com`はGoogle AI StudioのAPI
   - Free tier制限: 15 RPM・1,500 RPD・Google Search groundingが無料tierで使えるかどうかの確認が必要
   - 無料tierで使えれば¥0になる可能性がある（要Google Cloud Console確認）

2. **Workers AI移行は採算が合わない（不採用）**
   - researchの主コスト（Search grounding）は代替不可
   - 画像生成はPollinationsで無料フォールバック済み
   - 有料Workers AIは最大利用時に現状より高コスト

---

## リファクタリング候補（テスト容易性の改善）

### 判断基準（2026-05 議論で確定）

リファクタリングすべきシグナルは3つに限定する:

1. **テストできない関数が生まれた** → 純粋な計算部分を切り出して`_setXxxForTest`パターンで差し替え可能にする
2. **同じAPIエラーハンドリングが3箇所以上** → 共通ヘルパーに集約する（既存の動作を変えない）
3. **1ファイルが肥大化してCIが遅くなった** → 機能単位で分割する

「3箇所似ているから共通化したい」だけの動機・バグ修正のついでの周辺整理・将来拡張のための抽象化は行わない。

### bot.js の具体的なリファクタリング候補

#### 優先度高: `postToMastodon()` の切り出し（現在は無名IIFEが`Promise.allSettled`内に埋め込まれている）

**現状の問題:**

```js
// runBot() の内部 - 匿名IIFEのため独立テスト不可能
(env.MASTODON_INSTANCE_URL && env.MASTODON_ACCESS_TOKEN)
  ? (async () => {
      if (!env.MASTODON_INSTANCE_URL.startsWith("https://")) {
        throw new Error(`設定エラー...`);
      }
      const mediaId = await uploadMediaToMastodon(...);
      return postStatusToMastodon(...);
    })()
  : Promise.resolve(null),
```

Mastodonに問題が起きたとき（過去に苦戦した経緯）は、https://チェック・uploadMedia・postStatusのどのステップで失敗したかを独立テストで確認できない。`runBot()`全体を通した結合テストでしか検証できない。

**修正案:**

```js
// export して独立テスト可能にする
export async function postToMastodon(env, imageBytes, mimeType, altText, mastoText) {
  if (!env.MASTODON_INSTANCE_URL || !env.MASTODON_ACCESS_TOKEN) return null;
  if (!env.MASTODON_INSTANCE_URL.startsWith("https://")) {
    throw new Error(`設定エラー: MASTODON_INSTANCE_URL が https:// で始まっていません`);
  }
  const mediaId = await uploadMediaToMastodon(env.MASTODON_INSTANCE_URL, env.MASTODON_ACCESS_TOKEN, imageBytes, mimeType, altText);
  return postStatusToMastodon(env.MASTODON_INSTANCE_URL, env.MASTODON_ACCESS_TOKEN, mastoText, mediaId);
}
```

これにより `test-bot.mjs` で `globalThis.fetch` をモックして https://チェック・upload失敗・post失敗を独立してテストできる。

#### 優先度中: `buildBotDiscordMessages()` の切り出し（現在は`runBot()`内20行以上のインライン構築）

**現状の問題:**

`runBot()` の後半に 20行以上の `lines` 配列構築ロジックが埋め込まれており、Discord通知の文言を変えたときに正しく構築されるかを確認するには `runBot()` 全体を流す必要がある。

**修正案:**

```js
// 純粋関数として切り出し → test-bot.mjs で直接呼べる
export function buildBotDiscordMessages({ research, generated, bskyOk, bskyError, mastoOk, mastoSkipped, mastoError, dateStr, text, mastoText }) {
  // lines 構築 → { msg1, msg2 } を返す
}
```

引数はすべてプリミティブか単純なオブジェクトのため、外部APIモックなしにテストできる。

#### 優先度低: `uploadMediaToMastodon` / `postStatusToMastodon` の`_`-prefix export

現在はprivate関数のためpublic APIの`postToMastodon()`切り出し後に合わせて検討する。

### 着手タイミング

次にMastodon関連の修正が発生したタイミングで `postToMastodon()` の切り出しを一緒に行う（バグ修正のついでではなく、Mastodon関連タスクのついで）。`buildBotDiscordMessages()` はDiscord通知の文言変更タスクが来たタイミングで。

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
- 期限切れアクセス時:「この記念日画像は期限が切れました」＋再作成ボタンを表示

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

```text
DELETE /api/v1/materials/{material_id}
```

テスト後の商品削除や、7日経過したマテリアルのクリーンアップに使用する。

#### SUZURIショップ設定（完了済み・2026-03）

- **ショップ名**: にゃんむす / **アカウント**: nyanmusu
- **Webサイト**: `https://hiroshikuze.github.io/anniversary-cat-worker/`
- 表示項目: グッズのみON（デジタルコンテンツ・コミッション・デザイン等はOFF）
- トリブン: ベース価格の30%（`worker/suzuri.js` `SUZURI_TORIBUN`で定義）

| 商品 | ベース価格 | トリブン（30%） | 参考販売価格 | 備考 |
| --- | --- | --- | --- | --- |
| スタンダードTシャツ | 2,200円 | 660円 | 2,860円 | 2026-04-23改定（+220円）。次回APIで要確認 |
| ステッカー | 466円 | 139円 | 605円 | 2026-04確認済み（exemplary: Mホワイト） |
| 缶バッジ | 720円 | 216円 | 936円 | 2026-04確認済み（exemplary: 75mmホワイト） |
| アクリルキーホルダー | 1,009円 | 302円 | 1,311円 | 2026-04確認済み（exemplary: 50x50mmクリア） |

ベース価格はSUZURI側の改定で変わる場合がある。変わった場合は`SUZURI_BASE_PRICES`の値を`GET /api/v1/items`の各商品exemplaryバリアントの`price`フィールドで更新する。

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
| AuraSR `upscaling_factor=2` | 4096px PNG（パラメーター無視） | ~24 MB ❌ | 3.2秒 | 廃止 |
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

2グループが別々にmeta.jsonを更新するため、`updateMetaInR2` にスラッグ単位のマージを追加。

```text
既存: [{ slug: "can-badge", ... }, { slug: "acrylic-keychain", ... }]
新規: [{ slug: "t-shirt", ... }, { slug: "sticker", ... }]
→ Map by slug で upsert → 全4件になる
```

`materialId` は最初に書き込んだグループ（Request A）のものを保持。Request Bのバックグラウンドタスクは `materialId` を更新しない。

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
- bluesky-bot.jsの`runBot()`ではfal.ai呼び出しは引き続き無効（scheduledハンドラーではctx.waitUntil()の効果が限定的）

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

## 未使用だが将来有用な機能

### 1. `products/exemplaryItemVariantId`（Material Create/Update）

「サンプル表示」に使うバリアント（色×サイズの組み合わせ）を指定するパラメーター。
未指定の場合はSUZURI側がデフォルトを選ぶ（TシャツはホワイトSサイズになることが多い）。

```json
{
  "products": [
    {
      "itemId": 1,
      "exemplaryItemVariantId": 151,
      "published": true
    }
  ]
}
```

`itemVariantId`は`GET /api/v1/items`のレスポンスの`variants[].id`で確認できる。
**現状の実装では未指定**。SUZURI側のデフォルトに任せている。

---

### 3. 背面印刷（`products/sub_materials`）

Tシャツの背面に別画像を印刷するオプション。

```json
{
  "products": [
    {
      "itemId": 1,
      "published": true,
      "sub_materials": [
        {
          "texture": "https://example.com/back-image.png",
          "printSide": "back",
          "enabled": true
        }
      ]
    }
  ]
}
```

**活用場面**: Tシャツ背面に記念日テキストや別デザインを入れる場合。
**注意**: 追加画像生成が必要になるため実装コストが高い。現状は不要。

---

### 4. `PUT /api/v1/materials/{material_id}`（Material Update）

マテリアルの情報を更新するエンドポイント。削除せずにタイトル・価格・商品構成を変更できる。

```bash
curl -X PUT /api/v1/materials/$MATERIAL_ID \
  -H "Authorization: Bearer $SUZURI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "新しいタイトル", "price": 200}'
```

**活用場面**: 将来的にトリブン（価格）を動的に変えたい場合や、タイトルを更新したい場合。
**現状**: 価格は`SUZURI_TORIBUN`定数で固定しており更新不要。

---

### 5. `GET /api/v1/products?materialId={id}`（Product List + materialIdフィルター）

特定マテリアルIDに紐づく商品一覧を取得できる。

```bash
curl -n /api/v1/products?materialId=31106
```

**活用場面**: R2メタデータなしに「このマテリアルの商品が存在するか」をSUZURI APIから直接確認できる。
**現状**: 重複チェックはR2メタデータの`products`フィールド有無で判定しているため、このエンドポイントは不要。

---

### 6. `GET /api/v1/products/{product_id}`（Product Info）

個別商品の詳細情報。リスト取得と異なり、**全バリアント（色×サイズ）**の情報が`itemVariants[]`として取得できる。

リスト系エンドポイント（`GET /api/v1/products`等）は`sampleItemVariant`（1件）しか返さないが、このエンドポイントは`itemVariants`（全件）を返す。

**活用場面**: 特定商品のカラー展開・サイズ展開を調べたい場合。現状は不要。

---

### 7. `GET /api/v1/materials`（Material List）

自分のマテリアル一覧（デフォルト20件）を取得。

```bash
curl -n "/api/v1/materials?limit=30&offset=0" \
  -H "Authorization: Bearer $SUZURI_API_KEY"
```

**活用場面**: 過去に登録したマテリアルの棚卸しや、孤立したマテリアルの削除。
`scripts/test-suzuri-api.mjs`に追加すると運用管理が楽になる。

---

### 8. Choice API（キュレーションコレクション）

複数の商品をグループ化して「特集」として公開できる機能。

```bash
# Choiceを作成
POST /api/v1/choices
{
  "title": "にゃんバーサリー 人気グッズまとめ",
  "description": "..."
}

# 商品を追加
POST /api/v1/choices/{choice_id}
{ "productId": 1, "itemVariantId": 1 }
```

**活用場面**: 季節ごと・テーマごとに商品コレクションを作りSUZURIトップに特集として掲載できる。
**現状**: 商品数がまだ少ないため優先度低。売上が増えてから検討。

---

### 9. `GET /api/v1/user`（自分の情報確認）

認証済みユーザー自身の情報を返す。APIキーが正しく機能しているか確認するのに便利。

```bash
curl -n /api/v1/user -H "Authorization: Bearer $SUZURI_API_KEY"
```

**活用場面**: `scripts/test-suzuri-api.mjs`のStep 0として「APIキー疎通確認」に追加できる。

---

### 他プラットフォームへの自動投稿（2026-05 調査・不採用）

#### Instagram

Meta Content Publishing API（Graph API）で画像投稿は技術的に可能。ただし以下の理由でコストが高く不採用とした。

- Facebookページと紐づいたInstagramビジネス/クリエイターアカウントが必須（`@nyanmusu.bsky.social`とは別アカウント）
- Metaデベロッパーアプリ作成＋`instagram_content_publish`スコープのMetaアプリレビュー（数週間〜）が必要
- レート制限: 25件/日（実用上は問題なし）

将来的に専用Instagramアカウントを取得し、アプリ審査を通過した場合に再検討する。

#### mixi2

2024年12月リリースの新プラットフォーム。外部向け自動投稿APIが公開されているか2026年5月時点で未確認（サンドボックスからのfetchがブロックされため公式ドキュメントを直接確認できていない）。APIが公開されれば検討する。

---

### 将来の改善アイデア（検討中・未実装）

#### バックアップCron追加によるBot発火信頼性向上（2026-05・未実装）

Cloudflare WorkersのCronは「ベストエフォート」配信であり、まれに発火しないケースがある（2026-05-21の実例：`0 22 * * 1-5`エントリが当日のCronイベント履歴に存在しなかった。Discord通知が届かず、手動トリガーで復旧）。

##### 課題

- Bot CronとリサーチプールCronが1日1回しか発火しない設計のため、未発火の場合はその日のBluesky投稿が欠ける
- 現在は手動でCloudflareダッシュボードから「Scheduled」送信することで代替できるが、毎回人的対応が必要

##### 提案する解決策（案A: バックアップCron追加）

`wrangler.toml`に`"30 22 * * 1-5"`（7:30 JST）を追加し、`runBot()`の冒頭に冪等チェックを追加する。

```toml
# wrangler.toml
crons = ["0 15 * * *", "0 22 * * 1-5", "30 22 * * 1-5"]
#                                        ^^ 7:30 JST バックアップ（1回目が発火しなかった場合のみ実行）
```

`runBot()`冒頭（`findAvailableR2Id()`の前）に追加:

```js
// 当日の bot/YYYY-MM-DD に投稿済みフラグがあれば二重投稿をスキップ
const existingMeta = await getMetaFromR2(env.IMAGE_BUCKET, `bot/${jstDateISO}`);
if (existingMeta && existingMeta.blueskyPostUri) {
  console.log(`[bot] 本日のBot投稿は完了済み（${jstDateISO}）・スキップ`);
  return;
}
```

二重投稿防止には`blueskyPostUri`フィールドをR2メタに保存することが前提。現状このフィールドが保存されているか`worker/bot.js`の`saveToR2()`呼び出し箇所を確認してから実装する。

**トレードオフ:**

| 項目 | 内容 |
| --- | --- |
| 最大遅延 | 発火失敗時に最大30分遅れて投稿される |
| 二重投稿リスク | `blueskyPostUri`チェックで防止。フィールド未保存の場合は二重投稿になるため要確認 |
| コスト | 追加Cronは月22回発火分のCPU時間（ほぼ無視できる） |
| 実装工数 | `wrangler.toml`1行＋`runBot()`5〜8行＋テスト追加 |

##### 案B: トリプル発火（7:00 + 7:30 + 8:00 JST）

`"30 22 * * 1-5"` + `"0 23 * * 1-5"`（3点発火）。統計的に2回以上ミスする確率は極めて低く（Cloudflare公式は「まれに1回ミス」という水準）、案Bは過剰な可能性がある。

##### 着手条件

- Cron未発火が再発した場合（2回以上の証拠がたまったら優先度を上げる）
- または現行の手動復旧コストが高くなった場合

---

#### 外部記念日データソース調査結果（2026-04・補助的利用の検討）

補助的な記念日情報源として以下の2ソースを調査した。

**重要な注意**: サンドボックス環境からja.wikipedia.orgへのfetchが403でブロックされたため、Wikipedia APIに関する情報はエージェントの学習データ由来であり、公式ドキュメントを直接確認できていない。実装前に公式ドキュメント（`mediawiki.org/wiki/API:Main_page`、`api.wikimedia.org`）で再確認すること。

##### 1. Wikipedia MediaWiki API

| 項目 | 内容 |
| --- | --- |
| ライセンス | CC BY-SA 4.0（クレジット表記・ShareAlike必須） |
| 商用利用 | 可 |
| レート制限 | 500リクエスト/時/IP（非認証）、5,000リクエスト/時（Personal API Token） |
| User-Agent | 必須。未設定または汎用値は403。`NyanversaryBot/1.0 (URL; email)`形式で設定 |

**致命的な問題点:**

- REST v1 `/page/summary/`の`extract`フィールドに記念日セクションは含まれない。Action API（wikitext全文取得）が必要
- wikitextのパースが複雑（`[[リンク]]`・`{{テンプレート}}`の除去、セクション番号変動への対応）
- `onthisday/holidays` APIは日本語版の記念日を構造化データで返さない（英語版専用）
- Cloudflare WorkersはIPが共有のため、500リクエスト/時の枠を他Workerと奪い合うリスク
- 日によって記念日の掲載数が0〜10件以上とばらつく

**補助的活用案**: `sourceUrlKind=none`（検索証拠ゼロ）のエントリをWikipedia日付記事で照合し、記載があればWikipedia URLをsourceUrlとして採用する二次検証に利用できる。ただし実装コストが高く、Geminiのトレーニングデータ自体がWikipediaを含むため循環的な検証になるという限界もある。

##### 2. 内閣府 祝日CSV / @holiday-jp

| 項目 | 内容 |
| --- | --- |
| ライセンス | 政府標準利用規約（CC BY 4.0相当）、出典明記必須 |
| フォーマット | Shift-JIS CSV・15〜25KB・2026〜2027年分収録 |
| Workers対応 | `TextDecoder('shift-jis')`で対応可能 |

**致命的な制限**: 国民の祝日のみ収録。「カレーの日」「大仏の日」のような記念日は一切含まれない。記念日リサーチの補助にはならない。

**有用な用途**:「祝日当日にボットを休止する」「祝日であることをDiscord通知に付記する」等の祝日判定に限定して使える。

**推奨実装**: 内閣府サーバーへの直接アクセス可否が未確認のため、`@holiday-jp/holiday_jp` npmパッケージ（MIT・2050年までのデータをバンドル・約211KB・ネットワーク不要）が安全。

##### 総合結論

`google-search-fallback`率74.3%は外部ソース追加より以下の方法でコスト対効果高く対処できる:

1. 並列生成数を10件→15〜20件に増やす
2. `handleResearch()`プロンプトを強化してGeminiにsourceUrlを付けさせやすくする

外部ソースを追加するとしても、記念日リサーチへの直接的な貢献は限定的。`@holiday-jp`は祝日判定など別用途に、Wikipedia APIは二次検証として、それぞれ限定的に使うのが現実的。

#### ゲストランダム参加機能（実装済み・2026-04）

メインの猫に加えて、`GUEST_ANIMAL_PROBABILITY`（10%）の確率でゲスト動物がもう1匹登場する演出。

- **実装場所**: `worker/index.js` `pickGuestAnimal(mainPersona, rand)`（export済み）
- **戻り値**: `{ appearance: string, personality: string, guardianModifier: string|null }` or `null`
- **感情**: 主人公と同じ感情を共有する（独立抽選しない）
- **Discord通知**: ゲスト登場時に`🐾 ゲスト外見:`・`🐾 ゲスト性格:`の2行を追加
- **No.8子猫の特例**: `guardianModifier`（`"calmly watching over the kitten nearby"`）を主人公の性格に追記し、`handleGenerate()`が`effectivePersonality`として両プロンプトに渡す

##### ゲスト種別とパラメーター（2026-04 実装確定）

| No | ゲスト種別 | 毛柄方針 | 性格方針 |
| --- | --- | --- | --- |
| 1〜6 | 犬・ウサギ・パンダ・ペンギン・豚・鶏 | 種固有の1〜2択（定数化） | 動物固有の1行（その動物らしさ優先） |
| 7 | 似た年齢の猫（兄弟/友人） | 同系・対照・ランダムから確率抽選 | 主人公と独立抽選 |
| 8 | 子猫（主人公が親/師匠） | 主人公と同系優遇 | 好奇心旺盛固定。**主人公側プロンプト変更あり** |

##### 動物ゲスト（No.1〜6）の設計方針（実装済み）

- **毛柄**: 種ごとに代表色・模様を定数化。確定値は「確定事項」セクション参照
- **性格**: 動物固有の1行（`personality`定数）で固定。猫の5タイプはそのまま当てはめない
- **ウサギのみ**: 品種（3種）×毛色（3種）を独立抽選（最大9通り）

##### 猫ゲスト（No.7）似た年齢の猫（実装済み）

毛柄の選び方で関係性のニュアンスが変わる。確率比は `COMPANION_CAT_COAT_WEIGHTS`（同系60・対照30・ランダム10）で定義済み。

| 毛柄の選び方 | 確率 | appearance（実装値） |
| --- | --- | --- |
| 同系 | 60% | `"a companion cat with a matching coat to the main cat, sitting together as close friends"` |
| 対照 | 30% | `"a companion cat with contrasting markings, sharing the scene as a friendly pair"` |
| ランダム | 10% | `"another cat with a distinct coat, joining the scene as a companion"` |

性格（personality）は `COMPANION_CAT_PERSONALITIES`（3種）からランダム選択（`rand`引数経由・テスト可能）:

- `"sitting calmly, sharing the scene with gentle companionship"`
- `"watching curiously with bright eyes, attentive and present"`
- `"relaxed and at ease, a quiet friendly presence"`

##### 子猫ゲスト（No.8）の特殊性（実装済み）

他の動物ゲストと異なり、**主人公側のプロンプトも変更が必要**な唯一のパターン。

- **子猫側**:
  - 毛柄: mainPersonaがある場合は`"a tiny kitten with a matching coat to the main cat"`、nullなら`"a tiny fluffy kitten"`
  - 性格: `"leaning forward with wide curious eyes, captivated by everything"`（`KITTEN_PERSONALITY`定数）
- **主人公側**:
  - `guardianModifier = "calmly watching over the kitten nearby"`（`KITTEN_GUARDIAN_MODIFIER`定数）
  - `handleGenerate()`で`effectivePersonality = "${personality}, ${guardianModifier}"`として追記（上書きではない）

##### 確定事項（2026-04-23）

1. **猫ゲスト（No.7）の毛柄確率比**: 同系60・対照30・ランダム10
2. **子猫（No.8）の主人公プロンプト変更**: 既存の性格プロンプトに保護者修飾を追記（完全上書きしない）
3. **ゲスト全体確率**: `GUEST_ANIMAL_PROBABILITY`定数で定義し、必要に応じて修正可能にする

##### 確定事項（2026-04-27）

1. **CAT_PERSONALITIES に「丸まってうとうと」を追加（weight 7）**
   - desc: `"curled up softly, head gently drooping in a cozy drowsy nap"`
   - 追加後の合計weight: 117（各比率は下記）
   - 見つめる・寄り添う35/117=29.9%、テーマに手を伸ばす30/117=25.6%、好奇心旺盛25/117=21.4%
   - 丸まってうとうと7/117=6.0%、セルフグルーミング7/117=6.0%、ツンデレ3/117=2.6%、おまかせ10/117=8.5%

2. **犬ゲストのバリアント確定**（SNS人気データを基に選定）

   | 犬種 | バリアント | 根拠 |
   | --- | --- | --- |
   | ゴールデンレトリーバー | `"golden retriever"` 1種 | 毛色バリアント不要 |
   | 柴犬 | `"red shiba inu"` / `"black-and-tan shiba inu"` / `"cream shiba inu"` | Instagram日本No.1「まる」は赤柴。クリームはSNS人気上昇中 |
   | フレンチブルドッグ | `"brindle French Bulldog"` / `"pied French Bulldog"` | ブリンドルが人気1位、パイドが2位。Instagram世界ハッシュタグ数1位犬種 |

   - 白柴はソフトバンクお父さん犬（実際は**北海道犬**）との混同注意。クリーム柴として収録
   - 北海道犬は別途追加しない（犬種数過多を避ける）

3. **ウサギゲストのバリアント**（確定・2026-04-27）
   - 品種: ネザーランドドワーフ / ホーランドロップ / ミニレッキスの3種
   - 毛色: 栗色（chestnut）/ クリーム（cream）/ 混合（mixed）の3種
   - 組み合わせ方: 品種と毛色を**独立抽選**（最大9通り）。全組み合わせが実在する毛色のため問題なし
   - プロンプト例: `"chestnut Netherland Dwarf rabbit"` / `"cream Holland Lop rabbit"` / `"mixed Mini Rex rabbit"` など

4. **その他動物ゲストの確定事項**（2026-04-28）

   | 種別 | バリアント（確定） | 性格（固定） |
   | --- | --- | --- |
   | パンダ | `"giant panda cub"` 1種（固定） | `"sitting peacefully nearby, watching the cat with calm gentle eyes, relaxed and unhurried"` |
   | ペンギン | `"emperor penguin chick"` / `"little blue penguin"` 2種 | `"waddling cheerfully with flippers out, sociable and bright-eyed"` |
   | 豚 | `"pink miniature pig"` / `"black and white spotted miniature pig"` 2種 | `"trotting over with snout twitching, cheerful and friendly"` |
   | 鶏（成鳥） | `"fluffy white Silkie chicken"` / `"colorful bantam rooster"` 2種 | `"pecking nearby and tilting head sideways with sharp curious eyes"` |
   | 鶏（ひよこ） | `"tiny fluffy yellow baby chick"` 1種 | `"toddling unsteadily with tiny wings flapping, wide-eyed and curious"` |

   **犬ゲスト（確定・別掲）:**
   - バリアント（6種ランダム）: `"golden retriever"` / `"red shiba inu"` / `"black-and-tan shiba inu"` / `"cream shiba inu"` / `"brindle French Bulldog"` / `"pied French Bulldog"`
   - 性格（固定）: `"friendly and energetic, approaching the cat with enthusiasm"`

   **ウサギゲスト（確定・別掲）:**
   - 品種（3種・独立抽選）: `"Netherland Dwarf rabbit"` / `"Holland Lop rabbit"` / `"Mini Rex rabbit"`
   - 毛色（3種・独立抽選）: `"chestnut"` / `"cream"` / `"mixed"`
   - 性格（固定）: `"hopping close with nose twitching and big curious eyes"`

#### 事前リサーチプール方式（実装済み・2026-04）

ハルシネーション対策として、毎日深夜に翌日（当日）の記念日候補を複数件生成・フィルタリングしてR2に保存し、ボット投稿・ユーザー手動操作の両方でそのプールから選択する方式。

##### 背景・動機

- 現行は「リサーチ → 生成 → 投稿」を1回のCron実行内で完結させるため検証時間ゼロ
- `sourceUrlKind=google-search-fallback`（根拠URLなし）のまま投稿される事例が発生（2026-04-21: 東京スカイツリータウン開業14周年のハルシネーション）
- 複数候補をフィルタリングすることで「全件がハルシネーション」の確率を下げられる
- ユーザーの手動操作時も同じプールを使うため品質向上効果がサービス全体に波及する

##### 確定した設計決定（2026-04-22 実測・議論により確定）

| 項目 | 決定値 | 根拠 |
| --- | --- | --- |
| 生成方式 | **シングル並列方式**（バッチ方式は却下） | バッチはgrounding全候補共通→個別フィルター不能。`scripts/test-gemini-research-batch.mjs`で実証 |
| 並列生成件数 | **10件** | dedup+filter後平均2.4件（7日間実測）。季節補充込み |
| Cron時刻 | **0:00 JST = `0 15 * * *`（UTC）** | 毎日実行。週末ユーザーアクセスにも対応 |
| フィルタリング基準 | **①`none`除外 ②theme重複除去** | ①: Gemini 2.5以降`groundingChunks`が返らず`google-search-fallback`が常態化したため2026-05に緩和。`none`（検索証拠ゼロ）のみ除外。②: 4/20実測で郵政記念日3件・ネモフィラ2件の重複あり |
| `vertexaisearch-skipped`の扱い | **フィルター対象外（保持）** | groundingは存在する。URLが表示できないだけで内容は根拠あり |
| 事前算出フィールド | **theme/description/visualHint/kanjiChar/foodItem/sourceUrl全件** | 現行`handleResearch()`出力構造をそのまま利用 |
| 猫ペルソナ・性格・感情 | **generate時にランダム抽選（変更なし）** | テーマ依存でなく毎回異なる猫を出す設計を維持 |
| 記念日の使い回し | **OK（poolは枯渇しない）** | poolはキューでなくサンプリング母集団。複数ユーザーが同テーマを選んでも問題なし |
| ユーザーの「もう一度」体験 | **同日プール内でランダム選択** | テーマが変わる回数は候補数が上限（許容済み） |
| 最低件数閾値 | **3件未満でSEASONAL_FLOWERS補充** | 日本に花のない月はないため常に最低1件保証 |
| 季節の花選択確率 | **`SEASONAL_FLOWER_SELECT_PROBABILITY = 0.10`（10%）** | 非fallbackエントリが存在する場合のみ適用。fallbackのみの場合は100% |
| プールのR2キー | **`research-pool/YYYY-MM-DD`** | 既存の`bot/`・`user/`と分離。保持期間1〜2日で十分 |
| Discord通知 | **pool生成完了後に件数・filter結果を通知** | 毎日の品質モニタリング |
| コスト | 固定で1日10回のGemini呼び出し（リアルタイムと比べて変動なし） | バッチ実測で試算済み |

##### プロンプト修正が必要な箇所（実装前に適用）

現行の`handleResearch()`プロンプトに2箇所の修正が必要。

**①速報ニュース・災害の除外**（現行Botにも同リスクあり）:

```js
// 現在
`日本の記念日・季節の花・重要なイベントを調べ`

// 修正後
`日本の記念日・季節の行事・季節の花を調べ（速報ニュース・災害・事故・訃報は除く）`
```

**②descriptionへの日付文字列混入を防止**:

```js
// 修正後（descriptionフィールドの指示に追記）
`"description":"50文字以内の説明（日付・曜日は含めない）"`
```

**注意**: ①の修正はプール方式に限らず現行Botにも即時適用すべき。過去に三陸沖地震（実在の速報）がGemini候補に入り込んだことを確認済み（`google-search-fallback`フィルターでは除外できない）。

##### SEASONAL_FLOWERS 定数（最低件数保証・確定版）

フィルタリング後に3件未満になった場合の補充用。半月単位の日付範囲で定義。
月単位より粒度が細かいため、季節感がより正確に反映される。
苔（6月下旬）・銀杏（12月上旬）は京都の季節感に基づく。

```js
// [MM-DD, MM-DD] の範囲で当日がどの区間か判定して flower_name を返す
const SEASONAL_FLOWERS = [
  { startMd: "01-01", endMd: "01-15", name: "寒椿" },
  { startMd: "01-16", endMd: "01-31", name: "水仙" },
  { startMd: "02-01", endMd: "02-14", name: "蝋梅" },
  { startMd: "02-15", endMd: "02-28", name: "梅" },
  { startMd: "03-01", endMd: "03-15", name: "菜の花" },
  { startMd: "03-16", endMd: "03-31", name: "彼岸桜" },
  { startMd: "04-01", endMd: "04-15", name: "染井吉野" },
  { startMd: "04-16", endMd: "04-30", name: "藤" },
  { startMd: "05-01", endMd: "05-15", name: "杜若" },
  { startMd: "05-16", endMd: "05-31", name: "皐月" },
  { startMd: "06-01", endMd: "06-15", name: "紫陽花" },
  { startMd: "06-16", endMd: "06-30", name: "苔" },       // 西芳寺（苔寺）が見頃
  { startMd: "07-01", endMd: "07-15", name: "蓮" },
  { startMd: "07-16", endMd: "07-31", name: "桔梗" },
  { startMd: "08-01", endMd: "08-15", name: "向日葵" },
  { startMd: "08-16", endMd: "08-31", name: "百日紅" },
  { startMd: "09-01", endMd: "09-15", name: "萩" },
  { startMd: "09-16", endMd: "09-30", name: "彼岸花" },
  { startMd: "10-01", endMd: "10-15", name: "秋桜" },
  { startMd: "10-16", endMd: "10-31", name: "金木犀" },
  { startMd: "11-01", endMd: "11-15", name: "菊" },
  { startMd: "11-16", endMd: "11-30", name: "紅葉" },
  { startMd: "12-01", endMd: "12-15", name: "銀杏" },     // 京都では12月上旬まで見頃
  { startMd: "12-16", endMd: "12-31", name: "千両" },
];

// 当日の MM-DD を取得して該当エントリを返す
function getSeasonalFlower(dateStr) {
  const md = dateStr.slice(5); // "YYYY-MM-DD" → "MM-DD"
  return SEASONAL_FLOWERS.find(e => md >= e.startMd && md <= e.endMd)?.name ?? "梅";
}
```

日本に花のない期間はないため、常に最低1件の補充が保証される。AIの誤動作なし・追加APIコストなし・完全決定論的。

##### 実測データ（`scripts/test-gemini-research-batch.mjs` / 2026-04-22）

方式選定時のバッチ比較:

| 方式 | 件数 | 所要時間 | sourceUrlKind | 特記事項 |
| --- | --- | --- | --- | --- |
| シングル直列 | 5件 | 83,946ms | skipped×4・fallback×1 | 重複多（郵政3件・ネモフィラ2件） |
| シングル並列（推定） | 10件 | **〜17,000ms** | 個別判定可能 | dedup後4〜6件見込み |
| バッチ | 10件 | 34,879ms | skipped（全件共通） | 個別フィルター不能→**却下** |

##### 7日間シミュレーション結果（`scripts/test-pool-30days.mjs` / 2026-04-22）

`GEMINI_API_KEY=xxx node scripts/test-pool-30days.mjs --days 7`を実行し、本実装のフィルタリングロジックを実際のAPIで検証した。

| 指標 | 値 |
| --- | --- |
| テスト日数 | 7日 |
| 合計生成 | 70件（10件/日 × 7日） |
| fallback除外率（旧基準・google-search-fallback） | **74.3%** ※旧フィルターでの実測（2026-04） |
| 重複除去率 | 3.3% |
| **平均プール件数/日** | **2.4件**（季節補充込み・旧フィルター時） |
| 季節補充発動 | **5/7日（71.4%）**（旧フィルター時） |
| ハルシネーション検出 | **0件**（フィルター後残存テーマに不正な候補なし） |

**考察（2026-05フィルター緩和後）:**

- Gemini 2.5以降`groundingChunks`が返らず`webSearchQueries`のみ返るようになり、全件が`google-search-fallback`に分類されて季節補充が毎日発動した（2026-05確認）
- フィルターを`none`（検索証拠ゼロ）のみ除外に緩和したことで季節補充が解消し、実記念日テーマがプールに残るようになった
- `google-search-fallback`（`webSearchQueries`あり）はGeminiが検索した証拠があるため信頼できる。Gemini 2.5ではこの形式が標準になった模様
- `vertexaisearch-skipped`はgroundingが存在するため引き続き保持

**既知の制限事項:**

- **ソフト重複**:「花桃」と「花桃の季節」のような意味的重複はtheme文字列の完全一致では除去できない。exact-match deduplicationのみ実装。実運用上の影響は軽微として受容

##### pickFromPool（季節の花選択確率制御）

プールから1件を選ぶ関数。非fallbackエントリが存在する場合は季節の花（`isSeasonalFallback: true`）が選ばれる確率を `SEASONAL_FLOWER_SELECT_PROBABILITY`（10%）に抑える。

```js
export const SEASONAL_FLOWER_SELECT_PROBABILITY = 0.10;

export function pickFromPool(pool, rand = Math.random) {
  const entries  = pool.entries ?? [];
  const normal   = entries.filter(e => !e.isSeasonalFallback);
  const fallback = entries.filter(e => e.isSeasonalFallback);

  // 非fallbackなし → 全エントリからランダム
  if (normal.length === 0) {
    return entries[Math.floor(rand() * entries.length)] ?? null;
  }

  // 非fallbackあり → 10%確率でfallbackから選択、90%で通常から選択
  if (fallback.length > 0 && rand() < SEASONAL_FLOWER_SELECT_PROBABILITY) {
    return fallback[Math.floor(rand() * fallback.length)];
  }
  return normal[Math.floor(rand() * normal.length)];
}
```

補充エントリには `isSeasonalFallback: true` フラグを付与する（`generateResearchPool()` の補充ブロック）。

##### 処理フロー（確定版・実装済み）

```text
0:00 JST Cron（`0 15 * * *` UTC・毎日）:
  → generateResearchPool()
  → handleResearch() × 10件を並列実行（当日のJST日付で）
  → フィルタリング: none除外 → theme重複除去
  → 3件未満の場合: SEASONAL_FLOWERS[当日区間]から補充（isSeasonalFallback: true を付与）
  → R2に research-pool/YYYY-MM-DD.json として保存
  → Discord通知（件数・除外数・補充有無）

当日 ユーザー操作:
  POST /research → pickFromPool(pool) で1件選択（季節の花10%確率）
  （プール未存在またはエントリなし: 現行リアルタイムGeminiリサーチにフォールバック）

当日 19:00 Bot（月〜金）:
  → pickFromPool(pool) で1件選択（季節の花10%確率）→ handleGenerate() → Bluesky投稿
  （プール未存在: 現行フローにフォールバック）
```

**実装箇所:**

- `generateResearchPool(env)`: `worker/index.js` L207〜（補充エントリに`isSeasonalFallback: true`追加）
- `SEASONAL_FLOWER_SELECT_PROBABILITY`: `worker/index.js`（export済み・定数）
- `pickFromPool(pool, rand)`: `worker/index.js`（export済み・`test-bot.mjs`でテスト）
- `filterAndDedupePool(entries)`: `worker/index.js`（export済み・`test-bot.mjs`でテスト）
- `getSeasonalFlower(dateStr)`: `worker/index.js`（export済み・`test-bot.mjs`でテスト）
- `scheduled()`のcron分岐: `event.cron === "0 15 * * *"` → `generateResearchPool(env)` を `ctx.waitUntil()`
- `/research`エンドポイント: R2プール優先 → `pickFromPool()` → フォールバックの2段構え
- `runBot()`: R2プール優先 → `pickFromPool()` → フォールバックの2段構え
- R2キー: `research-pool/YYYY-MM-DD.json`（`bot/`・`user/`と分離）

---

#### 記念日先回り実施機能（未着手・2026-04）

12/24（クリスマスイブ）など需要が高い記念日のグッズを、当日のBotより前に生成・登録しておく機能。

- **対象候補**: 12/24（クリスマスイブ）・1/1（元日）・2/14（バレンタイン）・3/14（ホワイトデー）・10/31（ハロウィン）など
- **実装方針案**:
  - 対象日リストをコードに定数として持ち、Cron起動時に「N日後が対象日か」を判定して先行生成する
  - または別Cron（例: 毎週月曜）で向こう7日以内に対象日があれば生成する
- **検討事項**: 先行生成したグッズと当日Botが生成するグッズが別々に登録されないよう、R2メタの重複防止チェックとの整合性を確認する
- **実装タイミング**: 初回は12/24の数週間前（11月中旬頃）に着手する

#### Geminiにイラスト用プロンプトを生成させる（imagePrompt方式）

- **背景**: 現状のテンプレート（`The cat is holding or surrounded by items related to the theme`）は構図が単調。「花見」なら桜の下でピクニックシートに座る猫が描けるはずだが、現状はテーマ関連アイテムを持った猫にとどまる
- **アイデア**: `handleResearch()`のJSON出力に`imagePrompt`フィールドを追加し、Geminiにシーン・構図・小道具・雰囲気を英語で描写させる。追加APIコールなしで実現できる
- **設計の注意点**:
  - Geminiが担当する部分: 場面・構図・小道具・雰囲気（テーマ依存）
  - コードが固定する部分: 猫の毛柄・性格・画風（watercolor kawaii・テキスト禁止）。混ぜるとスタイルがブレる
  - Pollinationsフォールバックはプロンプトが長文・日本語に弱いため、短縮形か現行形式を継続する必要あり
- **実装タイミング**:「猫だけ写ってテーマがまったく伝わらない」ケースが継続するようであれば着手する

#### 3Dフィギュア化ワークフロー（検討中・未着手・2026-04）

猫画像をフィギュアとして製造・販売するワークフローの追加を検討中。Webhook+通知で非同期処理を案内するUX設計を前提とする。

##### 提案サービスと実態

| 当初案 | 実態・問題点 | 推奨代替 |
| --- | --- | --- |
| nanobanana（多視点生成） | 独立サービスではなくGemini 3.1 Flash Imageの別称。多視点生成はプロンプト指示で可能だが、3D再構成に十分な精度かは要実測 | Gemini直接（既存統合を流用） |
| Threedium（3Dモデリング） | ECサイト向け3Dビューアー特化。製造用STL出力には非対応 | **Meshy API**（Image→3D・STL出力対応・$10/月〜）または**Tripo3D API**（$12/月〜） |
| DMM.make API（製造・販売） | クリエイターAPIが公開済み。STL/OBJアップロード→価格設定→マーケット出品まで自動化可能 | そのまま採用（ただし事前審査あり） |

##### 想定パイプライン（アーキテクチャ）

```text
ユーザー「3Dフィギュア化」ボタン押下
  → POST /3d-start
      ① Geminiで前・後ろ・左・右の4視点画像を生成（4並列）
      ② Meshy APIにImage-to-3Dジョブ投入 → task_id取得（<1秒）
      ③ R2メタに task_id を保存
      → 即返答 { queued: true }

  ctx.waitUntil() バックグラウンド（またはMeshyのWebhook受信）:
      ④ Meshyポーリング（通常5〜20分）
      ⑤ STLをR2に保存
      ⑥ DMM.make クリエイターAPIにSTLをアップロード → 商品登録
      ⑦ R2メタに dmmUrl を書き込む
      ⑧ Discordに完了通知

フロント: GET /meta/:id を定期ポーリング（30秒間隔・最大20分）
  → dmmUrl が現れたら「フィギュアを注文する」ボタンを有効化
```

既存のfal.ai Queue API方式（ctx.waitUntil + R2 + ポーリング）と同じパターンで実装できる。

##### 着手前の確認事項（要実機検証）

| 確認事項 | 重要度 | 対処 |
| --- | --- | --- |
| DMM.make クリエイターAPI審査の通過 | 高 | 先行して審査申請（数日〜数週間かかる可能性） |
| Meshy Image-to-3Dの出力品質（水彩猫イラスト入力） | 高 | Meshyの無料トライアルで手動テスト |
| Gemini多視点画像がMeshyの精度要件を満たすか | 中 | 実測で確認 |
| Meshy処理時間の実測（設計値の根拠） | 中 | `scripts/test-meshy-timing.mjs`を作成して計測してから実装 |
| DMM.makeの販売手数料・最低品質基準 | 中 | 問い合わせ要 |
| フィギュア製造コスト（ユーザー負担）の明示 | 低 | UIで素材別価格を表示（ポリプロピレン63円〜/cm³） |

##### 実装タイミング

DMM.make審査通過後、かつMeshyの品質が許容水準であることを実測で確認してから着手する。
「計測→設計→実装」の順序を守り、Meshy処理時間の実測なしに非同期設計値（ポーリング間隔等）を決めない（2026-04の教訓）。

#### 食べ物テーマでの eating action（実装済み・2026-04）

食べ物・飲み物に関する記念日の場合、ランダムで猫が食べるアクションをプロンプトに追加する。

##### 設計方針

- `/research`のJSON出力に `"foodItem"` フィールドを追加（Geminiが英語で判定）
  - 指示:「主な行為・目的が食べることである場合のみASCII英語で1〜3語。農業・収穫・行事の象徴のみの場合はnull」
  - Gemini AI Studioでの事前検証で勤労感謝の日（収穫祭）の誤検出を確認→指示を強化して解消
- フロントエンドが `foodItem` を `/generate` に渡す（`visualHint` と同じ経路）
- `handleGenerate()` で `pickEatingAction(foodItem)` を呼び出し
  - `EATING_ACTION_PROBABILITY = 0.30`（30%）の確率でeating actionを選択
  - null / 空文字 / 全角文字を含む場合は必ずnullを返す（2重チェック）
  - Geminiプロンプトに `Cat action: {eatingAction}.` として追加
  - Pollinationsプロンプトの `parts` に `eatingAction` を追加（emotion直後）
- Discord通知に `🍴 食べ物アクション:` 行を追加

##### eating action 定数

```js
const EATING_ACTION_PROBABILITY = 0.30;

const CAT_EATING_ACTIONS = [
  (food) => `holding a tiny ${food} with both paws, taking a delighted bite`,
  (food) => `nibbling on ${food}, eyes half-closed in bliss`,
  (food) => `licking ${food} with tongue out, whiskers twitching happily`,
  (food) => `sniffing ${food} curiously, nose twitching with interest`,
];
```

##### foodItem の検証結果（2026-04 Gemini AI Studioで手動確認）

| テーマ | foodItem | 評価 |
| --- | --- | --- |
| カレーの日 | `"Curry Rice"` | ✅ 正解 |
| バレンタインデー | `"Chocolate"` | ✅ 許容範囲 |
| 節分 | `"Ehomaki"` | ✅ 正解 |
| 半夏生 | `"Octopus"` | ✅ 正解 |
| 建国記念の日 | `null` | ✅ 正解 |
| 勤労感謝の日（指示強化前） | `"Rice"` | ⚠️ 誤検出 |
| 勤労感謝の日（指示強化後） | `null` | ✅ 解消 |
| 外食の日 | `"Restaurant Meal"` | △ 抽象的だが許容範囲（ガードなし） |

##### emotionとの両立

eating actionは「ポーズ・動作」、emotionは「表情・気持ち」のため基本的に両立する。「真剣な表情でカレーをほおばっている」「驚きながら食べている」なども自然な組み合わせ。

---

#### 漢字一字の背面印刷（実装済み・2026-04）

記念日テーマを象徴する漢字一字をGeminiに選ばせ、SUZURIのTシャツ背面に大きく印刷する機能。

##### kanjiChar設計方針

- `/research`のJSON出力に `"kanjiChar"` フィールドを追加（Geminiが常用漢字で回答）
  - 指示:「テーマの核心・象徴を表す常用漢字1文字。ひらがな・カタカナ・数字・記号は不可。適切な漢字がない場合はnull」
  - 事前検証結果（Gemini AI Studio高速モード）:

| テーマ | kanjiChar | 評価 |
| --- | --- | --- |
| 大仏の日 | `"尊"` | ◎ 「仏」より崇敬の本質を捉えた |
| カレーの日 | `"香"` | ◎ 「辛」より香りの側面を重視 |
| 世界ペンギンの日 | `"燕"` | ○ ペンギン専用漢字がないため渡り鳥で代替 |
| バレンタインデー | `"恋"` | ◎ 異論なし |
| 勤労感謝の日 | `"労"` | △ シンプルすぎてデザインが弱い可能性 |

- フロントエンドが `kanjiChar` を `/generate` へ渡す（`visualHint`・`foodItem`と同じ経路）
- Workerは `normalizeKanjiChar(raw)` でバリデーション後、フロントに返却
- `kanjiChar`がnullまたは無効値の場合は`"🐾"`を使用（肉球フォールバック。offscreen Canvas + source-atopで `#aaaaaa` グレー化）
- SUZURIのTシャツのみに `sub_materials`（背面印刷）として適用。ステッカー・缶バッジ・アクキーには適用しない

##### normalizeKanjiChar（worker/index.js からexport）

```js
// CJK統合漢字（U+4E00-U+9FFF）・拡張A（U+3400-U+4DBF）・互換（U+F900-U+FAFF）のみ許可
export function normalizeKanjiChar(raw) {
  if (!raw || typeof raw !== "string") return "😺";
  const c = raw.trim();
  if (c.length === 1 && /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(c)) return c;
  return "😺";
}
```

##### Canvasによる漢字テクスチャ生成（frontend/index.html）

```js
// generateKanjiTexture(char) → base64 JPEG
// ローカルフォント優先（ネットワーク読み込み不要）
const KANJI_FONT_STACK = '"Hiragino Mincho ProN", "Yu Mincho", "游明朝", "Noto Serif CJK JP", serif';
```

| 項目 | 値 |
| --- | --- |
| Canvasサイズ | 2000×2000px |
| フォント | 明朝体ローカルフォント（iOS: Hiragino Mincho、Windows: Yu Mincho、fallback: serif） |
| フォントウェイト | 900（最太） |
| フォントサイズ | Canvasに収まる最大サイズ（余白5%） |
| 文字色 | `#aaaaaa`（薄いグレー。漢字・🐾共通） |
| 背景 | 白（`#ffffff`） |
| 出力形式 | JPEG（quality 0.92）→ base64 data URI |
| 🐾フォールバック | `kanjiChar`がnullの場合。offscreen Canvas に描画→ source-atop で `#aaaaaa` グレー化 |

##### SUZURI sub_materials 仕様（t-shirtのみ）

```json
{
  "products": [
    {
      "itemId": 1,
      "published": true,
      "sub_materials": [
        {
          "texture": "<base64 data URI or URL>",
          "printSide": "back",
          "enabled": true
        }
      ]
    }
  ]
}
```

詳細は`.claude/rules/suzuri-api-reference.md`の「3. 背面印刷」を参照。

---

## かなモード（ふりがな表示）設計メモ（2026-05・実装待ち）

### 概要

子供・日本語学習者向けに JP / **かな** / EN の3言語モードを追加する。
「かな」モードでは日本語テキストに`<ruby>`タグでふりがなを付ける。

### 確定した設計判断

#### 言語トグルUI

- 現在: `JP | EN`（`toggleLang()`で2値切り替え）
- 変更後: `JP | かな | EN`（`setLang(lang)`で各スパンを独立クリック）
- URLパラメーター: `?lang=kana`を追加（既存の`?lang=en`と同じ方式）

#### ふりがなデータの取得元（2種類）

| 対象 | 方法 |
| --- | --- |
| UIテキスト（ボタン・ラベル等） | kuroshiroで一括生成済み（`translations.kana`に格納予定） |
| 動的コンテンツ（theme・description） | `handleResearch()`でGeminiに`themeKana`/`descriptionKana`（ruby HTML）を追加生成させR2に保存 |

- `themeKana`/`descriptionKana`は`themeEn`/`descriptionEn`と同じパターンで実装する
- 既存R2データ（`themeKana`なし）ではかなモードで`theme`（日本語）にフォールバック

#### translations.kana 生成状況

`scripts/generate-kana-translations.mjs`（kuroshiro使用）で全43キーの変換済みruby HTMLを生成・目視確認済み。

修正確定事項:

- `saleBanner`の`火`→`<ruby>火<rt>かようび</rt></ruby>`（曜日略語のため「かようび」と読む）
- `saleBanner`はセール期間変更のたびにClaudeCodeに相談して`ja`/`kana`両方を更新する

#### applyLang() の innerHTML 対応

かなモードのキーのみ`innerHTML`で設定し、ja/enは従来通り`textContent`を維持する。

```js
if (currentLang === "kana" || key === "footer") {
  el.innerHTML = val;
} else {
  el.textContent = val;
}
```

#### SUZURIセクションの扱い

**かなモード・ENモード両方でSUZURIセクションを表示する**（非表示にしない）。
「わからないだろうからカット」はユーザーへの失礼にあたる。リンク先が日本語のみであることを注釈で明示し、判断はユーザーに委ねる。

| モード | 注釈テキスト |
| --- | --- |
| かな | `<ruby>リンク先<rt>りんくさき</rt></ruby>はにほんごのみです` |
| EN | `Note: The SUZURI shop is available in Japanese only.` |

実装方法: `translations`に`goodsJaOnly`キーを追加し、`showGoods()`内でグッズラベルの下に表示する。

#### Umami計測

- `?lang=kana` URLにより自動で別ページとして集計される（追加実装不要）
- `setLang()`に`umami?.track("lang-switch", { lang })`を1行追加して言語切り替えをカスタムイベント計測する

### 実装待ちの作業（優先順・Docs → Tests → Code）

1. ドキュメント更新: `CLAUDE.md`のフロントエンド機能一覧にかなモードを追記、`architecture.md`のフロントエンド機能概要を更新
2. テスト: `handleResearch()`が`themeKana`/`descriptionKana`を返すことを`test-bot.mjs`で確認
3. `handleResearch()`に`themeKana`/`descriptionKana`を追加（Worker側）
4. R2保存・`/image/:id`レスポンスに`themeKana`/`descriptionKana`を含める
5. `translations.kana`オブジェクトを`frontend/index.html`に追加
6. `toggleLang()` → `setLang(lang)`リファクタリング + URLパラメーター対応
7. `applyLang()`の`innerHTML`分岐追加
8. `currentLang`初期化に`kana`を追加（`URLSearchParams`読み取り）
9. `loadSharedImage()`・`buildGalleryCard()`の`kana`分岐追加
10. `showGoods()`に`goodsJaOnly`注釈表示追加
11. `setLang()`にUmamiイベント追加

### プレビューツール

```bash
node scripts/preview-kana.mjs "テーマ名" "説明文"
# → /tmp/kana-preview.html を生成してブラウザで確認
```
