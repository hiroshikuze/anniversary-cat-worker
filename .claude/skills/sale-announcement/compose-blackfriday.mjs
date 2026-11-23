// SNSセール告知バナー: 2026-11「SUZURIのブラックフライデー」開催予告版（compose-aistudio.mjsを土台に書き換え・本番コードではない）
// 2026-11-23にBluesky/Mastodonへ投稿した版。対象商品4点（2×2の白いカード＋金の値引きバッジ）・黒地の背景向け。
// 作業ディレクトリに必要なもの: bg.jpg（Geminiで文字・グッズ・猫をすべて消した背景）・t-shirt.png・acrylic-keychain.png・can-badge.png・sticker.png・fonts/*.ttf
//   node .claude/skills/sale-announcement/compose-blackfriday.mjs <作業ディレクトリ> [yokoku|kaisai]
//   yokoku（省略時）→ banner.png（開催予告） / kaisai → banner-kaisai.png（開催中）
// 背景: Geminiで文字・グッズ・猫をすべて消した黒地（金の筆の帯＋紅葉・星）。草案の配置・書式に合わせて文字を描き直す。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const NM = new URL("../../../node_modules", import.meta.url).pathname; // リポジトリ直下のnode_modules（要npm ci）。作業ディレクトリへコピーしたら絶対パスに書き換える（reference.md参照）
const { satori } = await import(`${NM}/@cf-wasm/satori/dist/node.js`);
const resvg = await import(`${NM}/@resvg/resvg-wasm/index.mjs`);
await resvg.initWasm(readFileSync(`${NM}/@resvg/resvg-wasm/index_bg.wasm`));

const S = resolve(process.argv[2] ?? ".") + "/";
const MODE = process.argv[3] ?? "yokoku"; // yokoku=開催予告 / kaisai=開催中
const W = 1080, K = W / 1024; // 背景は1024px
const fonts = [
  { name: "Mochiy", data: readFileSync(`${S}fonts/MochiyPopOne-Regular.ttf`), weight: 400 },
  { name: "ZenMaru", data: readFileSync(`${S}fonts/ZenMaruGothic-Bold.ttf`), weight: 700 },
  { name: "ZenMaru", data: readFileSync(`${S}fonts/ZenMaruGothic-Black.ttf`), weight: 900 },
];
const uri = (f, mime = "image/png") => `data:${mime};base64,${readFileSync(S + f).toString("base64")}`;
const h = (type, style, children) => ({ type, props: { style: { display: "flex", ...style }, children } });
const t = (s, style) => h("div", { whiteSpace: "nowrap", ...style }, s);
const ring = (c, w) => Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return `${(Math.cos(a) * w).toFixed(1)}px ${(Math.sin(a) * w).toFixed(1)}px 0 ${c}`;
});
const stroke = (...layers) => layers.flatMap(([c, w]) => ring(c, w)).join(", ");
const BG = uri("bg.jpg", "image/jpeg");
const RED = "#C8201E";
const DARK = "#1E1A18";
const GOLD = "linear-gradient(180deg, #FFF3A8 0%, #F5C842 45%, #C98A12 100%)";

// 塗り（グラデーション）＋縁取りを重ねた文字（Satoriはテキストのstrokeがないため、影の輪で縁取り→上にbackgroundClip:textで塗る）
const layered = (text, base, strokeLayers, fill, box) => h("div", { position: "relative", ...box }, [
  t(text, { ...base, color: strokeLayers[0][0], textShadow: stroke(...strokeLayers) }),
  t(text, { ...base, position: "absolute", left: 0, top: 0, ...fill }),
]);

// 1. 背景
const base = { type: "img", props: { src: BG, width: W, height: W, style: { position: "absolute", left: 0, top: 0 } } };

// ── タイトル（金の帯の上）──
const title = h("div", { position: "absolute", left: 0, top: 30, width: W, justifyContent: "center", alignItems: "flex-end" }, [
  t("SUZURI", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 64, lineHeight: 1, color: "#FFFFFF", textShadow: stroke([DARK, 6]), marginBottom: 6 }),
  t("の", { fontFamily: "Mochiy", fontSize: 46, lineHeight: 1, color: "#FFFFFF", textShadow: stroke([DARK, 5]), margin: "0 6px 10px" }),
  layered("ブラックフライデー", { fontFamily: "Mochiy", fontSize: 78, lineHeight: 1 }, [["#3B2200", 9], ["rgba(0,0,0,0.35)", 13]],
    { backgroundImage: GOLD, backgroundClip: "text", color: "transparent" }, {}),
]);

// ── 金の帯の上: 開催予告タグ＋最大1,000円OFF ──（帯は背景座標でy≈150〜320 → ×K）
const tagText = MODE === "kaisai" ? "開催中！" : "開催予告";
const tag = h("div", { position: "absolute", left: 128, top: 150, transform: "rotate(-4deg)" }, [
  h("div", { background: "#FFF6E0", borderRadius: 10, padding: "4px 18px", border: `4px solid #8A5A12`, boxShadow: "0 4px 10px rgba(0,0,0,0.35)" }, [
    t(tagText, { fontFamily: "Mochiy", fontSize: 34, color: "#7A1A10", lineHeight: 1.15 }),
  ]),
]);
const discountParts = (fill) => [
  t("最大", { fontFamily: "Mochiy", fontSize: 70, lineHeight: 1, marginRight: 4, marginBottom: 12, ...fill }),
  t("1,000", { fontFamily: "Mochiy", fontSize: 132, lineHeight: 1, ...fill }),
  t("円OFF", { fontFamily: "Mochiy", fontSize: 84, lineHeight: 1, marginLeft: 4, marginBottom: 10, ...fill }),
];
const discountRow = (fill) => h("div", { position: "absolute", left: 0, top: 0, width: W, height: 150, justifyContent: "center", alignItems: "flex-end" }, discountParts(fill));
const discount = h("div", { position: "absolute", left: 30, top: 186, width: W, height: 150 }, [
  discountRow({ color: "#5A0A06", textShadow: stroke(["#5A0A06", 11], ["rgba(0,0,0,0.25)", 16]) }),
  discountRow({ color: "#FFFFFF", textShadow: stroke(["#FFFFFF", 6]) }),
  discountRow({ backgroundImage: "linear-gradient(180deg, #F0453A 0%, #C8201E 55%, #8E0F0C 100%)", backgroundClip: "text", color: "transparent" }),
]);

// ── 日付のリボン2本 ──
const ribbon = (children, bg, width) => h("div", { width, height: 62, background: bg, alignItems: "center", justifyContent: "center", borderRadius: 6, border: "3px solid #F5C842", boxShadow: "0 6px 14px rgba(0,0,0,0.45)" }, children);
const dateTxt = (s, size = 32) => t(s, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: size, color: "#FFFFFF", lineHeight: 1 });
const dates = MODE === "kaisai"
  ? h("div", { position: "absolute", left: 0, top: 372, width: W, justifyContent: "center" }, [
      ribbon([dateTxt("12/8（火）23:59まで開催中！", 38)], "linear-gradient(180deg, #D8322A, #A11712)", 640),
    ])
  : h("div", { position: "absolute", left: 0, top: 372, width: W, justifyContent: "center", gap: 18 }, [
      ribbon([dateTxt("11/27（金）12:00スタート！")], "linear-gradient(180deg, #F08A24, #C85A0E)", 420),
      ribbon([dateTxt("12/8（火）23:59まで開催・お楽しみに！", 29)], "linear-gradient(180deg, #D8322A, #A11712)", 560),
    ]);

// ── 実物グッズ4点（白いカード台座＋金の値引きバッジ）──
const CARD = 250;
const product = (file, left, top, label, yen, zoom = 1) => h("div", { position: "absolute", left, top, width: 460, height: CARD + 20 }, [
  h("div", { position: "absolute", left: 0, top: 0, width: CARD, height: CARD, borderRadius: 28, background: "#FFFFFF", boxShadow: "0 10px 24px rgba(0,0,0,0.55)", overflow: "hidden" }, [
    // 商品画像は余白が多いため、商品ごとに拡大して中央をカードに収める
    { type: "img", props: { src: uri(file), width: (CARD - 28) * zoom, height: (CARD - 28) * zoom, style: { position: "absolute", left: 14 - ((CARD - 28) * (zoom - 1)) / 2, top: 14 - ((CARD - 28) * (zoom - 1)) / 2 } } },
  ]),
  h("div", { position: "absolute", left: CARD + 14, top: 12, flexDirection: "column", alignItems: "center", width: 180 }, [
    ...label.split("\n").map(line => t(line, { fontFamily: "Mochiy", fontSize: 34, color: "#FFFFFF", lineHeight: 1.15, textShadow: stroke([DARK, 4]) })),
    h("div", { marginTop: 10, width: 150, height: 150, borderRadius: 999, backgroundImage: GOLD, border: "4px solid #FFF3A8", boxShadow: "0 6px 14px rgba(0,0,0,0.5)", flexDirection: "column", alignItems: "center", justifyContent: "center" }, [
      h("div", { alignItems: "flex-end" }, [
        t(yen, { fontFamily: "Mochiy", fontSize: yen.length > 3 ? 32 : 52, color: "#5A2A00", lineHeight: 1 }),
        t("円", { fontFamily: "Mochiy", fontSize: yen.length > 3 ? 20 : 26, color: "#5A2A00", lineHeight: 1, marginBottom: 4 }),
      ]),
      t("OFF", { fontFamily: "Mochiy", fontSize: 34, color: "#5A2A00", lineHeight: 1.1 }),
    ]),
  ]),
]);
const products = h("div", { position: "absolute", left: 0, top: 0, width: W, height: W }, [
  product("t-shirt.png", 70, 462, "Tシャツ", "1,000", 1.08),
  product("acrylic-keychain.png", 560, 462, "アクリル\nキーホルダー", "300", 1.18),
  product("can-badge.png", 70, 742, "缶バッジ", "50", 1.2),
  product("sticker.png", 560, 742, "ステッカー", "50", 1.25),
]);

// ── 下部: ショップ名 ──
const shop = h("div", { position: "absolute", left: 0, top: 1006, width: W, justifyContent: "center", alignItems: "baseline", gap: 40 }, [
  t("にゃんバーサリー", { fontFamily: "Mochiy", fontSize: 38, color: "#FFFFFF", textShadow: stroke([DARK, 5]) }),
  t("suzuri.jp/nyanmusu", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 36, color: "#FFFFFF", textShadow: stroke([DARK, 5]) }),
]);

const el = h("div", { width: W, height: W, position: "relative" }, [base, title, tag, discount, dates, products, shop]);
const svg = await satori(el, { width: W, height: W, fonts });
const out = MODE === "kaisai" ? "banner-kaisai.png" : "banner.png";
writeFileSync(`${S}${out}`, new resvg.Resvg(svg).render().asPng());
console.log(`wrote ${S}${out}`);
