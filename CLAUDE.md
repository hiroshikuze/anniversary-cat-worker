# CLAUDE.md — にゃんバーサリー (anniversary-cat-worker)

Claude Codeがこのリポジトリを扱う際の引き継ぎ情報。
**新しいセッションを開始するたびにここを確認すること。**

---

## プロジェクト概要

- **フロントエンド**: `frontend/index.html`（GitHub Pagesでホスト）
- **バックエンド**: `worker/index.js` (Cloudflare Workers)
- **本番 Worker URL**: wrangler.tomlの`name = "anniversary-cat-worker"`を参照
- **本番フロントエンド URL**: `https://hiroshikuze.github.io/anniversary-cat-worker/`

### 処理フロー

```text
ユーザー → frontend/index.html
  → POST /research  (Gemini + Google Search で記念日テキスト取得)
  → POST /generate  (Gemini 画像生成 or Pollinations.ai フォールバック)
  → 画像 + 説明 + sourceUrl をフロントに表示
```

---

## Bluesky営業Botプロジェクト（実装済み）

### 概要

毎平日19時台に記念日画像を自動生成してBlueskyに投稿する営業Bot。

### 決定済み方針

- **Botアカウント**: `@nyanmusu.bsky.social`（既存の休眠アカウントを再活用）
- **投稿内容**: `/research` → `/generate` で当日の記念日コンテンツを生成し、締めの宣伝文＋ハッシュタグを付けて投稿
- **投稿スケジュール**: 月〜金 19時台（UTC 10:00）、祝日判定なし
  - Cron式: `0 10 * * 2-6`
  - ※Cloudflare Workersの曜日指定は `1=日曜日` のため、月〜金は `2-6`（標準cronの `1-5` とは異なる）
- **ハッシュタグ**: `#AIart #cat #kitten #ほのぼの #猫`
- **言語**: 日本語のみ（まずは様子を見る）
- **リプライ対応**: 手動（hiroshikuze本人が対応）
- **エラー時**: リトライなし（`/generate`内部にPollinationsフォールバックあり）

### 通知・ログ設計

| 役割 | 手段 |
| --- | --- |
| エラーログ永続化 | `console.error()` → Cloudflare Workers Logs |
| リアルタイム通知 | Discord Webhook（`DISCORD_WEBHOOK_URL`シークレット） |
| 成功ログ | `console.log()` → 同上 |

### 必要なシークレット

```bash
wrangler secret put BLUESKY_IDENTIFIER      # nyanmusu.bsky.social
wrangler secret put BLUESKY_APP_PASSWORD    # BlueskyのApp Password（手順は下記）
wrangler secret put DISCORD_WEBHOOK_URL     # Discord通知用Webhook URL（手順は下記）
```

GitHub Actionsにも同名のシークレットを登録する。
（リポジトリ → Settings → Secrets and variables → Actions → New repository secret）

### Bluesky App Password の取得手順

1. `@nyanmusu.bsky.social`でBlueskyにログイン
2. 設定 → プライバシーとセキュリティ → App Passwords → Add App Password
3. 名前は任意（例: `nyanversary-bot`）、DM権限は不要
4. 表示されたパスワードをコピー（**一度しか表示されない**）
5. `wrangler secret put BLUESKY_APP_PASSWORD`で登録

### Discord Webhook の取得手順

1. Discordアカウントを作成（discord.com、メールアドレスのみでOK）
2. 「+」→「自分のため」でプライベートサーバーを作成（例: `にゃんバーサリー通知`）
3. チャンネル（例: `#エラー通知`）の歯車アイコン → 連携サービス → ウェブフック → 新しいウェブフック
4. URLをコピー
5. `wrangler secret put DISCORD_WEBHOOK_URL`で登録

### 実装済みファイル

```text
worker/
└── bluesky-bot.js    ← Cron Trigger で動くBotロジック（index.jsからimport）
wrangler.toml         ← [triggers] crons = ["0 10 * * 2-6"] を追加済み
```

### 実装フロー

```text
Cron Trigger（月〜金 10:00 UTC = 19:00 JST）
  └→ handleResearch() を直接呼び出し（HTTP経由ではなく関数呼び出し・レート制限なし）
      ├→ 失敗 → console.error + Discord通知 → 終了
      └→ 成功
          └→ handleGenerate() を直接呼び出し（同上）
              ├→ 失敗 → console.error + Discord通知 → 終了
              └→ 成功
                  └→ Bluesky投稿（画像blob upload → createRecord）
                      ├→ 失敗 → console.error + Discord通知 → 終了
                      └→ 成功 → console.log

```

> **重要**: BotはHTTP自己呼び出し（fetch to WORKER_URL）をせず、`handleResearch`・`handleGenerate`を直接関数として呼び出す。
> HTTP経由にするとレート制限・BYPASS_TOKEN管理・URL設定ミスのリスクがあるため。

### 投稿テキスト形式

```text
今日は「{theme}」の日！🐱
{description}

あなたも今日のにゃんバーサリーを作ってみませんか？
https://hiroshikuze.github.io/anniversary-cat-worker/

#AIart #cat #kitten #ほのぼの #猫
```

- 300 grapheme以内に収まる設計（実測 ~200 grapheme）
- ハッシュタグはAT Protocolのfacets形式（UTF-8バイト位置）で付与

### Botの手動テスト方法

本番環境で実際に投稿されるかを確認する手順。

#### Cloudflareダッシュボードから手動発火（推奨）

1. 事前確認: `wrangler secret list` で必要なシークレットが4つ揃っているか確認
2. **Workers & Pages** → `anniversary-cat-worker` → **Triggers**タブ
3. Cron Triggersセクションの **「Execute」** ボタンをクリック
4. **Logs**タブ → **Begin log stream** で結果を確認

実際にBlueskyに投稿されるため、確認後はBlueskyアプリ（またはWeb）で手動削除する。

**ログで確認すべきパターン:**

| ログ | 意味 |
| --- | --- |
| `[bot] research 完了 theme="xxx"` | 記念日取得成功 |
| `[bot] generate 完了 source=gemini` | 画像生成成功 |
| `[bot] Bluesky 投稿 完了` | 投稿成功 |
| `[bot] エラー: xxx` | どこかで失敗（メッセージで原因特定） |

#### wrangler devでローカルテスト（Bluesky投稿なしに確認したい場合）

シークレット等が不要な部分（テキスト生成・facets計算）のみ検証するなら`scripts/test-bot.mjs`を使う。

```bash
node scripts/test-bot.mjs
```

### Bluesky AT Protocol エンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 認証 | `POST https://bsky.social/xrpc/com.atproto.server.createSession` |
| 画像アップロード | `POST https://bsky.social/xrpc/com.atproto.repo.uploadBlob` |
| 投稿作成 | `POST https://bsky.social/xrpc/com.atproto.repo.createRecord` |

---

## APIエンドポイント一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/research` | Gemini + Google Searchで記念日テキスト取得 |
| POST | `/generate` | Gemini画像生成（Pollinationsフォールバックあり） |
| GET | `/proxy-image?url=...` | Pollinations.ai画像のCORSプロキシ |

### /proxy-imageのセキュリティ制約

`https://image.pollinations.ai/` 以外のURLはすべて403で拒否する（オープンプロキシ化防止）。

---

## レート制限

### 設定値（`worker/index.js` の `RATE_LIMITS`）

| エンドポイント | IP別上限 | グローバル上限 | TTL |
| --- | --- | --- | --- |
| `/generate` | 3回/日 | 50回/日 | 25時間 |
| `/research` | 10回/日 | なし | 25時間 |

Cloudflare KV（`RATE_KV`）で管理。日付はUTC基準でリセット。

### BYPASS_TOKEN（開発用）

ブラウザのコンソールで以下を実行するとレート制限をスキップできる。

```js
localStorage.setItem('bypassToken', '<シークレット値>')
```

フロントエンドはこの値を`X-Bypass-Token`ヘッダーに付与し、Workerが照合する。

---

## フロントエンド機能概要（`frontend/index.html`）

| 機能 | 詳細 |
| --- | --- |
| 多言語対応 | JP/EN切り替えボタン（`translations`オブジェクトで管理） |
| 画像共有 | Web Share API（ファイル共有）対応端末は「共有する」ボタン、非対応はダウンロード |
| PWA | Service Worker登録済み（`/anniversary-cat-worker/sw.js`） |
| クライアント側レート制限キャッシュ | `localStorage`に制限済みフラグを保存し二重送信を防止 |
| リトライ | 500系エラーは指数バックオフで最大3回リトライ（429はリトライしない） |
| OGP/Twitter Card | `og:image`と`twitter:image`設定済み |

---

## Pollinations.ai フォールバック詳細

画像生成時、GeminiとPollinationsを**並列実行**（`Promise.any`）し、先に成功した方を返す。

```text
Promise.any([tryGemini(), tryPollinations()])
```

### Pollinationsの注意事項

- 使用モデル: `flux` / `turbo` / `flux-realism` / `flux-anime`（4モデル同時並列、最初の成功を採用）
- **プロンプトはASCIIのみ**（日本語等の非ASCII文字はサーバー500エラーの原因になるためフィルタリング済み）
- タイムアウト: 20秒/モデル

---

## テスト・診断

### 自動テスト（GitHub Actions）

`main`および`claude/**`へのpushのたびに以下が自動実行される。
結果はGitHubの**Actionsタブ**で確認（✅/❌）。

| スクリプト | 内容 |
| --- | --- |
| `scripts/health-check.js` | 本番Worker・Gemini APIへのE2Eチェック |
| `scripts/test-bot.mjs` | `bluesky-bot.js`のユニットテスト（外部API不要） |

> **Claude はサンドボックス制限で外部 API に接続できないため、health-check.js を直接実行できない。**
> テスト結果が必要な場合はユーザーに Actions タブの確認を依頼すること。

### 問題発生時に Claude がやること

1. **Cloudflare Workers ログ**（下記参照）をユーザーに確認してもらい内容を共有してもらう
2. ログのパターンから原因を特定してコードを修正
3. push → Actionsの結果でテストを確認

---

## Cloudflare Workers ログの見方

**ダッシュボード**: Workers & Pages → `anniversary-cat-worker` → Logsタブ → Begin log stream

| ログパターン | 意味 |
| --- | --- |
| `[research] model=... sourceUrlKind=grounding` | 正常。grounding チャンクから URL 取得 |
| `[research] ... sourceUrlKind=vertexaisearch-skipped` | vertexaisearch URL を除外してフォールバックへ |
| `[research] ... sourceUrlKind=google-search-fallback` | 直接 URL が取れず Google 検索 URL で代替 |
| `[generate] Gemini success model=gemini-2.5-flash-image` | 正常 |
| `[generate] model=xxx unavailable(404)` | そのモデルは廃止済み → KNOWN_CANDIDATES を更新 |
| `[generate] model=xxx quota exceeded` | クォータ超過 |
| `[generate] ALL SOURCES FAILED` | Gemini も Pollinations も全滅 |

---

## Gemini モデル管理（重要）

### 画像生成モデル (`worker/index.js` の `KNOWN_CANDIDATES`)

```js
const KNOWN_CANDIDATES = [
  "gemini-2.5-flash-image",              // 2026-03 現在の stable（メイン）
  "gemini-2.0-flash-exp",                // 廃止済みの可能性あり
  "gemini-2.0-flash-preview-image-generation",  // 廃止済み（404）
];
```

**モデルが 404 になったら:**

1. Actionsタブでhealth-checkの失敗を確認（またはCloudflareログで`unavailable(404)`を確認）
2. [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models) で現行モデルを確認
3. `KNOWN_CANDIDATES`の先頭を新しいモデルに更新してpush → Actionsで確認

### Research モデル（テキスト用）

`selectBestModel()` がスコアリングで自動選択。手動設定不要。
ログ: `[model-select] selected: gemini-xxx`

---

## 過去に修正した問題（再発防止）

### 1. Gemini 画像生成が 404 になる (2026-03)

- **原因**: `gemini-2.0-flash-preview-image-generation` が廃止
- **修正**: `KNOWN_CANDIDATES` の先頭を `gemini-2.5-flash-image` に変更
- **場所**: `worker/index.js` L222-228

### 2. sourceUrl が vertexaisearch リダイレクト URL になり 404 (2026-03)

- **原因**: フィルター条件が `"<vertexaisearch.cloud.google.com>"` と角括弧付きで誤っていた
- **修正**: `!uri.includes("vertexaisearch.cloud.google.com")` に修正
- **場所**: `worker/index.js` L205

### 3. BotがHTTP自己呼び出しでURL設定ミスにより動作しない (2026-03)

- **原因**: BotがWorker自身のエンドポイントへfetchしていたが、`WORKER_URL`環境変数が未設定でURLがundefinedになっていた
- **修正**: `fetch(WORKER_URL/research)`をやめ、`handleResearch()`・`handleGenerate()`を直接関数として呼び出すよう変更
- **設計方針**: BotとWorkerは同一プロセス内なのでHTTP経由は不要。直接呼び出しならURL設定ミス・レート制限・BYPASS_TOKEN管理の問題が全て消える
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `scheduled()`

### 4. Cron曜日指定がずれていた (2026-03)

- **原因**: Cloudflare Workersの曜日指定は `1=日曜日` で標準cronと異なる。`1-5` では日〜木になっていた
- **修正**: `0 10 * * 1-5` → `0 10 * * 2-6`（月〜金）
- **場所**: `wrangler.toml` L8、Cloudflareダッシュボードのトリガー設定

### 5. Bluesky画像アップロードがサイズ超過で失敗 (2026-03)

- **原因**: Gemini生成画像（PNG）がBluesky上限1,000,000 bytesを超えることがある（実測 ~1.3MB）
- **修正**: `shrinkImageIfNeeded()`を追加。上限超過時にPollinationsで512×512の画像を再取得する
- **設計**: Cloudflare Workersには画像圧縮APIがないため、再取得で対処
- **場所**: `worker/bluesky-bot.js` `shrinkImageIfNeeded()` / `runBot()`

### 6. 記念日の根拠リンクが表示されない (2026-03)

- **原因**: リファクタリング時に `sourceUrl` の表示コードがフロントから消えていた
- **修正**: `<p>` を `<a>` タグに変更し、`researchData.sourceUrl` を `href` に設定
- **場所**: `frontend/index.html` L155, L450-458

---

## ファイル構成

```text
anniversary-cat-worker/
├── CLAUDE.md               ← このファイル（引き継ぎ情報）
├── worker/
│   ├── index.js            ← Cloudflare Worker 本体（fetch + scheduled ハンドラ）
│   └── bluesky-bot.js      ← Bluesky Bot ロジック（index.jsからimport）
├── frontend/
│   └── index.html          ← フロントエンド（GitHub Pages）
├── scripts/
│   ├── health-check.js     ← E2E診断スクリプト（GitHub Actions で自動実行）
│   └── test-bot.mjs        ← bluesky-bot.jsのユニットテスト（外部API不要）
└── wrangler.toml           ← Cloudflare デプロイ設定（Cron Trigger 含む）
```

---

## デプロイ

```bash
# KV namespace を作成（初回のみ・作成後にwrangler.tomlのidを更新）
wrangler kv namespace create RATE_KV

# シークレットを設定（初回のみ）
wrangler secret put GEMINI_API_KEY
wrangler secret put BYPASS_TOKEN
wrangler secret put BLUESKY_IDENTIFIER      # nyanmusu.bsky.social
wrangler secret put BLUESKY_APP_PASSWORD    # BlueskyのApp Password
wrangler secret put DISCORD_WEBHOOK_URL     # Discord Webhook URL

# Worker をデプロイ
wrangler deploy
```

KV namespaceのIDは`wrangler.toml`の`[[kv_namespaces]]`に記載済み（`id = "531244f9f904493d93c3a418b9765df8"`）。

Cron Trigger（`0 10 * * 2-6`）は`wrangler.toml`に設定済み。デプロイ後はCloudflareダッシュボードの「Triggers」タブで確認できる。

フロントエンドはGitHub Pagesで自動デプロイ（`frontend/`ディレクトリ）。

---

## Markdown 執筆ルール

Claude Codeがこのリポジトリのドキュメントを編集・生成する際は以下を必ず守ること。

- **全角・半角の間にスペースを入れない**（JTF 3.1.1）
  - 例: `GitHub Pagesで` ✅ / `GitHub Pages で` ❌
  - 例: `Actionsの結果` ✅ / `Actions の結果` ❌
- **括弧は全角を使う**（JTF 4.3.1）
  - 例: `（重要）` ✅ / `(重要)` ❌
  - ただしコード・コマンド・URLの中の括弧は半角のまま
- **コードブロックには言語を指定する**（MD040）
  - 例: ` ```js `, ` ```bash `, ` ```text `（プレーンテキストは `text`）
- **見出しの前後に空行を入れる**（MD022）
- **リストの前後に空行を入れる**（MD032）
- **テーブルのセパレーター行はスペースを入れる**（MD060）
  - 例: `| --- | --- |` ✅ / `|---|---|` ❌

---

## 開発ブランチ運用

- 作業ブランチ: `claude/`プレフィックス + セッションIDサフィックス
- push: `git push -u origin claude/<branch-name>`
- mainへの直接pushは禁止
