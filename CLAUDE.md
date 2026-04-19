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

### 7. Docs → Tests → Code

特別な指示がない限り、実装の順序は**ドキュメント更新 → テスト追加 → コード変更**の順で行う。
TodoWriteでタスクを並べる際もこの順序を守る。逆順（コード先行）は禁止。

---

## プロジェクト概要

- **フロントエンド**: `frontend/index.html`（GitHub Pagesでホスト）
- **バックエンド**: `worker/index.js`（Cloudflare Workers）
- **本番フロントエンドURL**: `https://hiroshikuze.github.io/anniversary-cat-worker/`
- **Bot**: `@nyanmusu.bsky.social`（毎平日19:00 JST、記念日画像を自動投稿）
- **SUZURIショップ**: `https://suzuri.jp/nyanmusu`（AIイラスト入りグッズ）

### 処理フロー

```text
ユーザー → frontend/index.html
  → POST /research  (Gemini + Google Search で記念日テキスト取得・visualHint付き)
  → POST /generate  (Gemini画像生成 or Pollinations.ai フォールバック、2フェーズ方式)
  → 画像 + 説明 + sourceUrl をフロントに表示
  → POST /suzuri-create × 2回（ウォーターマーク合成後、2グループに分けて送信）
      ├─ can-badge + acrylic-keychain: 即時SUZURI登録
      └─ t-shirt + sticker: fal.ai ESRGAN 2xアップスケール → R2 → SUZURI登録（バックグラウンド）
```

```text
Cron（月〜金 19:00 JST）→ scheduled()
  → runBot() → handleResearch() → handleGenerate()
  → saveToR2()（products:[]で保存） → Bluesky投稿 → Discord通知

Bluesky共有URL初回訪問 → loadSharedImage() → products:[]を検知
  → createSuzuriFromImage()（手動生成と同じフロー）
      ├─ can-badge + acrylic-keychain: 即時SUZURI登録（2048px bicubic）
      └─ t-shirt + sticker: fal.ai ESRGAN 2x → SUZURI登録（バックグラウンド）
  2回目以降の訪問者: R2 products に既存データあり → 即表示（登録スキップ）
```

---

## ファイル構成

```text
anniversary-cat-worker/
├── CLAUDE.md                         ← 判断品質ルール（毎セッション冒頭で確認）
├── .claude/
│   ├── revision_log.md               ← ミスパターン記録（毎セッション冒頭で読む）
│   ├── settings.json                 ← PostToolUseフック（Markdownスペース検証）
│   └── rules/
│       ├── coding.md                 ← コーディング規約・Markdown執筆ルール
│       ├── testing.md                ← テスト方針・診断手順・ログパターン
│       ├── git-workflow.md           ← Gitワークフロー・デプロイ手順
│       └── architecture.md          ← 設計・API仕様・過去バグ・将来拡張
├── worker/
│   ├── index.js                      ← Cloudflare Worker本体（fetch + scheduledハンドラ）
│   ├── bluesky-bot.js                ← Bluesky Botロジック（runBot, buildPostText, etc.）
│   ├── fal.js                        ← fal.ai ESRGAN 2xアップスケーリング（Queue API）
│   ├── suzuri.js                     ← SUZURI API連携（商品生成・削除）
│   └── r2-storage.js                 ← Cloudflare R2ストレージ操作
├── frontend/
│   ├── index.html                    ← フロントエンド（PWA対応、JP/EN切り替え）
│   ├── manifest.json
│   └── sw.js
├── scripts/
│   ├── health-check.js               ← E2E診断（GitHub Actionsのみ実行）
│   ├── test-bot.mjs                  ← ユニットテスト（外部API不要）← npm test
│   ├── test-suzuri-api.mjs           ← SUZURI API動作確認（実商品が生成される）
│   ├── test-fal-models.mjs           ← fal.aiモデル比較（FAL_KEY必要）
│   └── test-gemini-image-timing.mjs  ← Gemini画像生成の所要時間計測（GEMINI_API_KEY必要）
├── .github/workflows/
│   ├── health-check.yml              ← push時: ユニットテスト + E2Eチェック
│   ├── deploy-worker.yml             ← main push時: Cloudflare Workersデプロイ
│   └── deploy-pages.yml              ← main push時: GitHub Pagesデプロイ
└── wrangler.toml                     ← Cloudflareデプロイ設定（Cron Trigger含む）
```

---

## コマンド

```bash
npm test                                              # ユニットテスト（外部API不要）
node scripts/test-bot.mjs                             # 同上（直接実行）
wrangler dev                                          # ローカル開発サーバー
wrangler deploy                                       # 手動デプロイ（通常はCIが自動実行）
node scripts/test-suzuri-api.mjs                      # SUZURI API動作確認（実商品が生成される）
GEMINI_API_KEY=xxx node scripts/test-gemini-image-timing.mjs   # Gemini所要時間計測
FAL_KEY=xxx node scripts/test-fal-models.mjs          # fal.aiモデル比較
```

---

## 変えてはいけない設計判断

以下は過去のバグ修正・実測で確定した方針。変更前に必ず理由を確認する。

| 判断 | 理由 |
| --- | --- |
| BotはHTTP自己呼び出しをせず`handleResearch()`/`handleGenerate()`を直接呼ぶ | URL未設定・レート制限・BYPASS_TOKEN管理のリスクを排除 |
| Cron式は`0 10 * * 2-6`（月〜金） | Cloudflare Workersは`1=日曜日`のため標準cronの`1-5`では日〜木になる |
| ユーザーによる記念日の自由入力は実装しない | プロンプトインジェクションでGemini APIキーのGoogleアカウントがBanされるリスク |
| Geminiコンテンツポリシー違反のBanはAPIキー所有者（hiroshikuzeのメインアカウント）に発生する | Gmail/Drive等のGoogleサービス全体に影響が及ぶ |
| 画像生成は2フェーズ方式（priorityMs=12,000ms） | Gemini平均8361ms・最大10203ms（実測）。Phase1でGemini優先、失敗時Pollinationsで即返却 |
| fal.aiはAuraSR 4xではなくESRGAN 2xを使用 | AuraSR 4x出力は~24MB・SUZURI 20MB上限超過（実測確認済み）、ESRGAN 2xは~6MBで安定 |
| fal.ai CDN URLを直接SUZURIに渡さない | fal.aiのCDN URLは制限あり・TTL短く、SUZURI側fetchで0バイトエラーになる。R2経由の`/hires/:id`URLを渡す |
| t-shirt+stickerグループのSUZURI登録は`ctx.waitUntil()`でバックグラウンド処理 | Wall-clock時間制限（~30秒）内でfal.ai処理は完了しない。Queue API（request_id保存→ポーリング）方式を使う |
| fal.ai Queue APIのrequest_idは`ctx.waitUntil()`より前にR2へ保存 | ctx.waitUntil()がwall-clock超過で強制終了しても、IDだけは確実に残す保証が必要 |
| 外部APIレスポンスをMapにする際は整数IDをキーにする | 文字列名はAPIバージョン・ロケールで表記が変わる（過去バグ: SUZURI item.name 表記ゆれ） |
| Pollinationsプロンプトの先頭は`kawaii watercolor cat`固定 | Fluxモデルは前半トークン重視。先頭に猫・スタイルを宣言することで一貫した品質を保つ |
| ボットはSUZURI登録しない。初回訪問者ブラウザに委譲する | ボット実行時間短縮 + ブラウザ側2048pxリサイズで印刷品質向上。重複防止はWorker側の`/suzuri-create`冒頭チェックで担保 |

---

## 現在のアーキテクチャ状態（2026-04）

### 実装済み機能

| 機能 | ファイル | 状態 |
| --- | --- | --- |
| 記念日リサーチ（Gemini + Google Search grounding） | `worker/index.js` `handleResearch()` | 稼働中 |
| visualHint（テーマ依存の英語視覚ヒント、`handleResearch()`のJSON出力に含む） | `worker/index.js` | 稼働中 |
| 画像生成 2フェーズ方式（`_twoPhaseRace`） | `worker/index.js` | 稼働中 |
| 猫ペルソナ（`CAT_PERSONAS` 13種・重み付き） | `worker/index.js` `pickPersona()` | 稼働中 |
| 猫の性格（`CAT_PERSONALITIES` 5種 + おまかせ・重み付き） | `worker/index.js` `pickPersonality()` | 稼働中 |
| 猫の感情の瞬間（`CAT_EMOTIONS` 5種 + おまかせ・重み付き・毛柄・性格と独立） | `worker/index.js` `pickEmotion()` | 稼働中 |
| 食べ物テーマの eating action（`CAT_EATING_ACTIONS` 4種・30%確率・全角除外チェック） | `worker/index.js` `pickEatingAction()` | 稼働中 |
| 漢字一字の背面印刷（`/research`の`kanjiChar`→Canvas生成→Tシャツ`sub_materials`） | `worker/index.js` `normalizeKanjiChar()` / `frontend/index.html` `generateKanjiTexture()` | 稼働中 |
| Bluesky Bot投稿（毎平日19:00 JST） | `worker/bluesky-bot.js` `runBot()` | 稼働中 |
| Bot投稿完了のDiscord通知（テーマ・プロンプト全文・画像ソース・毛柄・性格・感情・食べ物アクション含む） | `worker/bluesky-bot.js` `notifyDiscord()` | 稼働中 |
| SUZURIグッズ登録（4商品: Tシャツ・ステッカー・缶バッジ・アクキー） | `worker/suzuri.js` | 稼働中 |
| ボット画像SUZURI登録を初回訪問者ブラウザに委譲（2048px高品質・重複防止） | `frontend/index.html` `createSuzuriFromImage()` `worker/index.js` | 稼働中 |
| ウォーターマーク合成（Canvas、フロントエンド側） | `frontend/index.html` `applyWatermark()` | 稼働中 |
| fal.ai ESRGAN 2xアップスケーリング（Queue API + `ctx.waitUntil()`方式） | `worker/fal.js` `worker/index.js` | 稼働中 |
| `/meta/:id`ポーリングエンドポイント（フロント60秒ポーリング） | `worker/index.js` | 稼働中 |
| `/hires/:id`エンドポイント（R2高解像度画像をSUZURIに渡す） | `worker/index.js` | 稼働中 |
| `/thumb/:id`エンドポイント（R2画像バイナリ直接配信・ギャラリー用） | `worker/index.js` | 稼働中 |
| ボット作品ギャラリー（14日間・SUZURIリンク有効分・初回閲覧者がバックグラウンドでSUZURI登録） | `frontend/index.html` | 稼働中 |
| RSSフィード（直近14日のボット作品・サムネイル画像付き） | `worker/index.js` | 稼働中 |
| `/resume-hires/:id`安全網エンドポイント（60秒超過時のフォールバック） | `worker/index.js` | 稼働中 |
| fal.ai運用イベントのDiscord通知（403・FAILED・タイムアウト・20MB超） | `worker/fal.js` `worker/index.js` | 稼働中 |
| R2ストレージ（14日保持・Cron起動時クリーンアップ） | `worker/r2-storage.js` | 稼働中 |
| レート制限（`/generate`: IP 3回/日・グローバル 50回/日） | `worker/index.js` `checkRateLimit()` | 稼働中 |

### 主要な定数値（変更時は実測データで根拠を示すこと）

| 定数 | 値 | 根拠 |
| --- | --- | --- |
| `RATE_LIMITS.generate.perIp` | 3回/日 | API費用制御 |
| `RATE_LIMITS.generate.global` | 50回/日 | API費用制御 |
| `_twoPhaseRace` の `priorityMs` | 12,000ms | Gemini最大10203ms（実測）に余裕を持たせた値 |
| fal.aiポーリング間隔 × 回数 | 5秒 × 3回（計15秒） | Queue API方式のwall-clock予算内で完了するよう設計 |
| フロントポーリング上限 | 5秒 × 12回（60秒） | fal.ai通常完了時間（~20秒）の3倍の余裕 |
| Bluesky画像上限 | 976,000 bytes | API上限1,000,000bytesに24KB余裕 |
| SUZURIサイズ上限チェック | 20,000,000 bytes | SUZURI APIの20MB制限 |

### APIエンドポイント一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/research` | 記念日テキスト + visualHint取得（10回/IP/日） |
| POST | `/generate` | 画像生成（3回/IP/日・50回/グローバル/日） |
| POST | `/suzuri-create` | ウォーターマーク済み画像でSUZURI商品登録 |
| GET | `/image/:id` | R2保存画像 + メタデータ取得 |
| GET | `/meta/:id` | R2メタデータのみ（ポーリング用軽量） |
| GET | `/hires/:id` | R2高解像度画像（SUZURI向け安定URL） |
| GET | `/thumb/:id` | R2画像をバイナリ直接返却（ギャラリーサムネイル用） |
| GET | `/rss.xml` | RSSフィード（直近14日・サムネイル付き・1時間キャッシュ） |
| GET | `/resume-hires/:id` | fal.ai完了確認 + SUZURI登録（安全網） |
| GET | `/proxy-image?url=...` | Pollinations.aiのCORSプロキシ |

### 必要なシークレット

```bash
wrangler secret put GEMINI_API_KEY           # 必須
wrangler secret put BLUESKY_IDENTIFIER       # 必須（nyanmusu.bsky.social）
wrangler secret put BLUESKY_APP_PASSWORD     # 必須
wrangler secret put DISCORD_WEBHOOK_URL      # 必須（通知・監視用）
wrangler secret put BYPASS_TOKEN             # 開発用（レート制限バイパス）
wrangler secret put SUZURI_API_KEY           # SUZURIグッズ機能（任意）
wrangler secret put FAL_KEY                  # fal.aiアップスケーリング（任意）
```

---

## テスト制約

> Claudeはサンドボックス制限で外部APIに接続できない。
> `scripts/health-check.js`は直接実行不可。テスト結果はユーザーにGitHub ActionsタブのURLで確認を依頼する。

`npm test`（= `scripts/test-bot.mjs`）は外部API不要でローカル実行可能。

---

## 詳細ルール

- コーディング規約・Markdown執筆ルール → `.claude/rules/coding.md`
- テスト方針・診断手順 → `.claude/rules/testing.md`
- Gitワークフロー・デプロイ手順 → `.claude/rules/git-workflow.md`
- システム設計・API仕様・将来拡張・過去バグ詳細 → `.claude/rules/architecture.md`
