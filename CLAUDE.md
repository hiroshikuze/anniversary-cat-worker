# CLAUDE.md

<!-- にゃんバーサリー (anniversary-cat-worker) — Claude Code引き継ぎ情報 -->

**新しいセッションを開始するたびに、まず `.claude/revision_log.md` を読んでから作業を始める。**

---

## 最重要原則

### 1. Plan Mode Default
3ステップ以上のタスクは実装前に計画を提示し、承認を得てから進む。

### 2. Self-Improvement Loop
ミスのパターンを `.claude/revision_log.md` に記録し、毎セッション冒頭で読み返す。

### 3. Verification Before Done
完了前に「スタッフエンジニアが承認するレベルか」を自問する。

### 4. Subagent Strategy
リサーチ・分析はサブエージェントに委譲し、メインコンテキストを保全する。

### 5. Demand Elegance
設計判断を含む変更では、力技の前に2〜3のアプローチを比較検討する（細かい修正は除く）。

### 6. Autonomous Bug Fixing
バグ報告時はまず自律的に調査・修正し、設計判断のみ確認を取る。

---

## プロジェクト概要

- **フロントエンド**: `frontend/index.html`（GitHub Pagesでホスト）
- **バックエンド**: `worker/index.js`（Cloudflare Workers）
- **本番フロントエンドURL**: `https://hiroshikuze.github.io/anniversary-cat-worker/`
- **Bot**: `@nyanmusu.bsky.social`（毎平日19:00 JST、記念日画像を自動投稿）

### 処理フロー

```text
ユーザー → frontend/index.html
  → POST /research  (Gemini + Google Search で記念日テキスト取得)
  → POST /generate  (Gemini 画像生成 or Pollinations.ai フォールバック)
  → 画像 + 説明 + sourceUrl をフロントに表示
```

---

## コマンド

```bash
npm test                  # ユニットテスト（外部API不要）
node scripts/test-bot.mjs # 同上（直接実行）
wrangler dev              # ローカル開発サーバー
wrangler deploy           # 手動デプロイ（通常はCIが自動実行）
```

---

## 変えてはいけない設計判断

以下は過去のバグ修正で確定した方針。変更前に必ず理由を確認する。

| 判断 | 理由 |
| --- | --- |
| BotはHTTP自己呼び出しをせず`handleResearch()`/`handleGenerate()`を直接呼ぶ | URL未設定・レート制限・BYPASS_TOKEN管理のリスクを排除 |
| Cron式は`0 10 * * 2-6`（月〜金） | Cloudflare Workersは`1=日曜日`のため標準cronの`1-5`では日〜木になる |
| ユーザーによる記念日の自由入力は実装しない | プロンプトインジェクションでGemini APIキーのGoogleアカウントがBanされるリスク |
| Geminiコンテンツポリシー違反のBanはAPIキー所有者（hiroshikuzeのメインアカウント）に発生する | Gmail/Drive等のGoogleサービス全体に影響が及ぶ |

---

## テスト制約

> Claudeはサンドボックス制限で外部APIに接続できない。
> `scripts/health-check.js`は直接実行不可。テスト結果はユーザーにGitHub ActionsタブのURLで確認を依頼する。

---

## 詳細ルール

- コーディング規約・Markdown執筆ルール → `.claude/rules/coding.md`
- テスト方針・診断手順 → `.claude/rules/testing.md`
- Gitワークフロー・デプロイ手順 → `.claude/rules/git-workflow.md`
- システム設計・API仕様・将来拡張 → `.claude/rules/architecture.md`
