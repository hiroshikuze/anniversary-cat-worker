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

## Bluesky営業Botプロジェクト（未実装・実装予定）

### 概要

毎平日19時台に記念日画像を自動生成してBlueskyに投稿する営業Bot。

### 決定済み方針

- **Botアカウント**: `@nyanmusu.bsky.social`（既存の休眠アカウントを再活用）
- **投稿内容**: `/research` → `/generate` で当日の記念日コンテンツを生成し、締めの宣伝文＋ハッシュタグを付けて投稿
- **投稿スケジュール**: 月〜金 19時台（UTC 10:00）、祝日判定なし
  - Cron式: `0 10 * * 1-5`
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

### 必要なシークレット（未設定）

```bash
wrangler secret put BLUESKY_IDENTIFIER      # nyanmusu.bsky.social
wrangler secret put BLUESKY_APP_PASSWORD    # BlueskyのApp Password（DM許可不要）
wrangler secret put DISCORD_WEBHOOK_URL     # Discord通知用Webhook URL
```

### Bluesky App Password の取得方法

Bluesky → 設定 → プライバシーとセキュリティ → App Passwords → Add App Password

### Discord Webhook の取得方法

1. Discordでプライベートサーバーを新規作成（自分専用のエラー通知用）
2. チャンネル設定 → 連携サービス → Webhookを作成してURLをコピー
3. `wrangler secret put DISCORD_WEBHOOK_URL`でWorkerにセット

### 実装予定ファイル

```text
worker/
└── bluesky-bot.js    ← Cron Trigger で動く新規Worker（未作成）
wrangler.toml         ← Cron Trigger の設定追加が必要
```

### 実装フロー

```text
Cron Trigger（月〜金 10:00 UTC）
  └→ /research 呼び出し（記念日テキスト生成）
      ├→ 失敗 → console.error + Discord通知 → 終了
      └→ 成功
          └→ /generate 呼び出し（画像生成）
              ├→ 失敗 → console.error + Discord通知 → 終了
              └→ 成功
                  └→ Bluesky投稿（画像＋テキスト＋ハッシュタグ）
                      ├→ 失敗 → console.error + Discord通知 → 終了
                      └→ 成功 → console.log
```

---

## テスト・診断

### 自動テスト（GitHub Actions）

`main`および`claude/**`へのpushのたびに`scripts/health-check.js`が自動実行される。
結果はGitHubの**Actionsタブ**で確認（✅/❌）。

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

### 3. 記念日の根拠リンクが表示されない (2026-03)

- **原因**: リファクタリング時に `sourceUrl` の表示コードがフロントから消えていた
- **修正**: `<p>` を `<a>` タグに変更し、`researchData.sourceUrl` を `href` に設定
- **場所**: `frontend/index.html` L155, L450-458

---

## ファイル構成

```text
anniversary-cat-worker/
├── CLAUDE.md               ← このファイル（引き継ぎ情報）
├── worker/
│   └── index.js            ← Cloudflare Worker 本体
├── frontend/
│   └── index.html          ← フロントエンド（GitHub Pages）
├── scripts/
│   └── health-check.js     ← 診断スクリプト（GitHub Actions で自動実行）
└── wrangler.toml           ← Cloudflare デプロイ設定
```

---

## デプロイ

```bash
# Worker をデプロイ
wrangler deploy

# シークレットを設定（初回のみ）
wrangler secret put GEMINI_API_KEY
wrangler secret put BYPASS_TOKEN
```

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
