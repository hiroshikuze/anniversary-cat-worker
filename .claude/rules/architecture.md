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

### /proxy-imageのセキュリティ制約

`https://image.pollinations.ai/`以外のURLはすべて403で拒否する（オープンプロキシ化防止）。

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
- ハッシュタグ: `#AIart #cat #kitten #ほのぼの #猫`（AT Protocol facets形式で付与）
- エラー時: リトライなし（`/generate`内部にPollinationsフォールバックあり）

### 投稿テキスト形式

```text
今日は「{theme}」の日！🐱
{description}

あなたも今日のにゃんバーサリーを作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#AIart #cat #kitten #ほのぼの #猫
```

300 grapheme以内に収まる設計（実測 ~200 grapheme）。

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
- `POST /api/v1/materials`に画像URLを渡すだけで商品が動的生成され、レスポンスに商品ページURLが返る
- 認証はAPIキー方式（Bearer Token）で十分

```text
画像生成完了
  └→ POST /api/v1/materials（SUZURIに商品を動的生成）
      └→ レスポンスのsampleUrlを「グッズを買う」ボタンのリンクに使う
```

#### SUZURIショップ設定（完了済み・2026-03）

- **ショップ名**: にゃんむす / **アカウント**: nyanmusu
- **Webサイト**: `https://hiroshikuze.github.io/anniversary-cat-worker/`
- 表示項目: グッズのみON（デジタルコンテンツ・コミッション・デザイン等はOFF）
- トリブン: 商品登録時に個別設定（Tシャツ300〜500円、ステッカー100〜200円、缶バッジ100円、アクキー200〜300円）
- 振込先申請（「金にする」ボタン）は実際に売れてから対応

#### 透過処理

背景除去には外部API（remove.bg等）が必要。追加コスト・処理時間が発生するため後回しでよい。Tシャツは透過不要なので商品種別によって制御する。
