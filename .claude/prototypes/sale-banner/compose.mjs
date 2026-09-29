// SNSセール告知バナーの試作スクリプト（本番コードではない・参考資料）
// Gemini背景 + Geminiの配置情報(JSON)を手で読み取った値 → Satoriで文字・実物グッズを合成する。
// 2026-09「秋のビッグセール」パターン1の試作をそのまま保存したもの。座標・文言はこのときの値。
// 使い方は同じディレクトリのREADME.mdを参照。
//
//   node .claude/prototypes/sale-banner/compose.mjs <作業ディレクトリ>
//
// 作業ディレクトリに必要なもの: bg.jpg（Geminiの背景）・t-shirt.png・sticker.png・fonts/*.ttf
// （fetch-assets.shで取得できる）。出力は<作業ディレクトリ>/banner.png。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const NM = new URL("../../../node_modules", import.meta.url).pathname; // リポジトリ直下のnode_modules（要npm ci）
const { satori } = await import(`${NM}/@cf-wasm/satori/dist/node.js`);
const resvg = await import(`${NM}/@resvg/resvg-wasm/index.mjs`);
await resvg.initWasm(readFileSync(`${NM}/@resvg/resvg-wasm/index_bg.wasm`));

const S = resolve(process.argv[2] ?? ".") + "/";
const W = 1080;
const fonts = [
  { name: "Mochiy", data: readFileSync(`${S}fonts/MochiyPopOne-Regular.ttf`), weight: 400 },
  { name: "ZenMaru", data: readFileSync(`${S}fonts/ZenMaruGothic-Bold.ttf`), weight: 700 },
  { name: "ZenMaru", data: readFileSync(`${S}fonts/ZenMaruGothic-Black.ttf`), weight: 900 },
];
const uri = (f, mime = "image/png") => `data:${mime};base64,${readFileSync(S + f).toString("base64")}`;
const h = (type, style, children) => ({ type, props: { style: { display: "flex", ...style }, children } });
const t = (s, style) => h("div", { whiteSpace: "nowrap", ...style }, s);

// 縁取り: textShadowを円周16方向に並べる。先に書いたものが上に来る
const ring = (c, w) => Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return `${(Math.cos(a) * w).toFixed(1)}px ${(Math.sin(a) * w).toFixed(1)}px 0 ${c}`;
});
const stroke = (...layers) => layers.flatMap(([c, w]) => ring(c, w)).join(", ");

// 中央揃えの絶対配置（JSONの anchor:center を再現）
const centered = (cx, cy, w, hgt, child) =>
  h("div", { position: "absolute", left: cx - w / 2, top: cy - hgt / 2, width: w, height: hgt, alignItems: "center", justifyContent: "center" }, [child]);

// ── header_title: アーチ配置（1文字ずつ回転）＋「開催中！」 ──
const title = [..."SUZURI 秋のビッグセール"];
const widths = title.map((c) => (c === "I" ? 0.4 : /[A-Z]/.test(c) ? 0.72 : c === " " ? 0.35 : /[ッャュョ]/.test(c) ? 0.8 : 1));
const size = 60, R = 1300, cx = 540, cy = 62 + R;
const total = widths.reduce((a, b) => a + b, 0) * size;
let acc = -total / 2;
const colorFor = (i) => (i < 6 ? "#3E2723" : "#E64A19");
const header = title.map((c, i) => {
  const mid = acc + (widths[i] * size) / 2; acc += widths[i] * size;
  const rad = mid / R, deg = (rad * 180) / Math.PI;
  const x = cx + R * Math.sin(rad), y = cy - R * Math.cos(rad);
  return h("div", { position: "absolute", left: x - 40, top: y - 40, width: 80, height: 80, justifyContent: "center", alignItems: "center", transform: `rotate(${deg}deg)` },
    [t(c, { fontFamily: "Mochiy", fontSize: size, color: colorFor(i), textShadow: stroke(["#FFFFFF", 6]) })]);
});
const kaisai = h("div", { position: "absolute", left: 790, top: 150, transform: "rotate(5deg)" },
  [t("開催中！", { fontFamily: "Mochiy", fontSize: 54, color: "#3E2723", textShadow: stroke(["#FFFFFF", 6]) })]);

// ── main_discount: 縁取り層＋グラデーション層を重ねる ──
const discountParts = (fill) => [
  h("div", { flexDirection: "column", marginRight: 10, marginBottom: 14 }, [
    t("最", { fontFamily: "Mochiy", fontSize: 62, lineHeight: 1, ...fill }),
    t("大", { fontFamily: "Mochiy", fontSize: 62, lineHeight: 1, ...fill }),
  ]),
  t("1,000", { fontFamily: "Mochiy", fontSize: 150, lineHeight: 1, ...fill }),
  t("円", { fontFamily: "Mochiy", fontSize: 84, lineHeight: 1, marginBottom: 12, ...fill }),
  t("OFF", { fontFamily: "Mochiy", fontSize: 124, lineHeight: 1, marginLeft: 6, ...fill }),
];
const discountRow = (fill) => h("div", { position: "absolute", left: 0, top: 0, width: W, height: 220, justifyContent: "center", alignItems: "flex-end" }, discountParts(fill));
const outlineFill = { color: "#4E260E", textShadow: stroke(["#4E260E", 10], ["rgba(0,0,0,0.25)", 16]) };
const whiteFill = { color: "#FFFFFF", textShadow: stroke(["#FFFFFF", 6]) };
const gradFill = { backgroundImage: "linear-gradient(180deg, #FFEB3B 0%, #FF9100 55%, #FF3D00 100%)", backgroundClip: "text", color: "transparent" };
const discount = h("div", { position: "absolute", left: 0, top: 478 - 130, width: W, height: 220 }, [
  discountRow(outlineFill), discountRow(whiteFill), discountRow(gradFill),
]);

// ── deadline_badge: 両端に切り込みのあるリボン（SVG）──
const ribbonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="76"><path d="M0 0 H500 L476 38 L500 76 H0 L24 38 Z" fill="#4A2710"/></svg>`;
const deadline = h("div", { position: "absolute", left: 540 - 250, top: 700 - 38, width: 500, height: 76, alignItems: "center", justifyContent: "center" }, [
  { type: "img", props: { src: `data:image/svg+xml;base64,${Buffer.from(ribbonSvg).toString("base64")}`, width: 500, height: 76, style: { position: "absolute", left: 0, top: 0 } } },
  t("10/4（日）23:59まで", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 36, color: "#FFFFFF" }),
]);

// ── notice_banner / shop_info ──
const notice = h("div", { position: "absolute", left: 0, top: 860 - 40, width: W, height: 80, background: "#E65100", alignItems: "center", justifyContent: "center" }, [
  t("限定デザインは14日間だけ！今すぐゲット！", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 38, color: "#FFFFFF" }),
]);
const shop = centered(540, 950, W, 60, h("div", { alignItems: "baseline", gap: 44 }, [
  t("にゃんバーサリー", { fontFamily: "Mochiy", fontSize: 36, color: "#212121" }),
  t("suzuri.jp/nyanmusu", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 34, color: "#212121" }),
]));

// ── 実物グッズ（SUZURI previewImageUrl）──
// セール対象のみ（記事: スタンダードTシャツ1,000円引き・ステッカー100円引き）
// 白背景に白Tシャツが溶けないよう、色付きの円＋白フチ＋影の台座に載せる
const productBadge = (file, label, off, left, tint) => h("div", { position: "absolute", left, top: 596, width: 250, height: 250 }, [
  h("div", { position: "absolute", left: 5, top: 5, width: 240, height: 240, borderRadius: 999, background: tint, border: "6px solid #FFFFFF", boxShadow: "0 8px 18px rgba(78,38,14,0.35)" }, []),
  { type: "img", props: { src: uri(file), width: 230, height: 230, style: { position: "absolute", left: 10, top: 6 } } },
  h("div", { position: "absolute", right: -18, top: -8, background: "#D32F2F", borderRadius: 999, padding: "8px 16px", border: "4px solid #FFFFFF", transform: "rotate(10deg)", flexDirection: "column", alignItems: "center" }, [
    t(label, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 22, color: "#FFFFFF", lineHeight: 1.1 }),
    t(off, { fontFamily: "Mochiy", fontSize: 28, color: "#FFEB3B", lineHeight: 1.1 }),
  ]),
]);
const products = h("div", { position: "absolute", left: 0, top: 0, width: W, height: W }, [
  productBadge("t-shirt.png", "Tシャツ", "1,000円OFF", 36, "#F4A259"),
  productBadge("sticker.png", "ステッカー", "100円OFF", W - 36 - 250, "#8FC1A9"),
]);

const el = h("div", { width: W, height: W, position: "relative" }, [
  { type: "img", props: { src: uri("bg.jpg", "image/jpeg"), width: W, height: W, style: { position: "absolute", left: 0, top: 0 } } },
  ...header, kaisai, discount, notice, deadline, products, shop,
]);

const svg = await satori(el, { width: W, height: W, fonts });
writeFileSync(`${S}banner.png`, new resvg.Resvg(svg).render().asPng());
console.log(`wrote ${S}banner.png`);
