# アーキテクチャ詳細: 成長ループの集計ワークフロー（`growth-metrics`・2026-11追加）

成長ループ（スキル`running-growth-loops`・`.claude/growth/`）が読む集計値を、GitHub Actionsで週1回取得し、ラベル`growth:metrics`のIssueにコメントする。Claude CodeのセッションはActionsのシークレット（`UMAMI_SHARE_ID`）を読めないため、Umamiの取得をActions側に置き、Claudeはコメントの数字だけを読む。読み方は`.claude/growth/config.md`の「データの取り方」参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/growth-metrics.yml` | 起動: `schedule`（毎週月曜05:17 JST＝日曜20:17 UTC）と`workflow_dispatch`。`permissions`は`contents: read`・`issues: write`だけ |
| `scripts/growth-metrics.mjs` | 取得・整形・コメント投稿。外部ライブラリは使わない（Node標準の`fetch`と`worker/http-utils.js`の`fetchWithRetry()`） |
| `scripts/test-growth-metrics.mjs` | 純粋関数と再試行方針のユニットテスト（`npm test`に含む） |

- `actions/checkout@v6`・`actions/setup-node@v6`（Node 24）。既存のワークフローに合わせる
- 依存パッケージを使わないため`npm ci`は行わない
- 環境変数: `UMAMI_SHARE_ID`（`secrets.UMAMI_SHARE_ID`）、`GITHUB_TOKEN`（`secrets.GITHUB_TOKEN`）、`GITHUB_REPOSITORY`（Actionsが自動で設定）
- 週次の成長ループは、このワークフローより後の時刻に動かす（`config.md`の鮮度は8日）
- `node scripts/growth-metrics.mjs --dry-run`で、Issueへ投稿せずコメント本文を標準出力に出す（ローカル確認用。`GITHUB_TOKEN`不要）

## 取得するもの

| キー | 取得元 | 計算 |
| --- | --- | --- |
| `bluesky_followers` | `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=nyanmusu.bsky.social` | `followersCount` |
| `bluesky_engagement_15` | `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=nyanmusu.bsky.social&limit=15` | 各投稿の`likeCount＋repostCount＋replyCount`の合計 |
| `mastodon_followers` | `https://mastodon.social/api/v1/accounts/lookup?acct=nyanmusu` | `followers_count` |
| `mastodon_engagement_15` | `https://mastodon.social/api/v1/accounts/{id}/statuses?limit=15` | 各投稿の`favourites_count＋reblogs_count＋replies_count`の合計 |
| `umami_visitors_7d` / `umami_visitors_30d` | Umamiの`stats`（下記） | 訪問者数（`visitors`） |
| `umami_suzuri_click_7d` / `umami_suzuri_click_30d` | Umamiの`metrics?type=event`（下記） | `x`が`suzuri-click`の要素の`y`。要素が無ければ0 |

- **他人の投稿の再投稿は数えない**: Blueskyのフィードで`reason`（リポスト）が付いた項目、Mastodonで`reblog`がある項目は、エンゲージメントの合計から除く（自分の投稿の反応だけを数えるため）。取得件数は15件のままなので、再投稿があると合計の対象は15件未満になる
- 2026-11-22の実取得では、15件とも自分の投稿だった

### Umamiの取得手順（共有URLのトークン方式）

取得先（APIのベース）は`https://gateway-us.umami.is`（2026-11-23変更）。`us`はUmami Cloudの地域で、地域が変わると`gateway-eu`になる可能性がある。

1. `GET https://gateway-us.umami.is/api/share/{UMAMI_SHARE_ID}` → `websiteId`と`token`
2. **取得した直後に`::add-mask::`でトークンと`websiteId`をログで伏せる**（`UMAMI_SHARE_ID`自体はActionsのシークレットとして自動で伏せられるが、念のため同様に伏せる）
3. 以降の`GET`に`x-umami-share-token: <token>`と`x-umami-share-context: 1`を付ける
4. `GET https://gateway-us.umami.is/api/websites/{websiteId}/stats?startAt=<ミリ秒>&endAt=<ミリ秒>`（直近7日・30日）
5. `GET https://gateway-us.umami.is/api/websites/{websiteId}/metrics?type=event&startAt=…&endAt=…`（直近7日・30日）

**取得先を`gateway-us.umami.is`にした理由（2026-11-23）**: Umami Cloudの共有ページ（`cloud.umami.is/analytics/us/share/{ID}`に移動する）をオーナーがChromeの開発者ツールで調べたところ、データは`https://gateway-us.umami.is/api/websites/{websiteId}/stats`・`/metrics`から読まれていた。Umamiの公開ソース（`src/components/hooks/queries/useShareTokenQuery.ts`・`src/lib/api-url.ts`）では、トークンの取得も同じAPIのベースに対する`GET /share/{ID}`のため、トークンの取得先も`https://gateway-us.umami.is/api/share/{ID}`と判断した。当初の`cloud.umami.is/api/share/{ID}`はHTML（HTTP 404）を返し、APIではなかった。

**確認状況（2026-11-22・2026-11-23の手動実行の結果で更新）**:

| 項目 | 状況 | 根拠 |
| --- | --- | --- |
| `startAt`・`endAt`はミリ秒 | 確認済み | 公式ドキュメント（<https://docs.umami.is/docs/api-reference/get-website-stats>） |
| `stats`の`visitors`は数値 | 確認済み（現行版） | 同上。古い版は`{ value, prev }`の形だったため、パーサーは両方を受け付ける |
| `metrics`は`[{ x, y }]`の配列で、`type=event`が使える | 確認済み | 公式ドキュメント（<https://docs.umami.is/docs/api-reference/get-website-metrics>） |
| `x-umami-share-token`・`x-umami-share-context`ヘッダー | ヘッダー名は確認済み | 公式ドキュメントに必須と記載。`x-umami-share-context`は値ではなく有無だけが検査されることを、Umamiの公開ソース（`src/lib/auth.ts`）で確認 |
| `GET /api/share/{共有ID}`が`websiteId`と`token`を返す | 確認済み（実動作） | 2026-11-23の手動実行で、このトークンを使った`stats`・`metrics`の取得に成功（Issue #225）。公式ドキュメントには記載がなく、Umamiの公開ソース（`src/app/api/share/[slug]/route.ts`）と実動作で確認 |
| Umami Cloudで上記の経路（`gateway-us.umami.is/api/...`）が使えること | 確認済み（実動作） | 2026-11-23の手動実行（GitHub Actions）で、訪問者数（7日70・30日326）と`suzuri-click`（7日1・30日1）を取得し、`errors`は空だった（Issue #225）。公式ドキュメントのCloud APIは`https://api.umami.is/v1`（APIキー方式）で、共有トークン方式の経路は書かれていない（非公開APIである点は変わらない） |
| 共有URLでイベント（`suzuri-click`）が見えること | 確認済み（実動作） | 同じ手動実行で`metrics?type=event`から`suzuri-click`の件数が取れた。共有設定でイベントが見えない場合の応答は引き続き不明 |

2026-11-23の手動実行で、Umamiの4項目を含む8項目すべてが取得でき、実行ログでは`UMAMI_SHARE_ID`が`***`で伏せられ、共有ID・トークン・`websiteId`はどの行にも出ていないことを確認した。共有トークン方式は非公開APIのため、Umamiの仕様変更で止まる可能性がある。止まった場合は、Umami CloudのAPIキー（`https://api.umami.is/v1`・`Authorization: Bearer`）への切り替えを検討する。

## 失敗の扱い

- 1項目の失敗で全体を止めない。失敗した項目は値を`null`にし、`errors`に`{キー: "理由"}`を入れる
- **理由には、トークン・ID・URL（クエリを含む）を入れない**。理由は`HTTP 404`・`非JSONレスポンス（HTTP 502）`・`通信エラー`・`タイムアウト`のような定型文だけにし、念のため既知の秘密情報（共有ID・トークン・`websiteId`）を`***`に置き換えてから記録する
- 共有トークンが401・403で拒否された場合、`umami_suzuri_click_*`の理由は「共有URLでイベントが非公開の可能性（HTTP 403）」とする
- `UMAMI_SHARE_ID`が未設定なら、Umamiの4項目は「`UMAMI_SHARE_ID`が未設定」とする
- 外部通信は`worker/http-utils.js`の`fetchWithRetry()`を使う（ネットワークエラー・5xxだけ指数バックオフで最大3回まで試行し、429は再試行しない。リポジトリ共通の方針）。各リクエストのタイムアウトは15秒
- **タイムアウトも再試行される**: `fetchWithRetry()`は`AbortError`を再試行しない作りだが、Node（2026-11-22にNode 24相当で確認）の`AbortSignal.timeout()`が投げる例外の名前は`TimeoutError`のため、実際にはタイムアウトもネットワークエラーとして再試行される。1リクエストの最悪は約45秒（15秒×3回）で、Actionsでは問題にならない。`worker/`側の挙動の扱いは、このワークフローとは別に判断する
- 応答は`res.text()`で受けてから`JSON.parse()`する（`.claude/rules/coding.md`の規約）
- **全項目が失敗したとき**と、**Issueへのコメント投稿に失敗したとき**は、ワークフローを失敗にする

## コメントの形式

ラベル`growth:metrics`の開いているIssueを1件探し、無ければタイトル「成長ループ：週次の集計」で作る（ラベルも無ければ作る。すでにあれば422が返るので無視する）。そこへ次の形でコメントする。

````markdown
<!-- growth-metrics v1 -->
週次の集計（YYYY-MM-DD HH:mm JST）

| 指標 | 値 |
| --- | --- |
| Blueskyフォロワー | 112 |
| … | … |
| Umami訪問者（7日） | 計測不可（UMAMI_SHARE_IDが未設定） |

```json
{"measured_at":"2026-11-22T13:00:00.000Z","metrics":{"bluesky_followers":112},"errors":{}}
```
````

- 1行目の目印`<!-- growth-metrics v1 -->`と、JSONの`measured_at`（ISO8601・UTC）・`metrics`（8キーすべて。失敗は`null`）・`errors`は、成長ループのスキルが読む前提の形なので、変えるときはスキルと`config.md`も合わせて直す
- コメント投稿にも`fetchWithRetry()`を使う。5xxの再試行で同じコメントが2件になる可能性はあるが、スキルは最新の1件だけを使うため害はない

### Umamiが「計測不可」になったときの切り分け（2026-11-23の初回確認で判明）

`gateway-us.umami.is`は、存在しない経路にはHTML、存在する経路のエラーにはJSONを返す。Umamiの4項目が同じ理由で計測不可のときは、トークンの取得（`/api/share/{ID}`）で失敗している。

| 理由 | 意味 | 対処 |
| --- | --- | --- |
| `非JSONレスポンス（HTTP 404）` | 取得先の経路が違う（HTMLが返った） | 取得先（`UMAMI_BASE`）を見直す。地域が変わって`gateway-eu`になった可能性もある |
| `HTTP 404` | 経路は正しいが、`UMAMI_SHARE_ID`の値の共有が見つからない | シークレットに、共有ページのアドレス`…/share/○○○○`の`○○○○`の部分だけ（英数字8〜50文字。`https://`・`/`・空白・改行を含めない）が入っているか、共有が無効・作り直しになっていないかを確かめる |
| `HTTP 401`・`HTTP 403` | トークンが拒否された | Umami側の仕様変更の可能性。APIキー方式への切り替えを検討する |

2026-11-23の初回確認では、最初に`非JSONレスポンス（HTTP 404）`（取得先が`cloud.umami.is`で誤り）、取得先を直した後に`HTTP 404`（シークレットにID以外の部分が含まれていた）となり、シークレットを直して取得できた。

## 守ること

- ログ・コメント・テストの出力に、`UMAMI_SHARE_ID`・トークン・`websiteId`を出さない。Umamiのリクエスト先URLはログに出さない
- 集計値（表の数字）は公開される前提（公開リポジトリ。オーナー了承済み）

## 初回確認の手順（マージ後にオーナーが行う）

1. GitHubのActionsタブ →「Growth Metrics」→「Run workflow」で手動実行する（`main`を選ぶ）
2. 実行が成功（緑）になることを確かめる。Umamiだけ失敗した場合も成功になる
3. ラベル`growth:metrics`のIssue「成長ループ：週次の集計」に、目印付きのコメントが1件付いたことを確かめる
4. コメントの表で、Bluesky・Mastodonの4項目に数字が入っていることを確かめる
5. Umamiの4項目に数字が入っているかを確かめる。「計測不可」なら、その理由をClaude Codeのセッションに伝える（上記「確認状況」の未確認の点の切り分けに使う）
6. 実行ログを開き、共有ID・トークン・`websiteId`が`***`で伏せられていることを確かめる
