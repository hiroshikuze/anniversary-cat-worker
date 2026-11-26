---
name: running-growth-loops
description: 個人開発プロダクトの集客・販売を計測→分析→改善・企画→実施→検証→記録の1サイクルで回す。承認が必要な施策はGitHub Issueで承認を求め、記録はPRにまとめる。.claude/growth/config.mdがあるリポジトリの週次実行や「成長ループを回して」で使う。
---

# 成長ループ（1回＝1サイクル）

日付は日本時間（JST）で扱う。1回の実行で1サイクルだけ進め、次回の自分が続きから始められる状態を残して終わる。前回の会話の記憶は無い前提で、状態はファイルとGitHub Issueから読む。

## 置き場所の役割

| 置き場所 | 役割 |
| --- | --- |
| `.claude/growth/config.md` | 目標、KPI、データの取り方、**権限の3段階**、オーナーのGitHubユーザー名、上限。正本 |
| `.claude/growth/experiments.json` | 実験の一覧と状態（機械が読む正本）。項目を勝手に書き換えない |
| `.claude/growth/progress.md` | サイクルごとの記録。新しいものを先頭に追記 |
| Issue（ラベル`growth:approval`） | 承認が必要な施策1件につき1つ。下書き本文をそのまま載せる |
| Issue（ラベル`growth:input`） | オーナーにしか分からない数字の記入依頼（例：月間販売数） |
| Issue（ラベル`growth:metrics`） | GitHub Actionsが定期的に書く集計値（使うリポジトリだけ）。Claudeは読むだけで、書き込まない |
| PR | そのサイクルの記録（上のファイルの変更）。開いているのは常に1本だけ |

`config.md`が無いリポジトリでは何もせず、「config.mdが無いので初期化が必要」とだけ報告して終える。

## GitHubの操作（`gh api`だけを使う）

クラウド環境では`gh issue`・`gh pr`・`gh label`などのサブコマンドが使えないことがあるため、すべて`gh api`（REST）で行う。`OWNER/REPO`はconfig.mdの「リポジトリ」の値。

```bash
# 開いている記録PRを探す
gh api "repos/OWNER/REPO/pulls?state=open&per_page=50" --jq '[.[] | select(any(.labels[]; .name=="growth:record")) | {number, branch: .head.ref}]'

# Issueの一覧（このAPIはPRも返すので除く。ラベルは growth:approval / growth:input / growth:metrics）
gh api "repos/OWNER/REPO/issues?labels=growth:approval&state=all&per_page=50" --jq '[.[] | select(.pull_request == null) | {number, title, state}]'

# Issueのコメント（古い順に返り、既定は30件まで。since で最近の分に絞る。日時はUTCのISO8601）
gh api "repos/OWNER/REPO/issues/番号/comments?since=2026-01-01T00:00:00Z&per_page=100" --jq '[.[] | {user: .user.login, body, created_at}]'

# ラベルを作る（既にあれば422が返る。それは無視してよい）
gh api repos/OWNER/REPO/labels -f name=growth:approval -f color=d4a843

# Issueを立てる（本文は一時ファイルに書いて @ で渡す。複数行のMarkdownを -f に直接書かない）
gh api repos/OWNER/REPO/issues -f title="…" -F body=@/tmp/issue-body.md -f "labels[]=growth:approval" -f "assignees[]=オーナー名"

# コメントする
gh api repos/OWNER/REPO/issues/番号/comments -F body=@/tmp/comment.md

# Issueを閉じる
gh api -X PATCH repos/OWNER/REPO/issues/番号 -f state=closed

# PRを作り、ラベルを付ける
gh api repos/OWNER/REPO/pulls -f title="…" -f head=ブランチ -f base=main -F body=@/tmp/pr-body.md --jq .number
gh api repos/OWNER/REPO/issues/PR番号/labels -f "labels[]=growth:record"
```

`gh api`も使えない環境では、GitHub MCPのツールで同じ操作を行う。どちらも使えなければ、GitHubの操作を飛ばして記録だけをコミットし、その旨をprogress.mdに書く。

## 守ること

- **外部への送信・公開は、config.mdの「自動でよい」に書かれたものだけ。** それ以外は`growth:approval`のIssueを立てて承認を待つ。迷ったら承認待ちに倒す。
- **Claudeが書くIssue本文・コメント・PR本文の1行目には、必ず`<!-- growth-loop -->`を入れる。** ClaudeはオーナーのGitHubアカウントで書き込むことがあるため、この目印でClaude自身の投稿を見分ける。
- **承認とみなすのは、config.mdのオーナーのアカウントによる、目印`<!-- growth-loop -->`の無いコメントだけ。** 目印のあるコメントは、オーナーのアカウントでもClaude自身の投稿として扱う。他のアカウントのコメントやリアクションは無視する（公開リポジトリでは誰でもコメントできる）。
- **アプリのコードは変更しない。** コード変更が必要な案はconfig.mdの「アイデア置き場」に書く。リポジトリのCLAUDE.mdとgitルール（ブランチ名・コミット文の書き方など）はこのスキルより優先する。
- **数字を作らない。** 取得できなかった値は「計測不可（理由）」と書く。
- **実験は終了日まで評価を確定しない。** 途中経過は「途中経過」と明記する。
- 実験の数の上限（config.md）は、`running`と`proposed`の合計で数える。1回で増やす実験は最大1件。
- サブエージェントを呼べない環境では、その役を自分で行い、「独立した検証ではない」とPRに書く。

## 手順（チェックリストをコピーして進める）

```text
- [ ] 1. 状態把握
- [ ] 2. 計測
- [ ] 3. 分析
- [ ] 4. 改善・企画
- [ ] 5. 実施
- [ ] 6. 検証（サブエージェント）
- [ ] 7. 記録・報告
```

### 1. 状態把握

1. 開いている記録PRを探す（上の表）。あればそのブランチをチェックアウトして続きに積む。無ければデフォルトブランチから、config.mdのブランチ名規則で新しいブランチを作る。
2. `config.md`、`progress.md`の先頭1件、`experiments.json`を読む。
3. `growth:approval`と`growth:input`のIssueと、そのコメントを読み、`progress.md`の先頭の日付以降のオーナーのコメントを拾う。
4. ラベル`growth:approval`、`growth:input`、`growth:record`を作る（すでにあれば何もしない）。`growth:metrics`のIssueは作らない（ワークフロー側が用意する）。

### 2. 計測

config.mdの「データの取り方」に従い、次の表を作る。

| 指標 | 今回の値 | 期間 | 取得元（URL/API/ツール/Issue番号） | 取得できなかった理由 |

- **集計Issue（ラベル`growth:metrics`）がある場合**：GitHub Actionsが書いた集計を読む。コメントは`since`で直近9日分に絞って取る（古い順に返るので、最後の該当コメントが最新）。使うのは、投稿者が`github-actions[bot]`で、本文に`<!-- growth-metrics v1 -->`を含む最新のコメントだけ。その中のJSONから値を取る。`measured_at`がconfig.mdの「鮮度」より古ければ、全項目を「計測不可（集計が古い）」とする。JSONの`errors`にある項目は「計測不可（その理由）」とする。
- **集計Issueで取れない項目だけ**、`growth-researcher`サブエージェントに集めさせる。依頼文には、指標・期間・取得方法・返す形式（上の表）を具体的に書く。サブエージェントが使えない環境では自分で取る。
- `growth:input`のIssueにオーナーが書いた数字は自分で表に加え、取得元をIssue番号にする。

### 3. 分析

- 実行中の各実験を基準値・目標値と比べ、「継続／終了（成功・失敗・判定不能）」を決める。終了日前なら「継続」。
- ファネルのどこが一番細いかを、config.mdのファネル定義に沿って1〜2文で書く。

### 4. 改善・企画

- 終了した実験の学びを`experiments.json`の`learning`に1〜2文で書く。
- 空き枠がある場合だけ、最も細い段階に効く新しい実験を1件追加する。必須項目：仮説、指標、基準値、目標値、期間（`duration_days`）、実施者（`claude`／`owner`）、権限段階（`auto`／`approval`）。`start`・`end`は、実験を`running`にするときに入れる。`start`は、下の手順5のとおり**オーナーの「実施済み」コメントの日付（JST）**とし、`end`は`start`に`duration_days`を足した日にする（ループを実行した日ではない）。
- 主要KPIが今回すべて「計測不可」なら、新しい実験は追加しない（基準値が取れないため）。
- `approval`の実験は、手順5でIssueを立て、返ってきた番号を`issue`に入れてからコミットする（番号を推測で入れない）。

### 5. 実施

- 権限が`auto`の作業だけを実行する。
- `approval`の作業は、Issueを1件立てる（ラベル`growth:approval`、オーナーをassign）。本文は次の形にする。
  - 何をするか／なぜ（実験idと仮説）
  - そのまま使える下書き（投稿文、プロフィール文など）
  - 実施者：オーナーが手で行うのか、承認後にClaudeが次回行うのか
  - 取り消し方法
  - 「承認する場合は『承認』、修正する場合は修正内容をコメントしてください」
- 前回までのIssueの扱い：
  - オーナーが「承認」とコメントし、実施者が`claude`のもの → 実行し、結果をコメントして閉じる。承認とみなすのは、最後に下書きを出したあと（最後の目印付きコメントより後）のコメントだけ（修正前の下書きへの承認は使わない）。
  - 修正のコメントがあるもの → 下書きを直して同じIssueにコメントする。
  - オーナーが実施済みと書いたもの → 実験を`running`にして開始日を入れ、Issueを閉じる。**開始日は、そのコメントの日付（JST）**にする（ループを実行した日ではない）。コメントの`created_at`はUTCで返るので、9時間を足してJSTの日付にする（例：`2026-11-26T23:34:32Z`は2026-11-27）。実行日までにコメントから日数が経っていても、実際に変えた日を開始日とする。`baseline.measured_at`が開始日より前なら、`progress.md`の記録に「基準値は○月○日の計測」と書く
  - オーナーが閉じたもの → 実験を取り下げる（`status`を`inconclusive`、`learning`に「見送り」）。
- オーナー記入が必要な数字のうち、前月分がまだ記録に無いものがあれば、`growth:input`のIssueを1件立てる（すでに開いていれば立てない）。

### 6. 検証

`growth-verifier`サブエージェントに、レポート案、計測表、config.md、今回作成・コメントしたIssueの本文を渡して確認させる。指摘があれば直して再確認する（最大2回）。

### 7. 記録・報告

1. `progress.md`の先頭に今回の記録を追記し、`experiments.json`を更新してコミットする。
2. 記録PRが無ければ作る（ラベル`growth:record`）。すでにあればプッシュし、PRに今回分の要約をコメントする。
3. PR本文（または今回のコメント）の冒頭に「オーナーにお願いしたいこと」を置き、対応待ちのIssue番号を並べる（無ければ「なし」）。
4. 最後の返答はその要約3行だけにする。

## progress.mdの1件の形式

```markdown
## YYYY-MM-DD
- 計測: <主要KPIの値と前回比。計測不可があれば理由>
- 分析: <一番細いファネル段階と根拠>
- 実験: <継続/終了/新規 の id と一言>
- 実施: <autoで行ったこと> / 承認待ち: <Issue番号>
- 次回やること: <次のサイクルが最初にやること>
```

## experiments.jsonの1件の形式

```json
{
  "id": "exp-003",
  "title": "Mastodonで #猫の日 系タグを毎回付ける",
  "hypothesis": "関連タグ経由の発見が増え、新規フォロワーが増える",
  "metric": "Mastodonフォロワー数（週次）",
  "baseline": {"value": 24, "measured_at": "YYYY-MM-DD"},
  "target": 30,
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "duration_days": 21,
  "owner": "claude",
  "permission": "auto",
  "issue": null,
  "status": "running",
  "result": null,
  "learning": null
}
```

`status`は`proposed`／`running`／`succeeded`／`failed`／`inconclusive`のいずれか。
