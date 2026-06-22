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
wrangler secret put GEMINI_API_KEY           # 必須
wrangler secret put BLUESKY_IDENTIFIER       # 必須（nyanmusu.bsky.social）
wrangler secret put BLUESKY_APP_PASSWORD     # 必須（BlueskyのApp Password）
wrangler secret put DISCORD_WEBHOOK_URL      # 必須（Discord Webhook URL）
wrangler secret put BYPASS_TOKEN             # 開発用（レート制限バイパス）
wrangler secret put SUZURI_API_KEY           # SUZURIグッズ機能（任意）
wrangler secret put FAL_KEY                  # fal.aiアップスケーリング（任意）
wrangler secret put MASTODON_INSTANCE_URL    # Mastodon投稿（任意）例: https://mstdn.jp
wrangler secret put MASTODON_ACCESS_TOKEN    # Mastodon投稿（任意）アプリのアクセストークン

# Workerをデプロイ
wrangler deploy
```

KV namespaceのIDは`wrangler.toml`の`[[kv_namespaces]]`に記載済み（`id = "531244f9f904493d93c3a418b9765df8"`）。

Cron Trigger（`0 15 * * *` と `0 22 * * 1-5`）は`wrangler.toml`に設定済み。デプロイ後はCloudflareダッシュボードのTriggersタブで確認できる。**ダッシュボードで手動変更してもデプロイのたびに`wrangler.toml`の値で上書きされる。**スケジュール変更は必ず`wrangler.toml`を修正してからPRを出すこと。

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
- `MASTODON_INSTANCE_URL`（任意・設定時はhealth-check.jsがMastodon認証も検証する）
- `MASTODON_ACCESS_TOKEN`（任意・同上）
