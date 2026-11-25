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

## 成長ループの定期実行（スケジュールタスク・2026-11追加）

週次の成長ループ（スキル`running-growth-loops`）は、claude.aiのスケジュールタスクとして、毎回新しいクラウドセッションで動く。集計ワークフロー（月曜5:17 JST）より後の時刻に動かす。

| 項目 | 内容 |
| --- | --- |
| 名前 | にゃんバーサリー成長ループ |
| ID | `trig_01EAC9mQJqdSeuZCpraJEBpp`（秘密情報ではない） |
| 時刻 | 毎週月曜9:46 JST（`CRON_TZ=Asia/Tokyo 46 9 * * 1`） |
| 作成・編集する画面 | `https://claude.ai/code/routines`（正式名称はScheduled tasks、旧称Routines）。Desktopアプリは「Scheduled」、CLIは`/schedule` |
| 対象リポジトリ | `hiroshikuze/anniversary-cat-worker`。編集画面の「Repository」の行で指定する（**必須**。指定しないと、起動したセッションにリポジトリが読み込まれない） |
| 権限 | 自動で進むモード（auto）で始まる。作成時には選べない |
| 指示文 | 「このリポジトリ（`hiroshikuze/anniversary-cat-worker`）の`.claude/skills/running-growth-loops/SKILL.md`を読み、その手順で、成長ループを1サイクル回してください。アカウント側の同名スキル（`anthropic-skills:running-growth-loops`）は使わないでください。CLAUDE.mdの『例外：成長ループの週次実行』の条件の範囲で進めてください。範囲を外れる作業が必要になったら、その作業はせず、`.claude/future-ideas.md`に提案として書いてください。リポジトリが見つからない場合は、何も変更せず、その旨を報告して終えてください。」 |

### 「成功」の表示は、成果を意味しない

- 実行履歴（画面の「History」）の状態は、セッションが起動したかどうかを示す。**中身が何もできなくても「Succeeded」になる**。確認は成果物で行う: 記録PR（ラベル`growth:record`）、Issue（`growth:approval`・`growth:input`）、ブランチ`claude/growth-YYYY-MM-DD`
- 接続が切れていると、実行は最大72時間スキップされ、その後タスクが止まる（公式ドキュメント）

### 経緯

| 日付 | 出来事 |
| --- | --- |
| 2026-11-22 | `create_trigger`（リポジトリを指定する項目がないツール）で登録 |
| 2026-11-23 9:46 JST | 初回の定期実行。**リポジトリが読み込まれず**（作業ディレクトリが空）、`gh`のトークン（`GH_TOKEN`）も無効で、何もできずに終了した（履歴の状態は「成功」）。リポジトリがないため、アカウント側の同名スキル（古い版）が使われた |
| 2026-11-25 | 画面の「Repository」にリポジトリを追加し、指示文にリポジトリのスキルを指定。手動で1回実行（約3分・約1.9ドル）。記録PR（#235）・承認依頼Issue（#233）・記入依頼Issue（#234）が、例外の範囲で作られた。集計の数字は#225の集計と一致し、提案（セールバナーのリンクに`suzuri-click`が付いていない件）もコードで確認できた |

- 定期実行での動作は、2026-11-30 9:46 JSTの回で確認する
- 1回の費用は約1.9ドル（2026-11-25の実測・Opus）。週1回なら月約8ドル
- **未対応（オーナー判断）**: アカウント側の同名スキル`anthropic-skills:running-growth-loops`には、古い`gh issue`系のコマンドの版が残っている。リポジトリ側を正とし、アカウント側を外すか更新する
