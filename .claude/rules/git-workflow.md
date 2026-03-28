# Gitワークフロー・デプロイ手順

## ブランチ運用

- 作業ブランチ: `claude/`プレフィックス + セッションIDサフィックス
- push: `git push -u origin claude/<branch-name>`
- mainへの直接pushは禁止
- rebase後はforce pushが必要: `git push --force-with-lease origin <branch>`

## コミット

- コミットメッセージはprefixを付ける: `feat:` `fix:` `docs:` `refactor:` `test:`
- コミットメッセージの末尾にセッションURLを付与する

## CI/CDによる自動デプロイ

| トリガー | 実行内容 |
| --- | --- |
| `main`へのpush（`worker/**`または`wrangler.toml`変更時） | Cloudflare Workersへ自動デプロイ |
| `main`へのpush（`frontend/**`変更時） | GitHub Pagesへ自動デプロイ |
| `main`または`claude/**`へのpush | ヘルスチェック + ユニットテスト自動実行 |

## 初回セットアップ（デプロイ）

```bash
# KV namespaceを作成（初回のみ・作成後にwrangler.tomlのidを更新）
wrangler kv namespace create RATE_KV

# シークレットを設定（初回のみ）
wrangler secret put GEMINI_API_KEY
wrangler secret put BYPASS_TOKEN
wrangler secret put BLUESKY_IDENTIFIER      # nyanmusu.bsky.social
wrangler secret put BLUESKY_APP_PASSWORD    # BlueskyのApp Password
wrangler secret put DISCORD_WEBHOOK_URL     # Discord Webhook URL
wrangler secret put SUZURI_API_KEY          # SUZURI APIキー

# Workerをデプロイ
wrangler deploy
```

KV namespaceのIDは`wrangler.toml`の`[[kv_namespaces]]`に記載済み（`id = "531244f9f904493d93c3a418b9765df8"`）。

Cron Trigger（`0 10 * * 2-6`）は`wrangler.toml`に設定済み。デプロイ後はCloudflareダッシュボードのTriggersタブで確認できる。

フロントエンドはGitHub Pagesで自動デプロイ（`frontend/`ディレクトリ）。

## GitHub Actionsシークレット

リポジトリ → Settings → Secrets and variables → Actions に以下を登録する:

- `BLUESKY_APP_PASSWORD`
- `BLUESKY_IDENTIFIER`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `GEMINI_API_KEY`
- `SUZURI_API_KEY`
