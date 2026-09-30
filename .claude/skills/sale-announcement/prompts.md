# SNSセール告知: Geminiへの指示文

手順は`SKILL.md`、Google AI Studioの設定は`reference.md`の「Google AI Studioでの作り方」を参照。

## 1. 完成図の草案（4パターン）

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

## AI Studio用（2026-09-29に使用・パターン1の方向性）

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

## 2. 文字と商品を消した背景

**2026-09にユーザーが実際に入力した指示文は記録されていない。** 以下はClaudeが再構成した案。実際に使った文面がわかれば差し替えること。

```text
From the attached image, remove ALL text (titles, prices, dates, shop name, URL, banners and ribbons that contain text) and ALL merchandise items (T-shirts, stickers, badges, keychains, bags, etc.).
Keep everything else exactly as it is: the cat character, confetti, leaves, decorations, and the background texture.
Fill the removed areas naturally with the surrounding background so no smudges or outlines remain.
Do not add any new text, products, or objects. Keep the same size and aspect ratio.
```

## 3. 文字の配置情報（JSON）

**実際に入力した指示文は記録されていない**（再構成案）。2026-09にGeminiが返したJSONは下記「2026-09の配置情報」に保存した。

```text
For the attached draft image, output the layout of every text element as JSON so that I can re-draw the text with another tool.
For each element include: id, the exact text, center position (x, y) on a 1080x1080 canvas, font style description, font size in px, weight, fill color (or gradient start/end), stroke colors and widths, and any background shape (ribbon, bar) with its color and size.
Also include the position and size of each product item as a separate list.
Output only the JSON.
```

2026-09に返ってきたJSONにはグッズの位置が含まれていなかったため、再構成案ではグッズも出すよう指示を足している（効果は未検証）。

## 2026-09の配置情報（Geminiが返したもの）

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
