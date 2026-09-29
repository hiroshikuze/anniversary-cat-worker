---
name: sale-announcement
description: SUZURIのセール開催時に、SNS用の告知画像（Geminiの絵＋Satoriで正確な文字と実物グッズ画像を合成）を作り、GitHub Actions経由でBluesky・Mastodonへ投稿し、X・Instagram等への転載用テキストと結果をDiscordへ送る。「セール告知を作って」「セールのバナー」「SNSでセールを宣伝」などと頼まれたときに使う。
---

# SNSセール告知（Gemini×Satori分業方式）

SUZURIセール時にSNSへ載せる告知画像を、Geminiの絵とSatoriの正確な文字・実物グッズ画像で合成し、投稿まで行う。2026-09-29に「秋のビッグセール」で一通り成功した流れ。経緯・過去の結果は`.claude/future-ideas.md`の「C. Gemini×Satori分業方式」、投稿の仕組みは`.claude/rules/git-workflow.md`の「SNSセール告知の自動投稿とDiscord送信」を参照。

合成スクリプト類は**本番コードではない**（`npm test`・CI・Workerのデプロイ対象外）。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `compose.mjs` | 合成スクリプト。2026-09「秋のビッグセール」パターン1（ポップ・賑やか。ユーザー評価「かなり魅力的になった」）の最終版をそのまま保存したもの |
| `compose-pattern2.mjs` | 同パターン2（秋の季節感・木の板の背景）の最終版。文字の書式をGeminiの草案の画像に寄せた版 |
| `compose-aistudio.mjs` | **2026-09-29に実際にBluesky/Mastodonへ投稿した版**。Google AI Studio（Nano Banana）の背景を使い、パターン1の方向性で組み直したもの。次回はまずこれを土台にする |
| `fetch-assets.sh` | フォントとSUZURIグッズ画像を作業ディレクトリに集める |
| `SKILL.md` | このファイル。手順 |
| `reference.md` | スクリプトの書き換え箇所・配置情報の信頼度・背景の扱い・AI Studioの設定・投稿文の例・Satoriの描き方 |
| `prompts.md` | Geminiへの指示文（草案・背景・配置情報）と2026-09の配置情報の実例 |

素材（背景・グッズ画像・フォント約12MB）はコミットしない。毎回`fetch-assets.sh`で取得する。

## 手順（次回はこの順で進める・2026-09-29に一通り成功した流れ）

ユーザーから「セール告知を作って」と頼まれたら、この順で進める。**太字**はユーザーにお願いする作業。

| # | 作業 | 担当 | 目安 |
| --- | --- | --- | --- |
| 1 | セール記事で**対象商品と値引き額**を確かめる（`curl https://suzuri.jp/media/category/news/`から記事URLを探し、本文を取得。このショップの4商品のうちどれが対象か） | Claude | 数分 |
| 2 | イラストに使うBot作品（`bot/YYYY-MM-DD`）を決め、草案用の指示文を渡す（`prompts.md`の「AI Studio用」を、セール名・期間・対象商品に書き換える） | Claude | - |
| 3 | **Google AI Studioで草案を作り、同じ会話で背景を作り、2枚をチャットに貼る**（設定は`reference.md`の「Google AI Studioでの作り方」） | ユーザー | 数分 |
| 4 | `fetch-assets.sh`で素材を集め、`compose-aistudio.mjs`をコピーして座標・文言・色を今回の草案に合わせて書き換え、合成してチャットに見せる。直しの指示はここで繰り返す（1回数秒） | Claude | 数往復 |
| 5 | JPEGに変換し、投稿文（Bluesky・Mastodon・X等用）と代替テキストを用意する（`reference.md`の「投稿文の例」） | Claude | - |
| 6 | `tmp-sale-announcement/<日付-内容>/`に`DRY_RUN`付きで置いてpush（お試し実行）→ Discordにプレビューが届く | Claude | 1分 |
| 7 | **Discordのプレビューを確認し「投稿して」と伝える** | ユーザー | - |
| 8 | お試し用フォルダを消し、`DRY_RUN`なしの新しいフォルダを追加してpush → Bluesky・Mastodonに投稿され、Discordに結果とX等用の本文が届く。公開APIで1件ずつ投稿されたか確認し、フォルダを削除する | Claude | 1分 |
| 9 | **DiscordからX・Instagram等へ手動で転載する** | ユーザー | - |
| 10 | セール終了の翌日に反響（いいね・リポスト）を確認する予約を入れる（Claude Code Remoteの`send_later`。確認内容は`.claude/future-ideas.md`の「C.」参照） | Claude | - |

### 各ステップの補足

- **素材の取得（手順4）**

  ```bash
  npm ci   # 初回のみ（@cf-wasm/satori・@resvg/resvg-wasmを使う）
  bash .claude/skills/sale-announcement/fetch-assets.sh <作業ディレクトリ> bot/YYYY-MM-DD
  cp <Geminiの背景画像> <作業ディレクトリ>/bg.jpg
  node .claude/skills/sale-announcement/compose-aistudio.mjs <作業ディレクトリ>   # → <作業ディレクトリ>/banner.png
  ```

  作業ディレクトリはClaude Codeセッションのスクラッチパッドを使う。背景がWebP形式で届いた場合は、PillowでJPEGに変換する（`pip install pillow`後、`Image.open("bg.webp").convert("RGB").save("bg.jpg", quality=95)`）。resvgはWebPを読めない
- **書式の合わせ方（手順4）**: 文字の色・縁取り・アーチの有無は、Geminiの草案の画像をClaudeが直接見て合わせる（配置情報のJSONは頼まない。`reference.md`の「配置情報（JSON）の信頼度」参照）
- **背景が期待どおりでない場合（手順4）**: 描き直されて文字の余白がない、不要な小物がある、などは合成側で直せる（`reference.md`の「Google AI Studioでの作り方」の「背景は同じ会話で頼んでも描き直された」「不要な小物の手動消去」参照）
- **JPEG変換（手順5）**: PNGは約1.3MBでBlueskyの上限1MBを超える。`quality=92`で約300KBになった
- **投稿の仕組み（手順6〜8）**: `.github/workflows/sale-announcement.yml`＋`scripts/post-sale-announcement.mjs`。フォルダ構成・検証ルール・注意点は`.claude/rules/git-workflow.md`の「SNSセール告知の自動投稿とDiscord送信」参照。**同じファイルを別フォルダへ入れ直しても「追加」として検出される**（`--no-renames`対応済み）
- **必要なシークレット**: GitHub Actionsに`BLUESKY_*`・`MASTODON_*`・`DISCORD_WEBHOOK_URL`が登録済み（2026-09-29時点）。Health CheckのMastodon認証が失敗していたら、`MASTODON_INSTANCE_URL`が`https://mastodon.social`（パスなし）になっているか確認してもらう
