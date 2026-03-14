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
