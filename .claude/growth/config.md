# 成長ループ設定 — にゃんバーサリー

スキル`running-growth-loops`が毎回最初に読む正本。オーナーだけが書き換える（Claudeは変更案をPRで出すだけ）。

## リポジトリとオーナー

- リポジトリ：`hiroshikuze/anniversary-cat-worker`
- オーナーのGitHubユーザー名：`hiroshikuze`（承認とみなすのはこのアカウントのコメントだけ）

## 目標

- 北極星指標：SUZURIグッズの月間販売数
- 当面の重点：最上流の「SNS上での到達・発見」（診断の経緯は`.claude/future-ideas.md`の「集客・マーケティング診断」）

## ファネル

| 段階 | 指標 | 取得方法 |
| --- | --- | --- |
| 1. 発見 | Bluesky・Mastodonのフォロワー数、直近15投稿のいいね・リポスト・返信の合計 | 下の「データの取り方」 |
| 2. サイト訪問 | Umamiの訪問者数（直近7日・30日） | 同上 |
| 3. グッズ興味 | Umamiイベント`suzuri-click`の件数 | 同上 |
| 4. 購入 | SUZURI月間販売数 | 月初に`growth:input`のIssueでオーナーが回答 |

## データの取り方

- **集計Issue方式**：GitHub Actionsのワークフロー`growth-metrics.yml`が週1回、ファネル1〜3の数字を取り、ラベル`growth:metrics`のIssueにコメントする。Claudeはそのコメントを読むだけ（Umamiの共有URLのIDはActionsのシークレット`UMAMI_SHARE_ID`にあり、Claudeからは読めない・読まない）
- 鮮度：`measured_at`が8日より古い集計は使わない
- コメントのJSONの項目

| キー | 意味 |
| --- | --- |
| `bluesky_followers` | Blueskyのフォロワー数 |
| `bluesky_engagement_15` | Bluesky直近15投稿のいいね＋リポスト＋返信の合計 |
| `mastodon_followers` | Mastodonのフォロワー数 |
| `mastodon_engagement_15` | Mastodon直近15投稿のお気に入り＋ブースト＋返信の合計 |
| `umami_visitors_7d` / `umami_visitors_30d` | サイトの訪問者数（直近7日・30日） |
| `umami_suzuri_click_7d` / `umami_suzuri_click_30d` | `suzuri-click`イベントの件数（直近7日・30日） |

- 集計Issueが無い・古い場合に限り、Bluesky・Mastodonは`growth-researcher`に公開APIから取らせてよい（Bluesky：`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=nyanmusu.bsky.social`、Mastodon：`https://mastodon.social/api/v1/accounts/lookup?acct=nyanmusu`）。Umamiは取らない（計測不可とする）。WebFetchが使えなければ`curl`の`GET`で取る
- SUZURI販売数：取得しない（オーナー回答）
- **公開について**：このリポジトリは公開なので、集計値（上の表の数字）は誰でも見られる。オーナー了承済み。共有URLのIDとトークンは公開しない

## 権限

| 段階 | 内容 |
| --- | --- |
| 自動でよい（auto） | 計測、分析、実験の追加、`.claude/growth/`内の更新、アイデア置き場（`.claude/future-ideas.md`）への追記、ブランチ作成・コミット・記録PRの作成と更新、`growth:metrics`を除く`growth:*`ラベルのIssueの作成・コメント・クローズ、ラベル作成 |
| 承認が必要（approval） | SNSの投稿・返信・フォロー、プロフィール文の変更、SUZURIの価格・セール設定、`sale-announcement`の実行、外部へのメールやDM |
| 禁止 | 一括送信、自動フォロー、他人の投稿への自動返信、アプリコードの変更、本番デプロイ、記録PRのマージ、`growth:*`以外のIssueの操作、`growth:metrics`のIssueへの書き込み、ワークフローの手動実行 |

既存の自動投稿Bot（毎平日7:00）はこのループの対象外。Botの投稿内容を変える案は「アイデア置き場」に書く。

## ブランチ名

`claude/growth-YYYY-MM-DD`（作成した日付）

## 上限

- 実験の上限：`running`と`proposed`の合計で2件
- 1サイクルで呼ぶサブエージェント：計測1回＋検証最大2回
- 実行頻度：週1回

## アイデア置き場（コード変更が必要な案の書き先）

`.claude/future-ideas.md`
