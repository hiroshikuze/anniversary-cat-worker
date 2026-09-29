# SNSセール告知バナーの試作（Gemini×Satori分業方式）

SUZURIセール時にSNSへ載せる告知画像を、Geminiの絵とSatoriの正確な文字・実物グッズ画像で合成する試作一式。**本番コードではない**（`npm test`・CI・Workerのデプロイ対象外）。方針・経緯・残課題は`.claude/future-ideas.md`の「C. Gemini×Satori分業方式」を参照。

## ファイル

| ファイル | 内容 |
| --- | --- |
| `compose.mjs` | 合成スクリプト。2026-09「秋のビッグセール」パターン1（ポップ・賑やか。ユーザー評価「かなり魅力的になった」）の最終版をそのまま保存したもの |
| `compose-pattern2.mjs` | 同パターン2（秋の季節感・木の板の背景）の最終版。文字の書式をGeminiの草案の画像に寄せた版 |
| `compose-aistudio.mjs` | **2026-09-29に実際にBluesky/Mastodonへ投稿した版**。Google AI Studio（Nano Banana）の背景を使い、パターン1の方向性で組み直したもの。次回はまずこれを土台にする |
| `fetch-assets.sh` | フォントとSUZURIグッズ画像を作業ディレクトリに集める |
| `README.md` | このファイル。手順とGeminiへの指示文 |

素材（背景・グッズ画像・フォント約12MB）はコミットしない。毎回`fetch-assets.sh`で取得する。

## 手順（次回はこの順で進める・2026-09-29に一通り成功した流れ）

ユーザーから「セール告知を作って」と頼まれたら、この順で進める。**太字**はユーザーにお願いする作業。

| # | 作業 | 担当 | 目安 |
| --- | --- | --- | --- |
| 1 | セール記事で**対象商品と値引き額**を確かめる（`curl https://suzuri.jp/media/category/news/`から記事URLを探し、本文を取得。このショップの4商品のうちどれが対象か） | Claude | 数分 |
| 2 | イラストに使うBot作品（`bot/YYYY-MM-DD`）を決め、草案用の指示文を渡す（下記「Geminiへの指示文」の「AI Studio用」を、セール名・期間・対象商品に書き換える） | Claude | - |
| 3 | **Google AI Studioで草案を作り、同じ会話で背景を作り、2枚をチャットに貼る**（設定は下記「Google AI Studioでの作り方」） | ユーザー | 数分 |
| 4 | `fetch-assets.sh`で素材を集め、`compose-aistudio.mjs`をコピーして座標・文言・色を今回の草案に合わせて書き換え、合成してチャットに見せる。直しの指示はここで繰り返す（1回数秒） | Claude | 数往復 |
| 5 | JPEGに変換し、投稿文（Bluesky・Mastodon・X等用）と代替テキストを用意する（下記「投稿文の例」） | Claude | - |
| 6 | `tmp-sale-announcement/<日付-内容>/`に`DRY_RUN`付きで置いてpush（お試し実行）→ Discordにプレビューが届く | Claude | 1分 |
| 7 | **Discordのプレビューを確認し「投稿して」と伝える** | ユーザー | - |
| 8 | お試し用フォルダを消し、`DRY_RUN`なしの新しいフォルダを追加してpush → Bluesky・Mastodonに投稿され、Discordに結果とX等用の本文が届く。公開APIで1件ずつ投稿されたか確認し、フォルダを削除する | Claude | 1分 |
| 9 | **DiscordからX・Instagram等へ手動で転載する** | ユーザー | - |
| 10 | セール終了の翌日に反響（いいね・リポスト）を確認する予約を入れる（Claude Code Remoteの`send_later`。確認内容は`.claude/future-ideas.md`の「C.」参照） | Claude | - |

### 各ステップの補足

- **素材の取得（手順4）**

  ```bash
  npm ci   # 初回のみ（@cf-wasm/satori・@resvg/resvg-wasmを使う）
  bash .claude/prototypes/sale-banner/fetch-assets.sh <作業ディレクトリ> bot/YYYY-MM-DD
  cp <Geminiの背景画像> <作業ディレクトリ>/bg.jpg
  node .claude/prototypes/sale-banner/compose-aistudio.mjs <作業ディレクトリ>   # → <作業ディレクトリ>/banner.png
  ```

  作業ディレクトリはClaude Codeセッションのスクラッチパッドを使う。背景がWebP形式で届いた場合は、PillowでJPEGに変換する（`pip install pillow`後、`Image.open("bg.webp").convert("RGB").save("bg.jpg", quality=95)`）。resvgはWebPを読めない
- **書式の合わせ方（手順4）**: 文字の色・縁取り・アーチの有無は、Geminiの草案の画像をClaudeが直接見て合わせる（配置情報のJSONは頼まない。下記「配置情報（JSON）の信頼度」参照）
- **背景が期待どおりでない場合（手順4）**: 描き直されて文字の余白がない、不要な小物がある、などは合成側で直せる（下記「Google AI Studioでの作り方」の「背景は同じ会話で頼んでも描き直された」「不要な小物の手動消去」参照）
- **JPEG変換（手順5）**: PNGは約1.3MBでBlueskyの上限1MBを超える。`quality=92`で約300KBになった
- **投稿の仕組み（手順6〜8）**: `.github/workflows/sale-announcement.yml`＋`scripts/post-sale-announcement.mjs`。フォルダ構成・検証ルール・注意点は`.claude/rules/git-workflow.md`の「SNSセール告知の自動投稿とDiscord送信」参照。**同じファイルを別フォルダへ入れ直しても「追加」として検出される**（`--no-renames`対応済み）
- **必要なシークレット**: GitHub Actionsに`BLUESKY_*`・`MASTODON_*`・`DISCORD_WEBHOOK_URL`が登録済み（2026-09-29時点）。Health CheckのMastodon認証が失敗していたら、`MASTODON_INSTANCE_URL`が`https://mastodon.social`（パスなし）になっているか確認してもらう

## 書き換える箇所

**`compose-aistudio.mjs`（次回の土台）で書き換える箇所**:

| 箇所 | 2026-09-29の値 | 書き換えの目安 |
| --- | --- | --- |
| `PANEL` | `#EFC69E` | 背景のパネル色。Pillowで背景の数か所を実測して決める |
| `cover` | パネル内側（x100〜930・y110〜910、1024px基準）を単色で塗る | 背景の場面が文字の余白を占めていなければ、`cover`と`scene`は外して背景をそのまま使う |
| `scene`（`crop()`）・`SC` | 場面（x95〜925・y135〜905）を66%に縮小して下寄せ | 背景の場面の位置に合わせる |
| `title` | SUZURI／秋のビッグセール＋開催中！ | セール名 |
| `discountParts` | 最大・1,000・円OFF | 割引額 |
| `deadline` | 10/4（日）23:59まで | `worker/sale.js`の`endDisplay`と一致させる |
| `products` | Tシャツ1,000円OFF（オレンジの台座）・ステッカー100円OFF（緑の台座） | **セール対象の商品だけ**。背景が中間色なら台座は不要 |
| `notice`・`shop` | 限定デザインは14日間だけ！・ショップ名とURL | 帯の文言 |

**`compose.mjs`（パターン1の試作）で書き換える箇所**:

| 箇所 | 2026-09の値 | 書き換えの目安 |
| --- | --- | --- |
| `title` | `SUZURI 秋のビッグセール` | セール名 |
| `widths` | 英大文字0.72・「I」0.4・小書き文字0.8 | アーチの文字間が不自然なら文字ごとの幅係数を足す |
| `size`・`R`・`cy` | 60・1300・62 | 見出しの大きさ・カーブの強さ・高さ。猫と重ならない位置にする |
| `kaisai` | 右下に「開催中！」 | 見出しが1行に収まらないときの2行目 |
| `discountParts` | 最大・1,000・円・OFF | 割引額 |
| `discount`の`top` | `478 - 130` | 締切リボンで「,」の尾が隠れないよう間隔を空ける |
| `deadline` | `10/4（日）23:59まで` | 締切（`worker/sale.js`の`endDisplay`と一致させる） |
| `notice` | 限定デザインは14日間だけ！ | 帯の文言 |
| `products` | Tシャツ1,000円OFF・ステッカー100円OFF | **セール対象の商品だけ**を載せる。台座の色も背景に合わせる |
| `bg.jpg`のサイズ | 1024×1024を1080×1080に拡大 | Geminiの出力サイズに合わせる |

## 配置情報（JSON）の信頼度（2026-09・2パターンの試作で判明）

| 項目 | 信頼度 | 実例 |
| --- | --- | --- |
| 要素の位置（中心座標） | おおむね参考になる | ただし猫・他要素との重なりは考慮されていない |
| 文字の大きさ | 参考程度 | 1行に収まらない大きさを指定してきた（見出し58px×1行、割引額110px×1行を420px幅の楕円に） |
| 色・縁取りの向き | **当てにならない** | パターン2で「白文字＋焦げ茶の縁取り」とされたが、草案は逆の「焦げ茶の文字＋白の縁取り」だった |
| アーチ・縦積み等の配置 | **当てにならない** | パターン2の見出しのアーチ、割引額の「最大」縦書き・「円／OFF」縦積みが情報に含まれていなかった |
| グッズの位置 | 含まれない | 2パターンとも出てこなかった |

→ 配置情報は「どの文言をどのあたりに置くか」の目安にとどめ、書式はClaudeが草案の画像を見て合わせる。フォントは草案の字形そのものは再現できないため、系統の近いものを選ぶ（パターン2の極太丸ゴシック → Zen丸ゴシック Black）。

## 背景について（2026-09・2パターンの試作で判明）

- 「文字と商品を消して」と頼んでも、Geminiは消すのではなく**似た雰囲気で描き直す**ことがある。パターン2では、クリーム色の紙＋下半分の木の棚だった草案が、画面全体が木の板の背景になった。草案と背景の構図が一致する前提で配置を決めない
- 背景が白いと白いTシャツが溶ける（パターン1は色付きの円の台座で対処）。背景が中間色（パターン2の木の板）なら台座なしで映える

## Google AI Studioでの作り方（2026-09-29）

- **モデル**: 画像生成モデル（Nano Banana 2＝`gemini-3.1-flash-image`、Nano Banana Pro、Nano Banana＝`gemini-2.5-flash-image`）はすべて「Paid」で、Playgroundで使うにはGoogle AI PlanかAPIキーが必要だった。2026-09は**Nano Banana＋APIキー**で作成（一覧表示の料金は画像1枚$0.039）
- **設定**: Aspect ratio 1:1。Temperatureは草案1、背景の編集は0.5前後。Nano BananaにはOutput format・Resolution・Thinking levelの項目がない
- **添付**: Botのイラスト（画風の参考）と、実物のTシャツ・ステッカーの画像
- **結果**: 草案の文字は崩れていた（「秋のビッグセーレ控哻」「14日間なせ」、TシャツがSALE 100円OFF）。合成で文字を正確に描き直すので問題にはならない
- **背景は同じ会話で頼んでも描き直された**: 猫と店の場面が画面いっぱいになり、文字を置く余白がなかった。`compose-aistudio.mjs`では、パネルを単色（`#EFC69E`・背景から実測）で塗り直し、場面だけを切り出して66%に縮小・下寄せして、上半分を文字、左右をグッズに使った。塗り直した部分と元の水彩の質感の境目がうっすら見える。次回は背景用の指示文に「中央上部と左右に広い余白を残す」と入れるとよい見込み（未検証）
- **不要な小物の手動消去**: 右下に1枚だけ描かれた硬貨を、ユーザーの判断で消した。反対側（左下）のパネルの角の形を左右反転して「パネル内かどうか」を判定し、パネル内は左隣のパネル、外側は硬貨より下のオレンジの縁から色を写した（左右で縁の色味が違うため、角を丸ごと貼る方法は色が浮いた）。この手順は位置依存の手作業で、毎回は使えない

## 投稿文の例（2026-09-29に投稿したもの）

リンク先はショップのトップではなく、イラストのTシャツの商品ページ（R2メタの`products[].sampleUrl`）にする。

```text
SUZURI「秋のビッグセール」開催中🍁
10/4（日）23:59まで、スタンダードTシャツが1点1,000円引き、ステッカーが1点100円引きです🐱

招き猫の日（9/29）のデザインもセール対象！
https://suzuri.jp/nyanmusu/21047599/t-shirt/s/white

#にゃんバーサリー #SUZURI #猫 #AIart #招き猫の日
```

Mastodonは同じ内容を英語→日本語の順に並べ、ハッシュタグに`#Nyaniversary #cat`を加えた。

**Instagramはハッシュタグが1投稿5つまで**（2025年12月に30個から変更。公式ページは未確認で、Social Media Today等の複数の記事による。超えても投稿は消えないが表示範囲が狭まる）。本文のURLはリンクにならないため「プロフィールのリンクから」と誘導する。2026-09の例: `#猫 #招き猫 #SUZURI #AIart #にゃんバーサリー`代替テキストは「SUZURI秋のビッグセールの告知画像。〈イラストの説明〉と、Tシャツ（1,000円OFF）・ステッカー（100円OFF）の商品画像。最大1,000円OFF、10月4日（日）23時59分まで。にゃんバーサリー suzuri.jp/nyanmusu」の形。

## Satoriでの描き方のメモ

- **アーチ状の見出し**: 1文字ずつ`transform: rotate()`して円弧上に絶対配置する
- **グラデーション＋縁取り**: `backgroundClip: "text"`と`textShadow`は同じ要素で併用できない。縁取り層（焦げ茶・白）とグラデーション層を同じ位置に3枚重ねる。縁取りの太さは`textShadow`を円周16方向に並べて出す
- **切り込みリボン**: CSSの`border`で作る三角形はSatoriで描けない。SVGを`data:`URIの`<img>`として敷く
- **白Tシャツ**: 白背景に溶けるため、色付きの円＋白フチ＋影の台座に載せる。販売していない色のTシャツ画像は使わない

## Geminiへの指示文

### 1. 完成図の草案（4パターン）

2026-09に実際に使った指示文。`## Sale information`と`## Direction of each pattern`をセールごとに書き換える。Botのイラストを1枚添付すると画風が近づく。

```text
Please create 4 separate promotional images for a social media post (Bluesky / Mastodon / X / Instagram) announcing a SUZURI sale for my cat illustration goods shop. Label them clearly as Pattern 1, Pattern 2, Pattern 3, and Pattern 4 so I can give feedback by number.

## About the shop
- Shop name: にゃんバーサリー (Nyaniversary)
- Every weekday, an AI creates a soft, kawaii watercolor-style cat illustration themed on "today's anniversary" in Japan, and each illustration becomes limited-time merchandise on SUZURI (a Japanese print-on-demand marketplace).
- Each design is sold for only 14 days, then it disappears forever.
- Character style: gentle watercolor cats, pastel colors, heartwarming. (If I attached an illustration, please use it as the actual artwork / character reference.)

## Sale information (must appear accurately)
- Sale: SUZURI Autumn Big Sale (秋のビッグセール)
- Discount: up to ¥1,000 OFF (最大1,000円OFF)
- Period: until October 4 (Sun) 23:59 JST (10月4日（日）23:59まで)
- Products: T-shirt, sticker, can badge, acrylic keychain
- Shop URL: suzuri.jp/nyanmusu

## Required elements (layout and presentation are completely up to you)
1. The discount amount ("最大1,000円OFF") as the most eye-catching element
2. The deadline ("10/4（日）まで")
3. The shop name "にゃんバーサリー"
4. At least two of the actual products (T-shirt, sticker, can badge, acrylic keychain) with the cat illustration printed on them
5. A sense of "limited time / only now" (the 14-day limited designs + sale deadline)

## Quality bar
- It should feel as cute and polished as popular character-goods brands' sale posts (e.g., mofusand's SUZURI sale announcements) — not like a plain text notice or a template.
- Use playful, characterful Japanese typography rather than a plain business-style font.
- Strong visual hierarchy and color contrast so the discount is readable at thumbnail size on a smartphone timeline.
- Products should look appealing and realistic enough to make people want to buy, not like flat hand-drawn outlines.
- All Japanese text must be spelled correctly with no garbled characters. Do not invent other prices, dates, or products.
- Square format (1:1).

## Direction of each pattern (interpret freely)
- Pattern 1: Pop & energetic — a lively, festive sale feel that stops the scroll.
- Pattern 2: Autumn seasonal — cozy autumn atmosphere (leaves, harvest moon, warm tones) blended with the sale.
- Pattern 3: Cat-as-storyteller — the cat character itself is actively promoting the sale in some playful way.
- Pattern 4: Stylish & minimal — a refined, boutique-like look that still makes the discount unmistakable.
```

**注意**: 2026-09はこの指示文の`Products`に4商品すべてを書いてしまった（実際の対象はTシャツとステッカーのみ）。次回は対象商品だけを書く。

### AI Studio用（2026-09-29に使用・パターン1の方向性）

草案用。`Text that must appear exactly`・`Products`をセールごとに書き換え、**対象商品だけ**を書く。Botのイラストと、`fetch-assets.sh`で取った実物のグッズ画像（対象商品のみ）を添付する。

```text
Create a square (1:1) promotional image for a social media post announcing a SUZURI sale for my cat illustration goods shop "にゃんバーサリー".

Style: pop & energetic, festive, stops the scroll. Soft kawaii watercolor cat character (use the attached illustration as the character and art reference). Autumn touches are welcome.

Text that must appear exactly (Japanese, no other text):
- SUZURI 秋のビッグセール 開催中！
- 最大1,000円OFF
- 10/4（日）23:59まで
- 限定デザインは14日間だけ！
- にゃんバーサリー　suzuri.jp/nyanmusu

Products: show ONLY these two items, using the attached product photos as they are (do not redesign them, do not add any other products):
- T-shirt (1,000円OFF)
- Sticker (100円OFF)
Give the two products plenty of space so they are large and clearly visible.

Quality bar: as cute and polished as popular character-goods brands' sale posts (e.g. mofusand). Playful, characterful Japanese typography. Strong contrast so the discount is readable at smartphone thumbnail size.
```

背景用（同じ会話で続けて。Temperatureを0.5前後に下げてから送る）。2026-09は描き直されて文字の余白がなくなったため、次回は末尾の1文（余白の指定）を足して試す（未検証）。

```text
Edit the image you just made. Remove ALL text and ALL product items (the T-shirt, the sticker, price tags, ribbons and banners that contain text).
Keep everything else exactly as it is, in the same position and size: the cat character, confetti, leaves, decorations and background.
Fill the removed areas naturally with the surrounding background. Do not redraw or rearrange the scene. Do not add anything new.
Keep the upper half and the left and right sides clear enough to place large text and product photos later.
```

### 2. 文字と商品を消した背景

**2026-09にユーザーが実際に入力した指示文は記録されていない。** 以下はClaudeが再構成した案。実際に使った文面がわかれば差し替えること。

```text
From the attached image, remove ALL text (titles, prices, dates, shop name, URL, banners and ribbons that contain text) and ALL merchandise items (T-shirts, stickers, badges, keychains, bags, etc.).
Keep everything else exactly as it is: the cat character, confetti, leaves, decorations, and the background texture.
Fill the removed areas naturally with the surrounding background so no smudges or outlines remain.
Do not add any new text, products, or objects. Keep the same size and aspect ratio.
```

### 3. 文字の配置情報（JSON）

**実際に入力した指示文は記録されていない**（再構成案）。2026-09にGeminiが返したJSONは下記「2026-09の配置情報」に保存した。

```text
For the attached draft image, output the layout of every text element as JSON so that I can re-draw the text with another tool.
For each element include: id, the exact text, center position (x, y) on a 1080x1080 canvas, font style description, font size in px, weight, fill color (or gradient start/end), stroke colors and widths, and any background shape (ribbon, bar) with its color and size.
Also include the position and size of each product item as a separate list.
Output only the JSON.
```

2026-09に返ってきたJSONにはグッズの位置が含まれていなかったため、再構成案ではグッズも出すよう指示を足している（効果は未検証）。

### 2026-09の配置情報（Geminiが返したもの）

`compose.mjs`はこれを基準にしたうえで、重なりを手で補正している。補正内容は`.claude/future-ideas.md`の「Geminiの配置情報をそのまま使えなかった点」を参照。

```json
{
  "canvas": { "width": 1080, "height": 1080, "unit": "px", "color_space": "RGB" },
  "text_elements": [
    {
      "id": "header_title",
      "text": "SUZURI 秋のビッグセール 開催中！",
      "position": { "x": 540, "y": 140, "anchor": "center" },
      "font": { "family": "Pop / Maru-Gothic (手書き感のあるポップ体・丸ゴシック)", "size_px": 58, "weight": "bold", "style": "arc / slightly curved (緩やかなアーチ配置)" },
      "color": { "text": "#3E2723", "highlight_accent": "#E64A19", "stroke": "#FFFFFF", "stroke_width_px": 6 }
    },
    {
      "id": "main_discount",
      "text": "最大 1,000円 OFF",
      "position": { "x": 540, "y": 510, "anchor": "center" },
      "font": { "family": "Impact / Heavy Pop Font (極太ポップ体)", "size_px": 120, "weight": "black" },
      "color": {
        "fill_gradient": { "type": "vertical", "start": "#FFEB3B", "end": "#FF3D00" },
        "stroke_primary": "#FFFFFF", "stroke_primary_width_px": 12,
        "stroke_secondary": "#4E260E", "stroke_secondary_width_px": 20,
        "shadow": "rgba(0, 0, 0, 0.25)"
      }
    },
    {
      "id": "deadline_badge",
      "text": "10/4（日）まで",
      "position": { "x": 540, "y": 620, "anchor": "center" },
      "background_ribbon": { "color": "#4A2710", "shape": "ribbon_banner", "padding_px": [12, 40] },
      "font": { "family": "Rounded Sans-Serif (丸ゴシック)", "size_px": 42, "weight": "bold" },
      "color": { "text": "#FFFFFF" }
    },
    {
      "id": "notice_banner",
      "text": "限定デザインは14日間だけ！今すぐゲット！",
      "position": { "x": 540, "y": 860, "anchor": "center" },
      "background_bar": { "color": "#E65100", "height_px": 80 },
      "font": { "family": "Rounded Sans-Serif (丸ゴシック)", "size_px": 36, "weight": "bold" },
      "color": { "text": "#FFFFFF" }
    },
    {
      "id": "shop_info",
      "text": "にゃんバーサリー    suzuri.jp/nyanmusu",
      "position": { "x": 540, "y": 950, "anchor": "center" },
      "font": { "family": "Cute Hand-drawn / Maru-Gothic (かわいらしい丸ゴシック)", "size_px": 32, "weight": "bold" },
      "color": { "text": "#212121" }
    }
  ]
}
```
