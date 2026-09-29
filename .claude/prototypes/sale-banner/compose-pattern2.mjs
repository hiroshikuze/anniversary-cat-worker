// SNSセール告知バナーの試作スクリプト・パターン2（秋の季節感）（本番コードではない・参考資料）
// Geminiの背景（木の板）に、Geminiの草案の画像を直接見て書式を寄せた文字と、実物グッズを合成する。
// 2026-09「秋のビッグセール」パターン2の最終版をそのまま保存したもの。座標・文言はこのときの値。
// 使い方は同じディレクトリのREADME.mdを参照（compose.mjsと同じ）。
//
//   node .claude/prototypes/sale-banner/compose-pattern2.mjs <作業ディレクトリ>
//
// 作業ディレクトリに必要なもの: bg.jpg・t-shirt.png・sticker.png・fonts/*.ttf。出力は<作業ディレクトリ>/banner.png。
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
const ring = (c, w) => Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return `${(Math.cos(a) * w).toFixed(1)}px ${(Math.sin(a) * w).toFixed(1)}px 0 ${c}`;
});
const stroke = (...layers) => layers.flatMap(([c, w]) => ring(c, w)).join(", ");
const DARK = "#3E1F07";

// ── 見出し: 草案どおり「焦げ茶の文字＋白の太い縁取り」、1行目はゆるいアーチ、2行目「開催中！」 ──
const TITLE = "#4A2410";
const titleStyle = (size) => ({ fontFamily: "ZenMaru", fontWeight: 900, fontSize: size, color: TITLE, textShadow: stroke(["#FFFFFF", 7], ["rgba(60,25,0,0.35)", 11]) });
const arcChars = [..."SUZURI 秋のビッグセール"];
const cw = arcChars.map((c) => (c === "I" ? 0.36 : /[A-Z]/.test(c) ? 0.7 : c === " " ? 0.3 : /[ッャュョ]/.test(c) ? 0.78 : 1));
const aSize = 72, R = 1500, cx = 540, cy = 92 + R;
const total = cw.reduce((x, y) => x + y, 0) * aSize;
let acc = -total / 2;
const arc = arcChars.map((c, i) => {
  const mid = acc + (cw[i] * aSize) / 2; acc += cw[i] * aSize;
  const rad = mid / R, deg = (rad * 180) / Math.PI;
  const x = cx + R * Math.sin(rad), y = cy - R * Math.cos(rad);
  return h("div", { position: "absolute", left: x - 45, top: y - 45, width: 90, height: 90, justifyContent: "center", alignItems: "center", transform: `rotate(${deg}deg)` }, [t(c, titleStyle(aSize))]);
});
const kaisai = h("div", { position: "absolute", left: 0, top: 135, width: W, justifyContent: "center" }, [t("開催中！", titleStyle(74))]);

// ── 割引の札: 草案どおり「白抜き数字＋赤の縁取り」、最大・円は赤文字＋白縁取り ──
const RED = "#B71C1C";
const whiteNum = { color: "#FFFFFF", textShadow: stroke([RED, 5], ["rgba(90,20,0,0.35)", 9]) };
const redChar = { color: "#C62828", textShadow: stroke(["#FFFFFF", 4]) };
const badge = h("div", { position: "absolute", left: 540 - 300, top: 262, width: 600, flexDirection: "column", borderRadius: 30, border: "6px solid #FFFFFF", boxShadow: "0 0 0 4px #5A2A0E, 0 12px 22px rgba(40,15,0,0.45)", overflow: "hidden" }, [
  h("div", { height: 184, backgroundImage: "linear-gradient(90deg, #FFC04D 0%, #FF8A2A 35%, #F0501E 100%)", alignItems: "center", justifyContent: "center" }, [
    h("div", { flexDirection: "column", marginRight: 12 }, [
      t("最", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 50, lineHeight: 1.0, ...redChar }),
      t("大", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 50, lineHeight: 1.0, ...redChar }),
    ]),
    t("1,000", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 156, lineHeight: 1, letterSpacing: -4, ...whiteNum }),
    h("div", { flexDirection: "column", alignItems: "center", marginLeft: 8 }, [
      t("円", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 64, lineHeight: 1.0, ...redChar }),
      t("OFF", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 44, lineHeight: 1.0, ...whiteNum }),
    ]),
  ]),
  h("div", { height: 72, background: "#4A2410", alignItems: "center", justifyContent: "center" }, [
    t("10/4（日）23:59まで", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 46, color: "#FFFFFF" }),
  ]),
]);

// ── 実物グッズ: 木の板は中間色なので白Tシャツも台座なしで映える。接地影だけ付ける ──
const product = (file, size, left, top, label, off) => h("div", { position: "absolute", left, top, width: size, height: size }, [
  h("div", { position: "absolute", left: size * 0.12, top: size * 0.80, width: size * 0.76, height: size * 0.07, borderRadius: 999, background: "rgba(40,15,0,0.28)" }, []),
  { type: "img", props: { src: uri(file), width: size, height: size, style: { position: "absolute", left: 0, top: 0 } } },
  h("div", { position: "absolute", right: -10, top: 4, background: "#D32F2F", borderRadius: 999, padding: "8px 18px", border: "4px solid #FFFFFF", transform: "rotate(10deg)", flexDirection: "column", alignItems: "center", boxShadow: "0 4px 8px rgba(0,0,0,0.3)" }, [
    t(label, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 24, color: "#FFFFFF", lineHeight: 1.1 }),
    t(off, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 32, color: "#FFEB3B", lineHeight: 1.1 }),
  ]),
]);
const products = h("div", { position: "absolute", left: 0, top: 0, width: W, height: W }, [
  product("t-shirt.png", 350, 110, 568, "Tシャツ", "1,000円OFF"),
  product("sticker.png", 290, 545, 600, "ステッカー", "100円OFF"),
]);

// ── shop_info_footer ──
const footer = h("div", { position: "absolute", left: 0, top: W - 80, width: W, height: 80, background: "#2C1405", alignItems: "center", justifyContent: "center", gap: 48 }, [
  t("にゃんバーサリー", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 38, color: "#FFFFFF" }),
  t("suzuri.jp/nyanmusu", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 38, color: "#FFFFFF" }),
]);

const el = h("div", { width: W, height: W, position: "relative" }, [
  { type: "img", props: { src: uri("bg.jpg", "image/jpeg"), width: W, height: W, style: { position: "absolute", left: 0, top: 0 } } },
  ...arc, kaisai, badge, products, footer,
]);
const svg = await satori(el, { width: W, height: W, fonts });
writeFileSync(`${S}banner.png`, new resvg.Resvg(svg).render().asPng());
console.log(`wrote ${S}banner.png`);
