// SNSセール告知バナーの合成スクリプト・Google AI Studio版パターン1（本番コードではない・参考資料）
// 2026-09-29に実際にBluesky/Mastodonへ投稿した版をそのまま保存したもの。座標・文言はこのときの値。
// Geminiの背景で猫の場面が画面いっぱいに描かれ文字の余白がなかったため、
// パネルを塗り直し → 場面だけを切り出して縮小・下寄せ → 空いた上半分に文字・左右に実物グッズ、と組み直している。
// 使い方は同じディレクトリのREADME.mdを参照（compose.mjsと同じ）。
//
//   node .claude/prototypes/sale-banner/compose-aistudio.mjs <作業ディレクトリ>
//
// 作業ディレクトリに必要なもの: bg.jpg（1024×1024・硬貨を消し済み）・t-shirt.png・sticker.png・fonts/*.ttf。
// 出力は<作業ディレクトリ>/banner.png（Blueskyの上限1MBを超えるため、投稿時はJPEGに変換する）。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const NM = new URL("../../../node_modules", import.meta.url).pathname; // リポジトリ直下のnode_modules（要npm ci）
const { satori } = await import(`${NM}/@cf-wasm/satori/dist/node.js`);
const resvg = await import(`${NM}/@resvg/resvg-wasm/index.mjs`);
await resvg.initWasm(readFileSync(`${NM}/@resvg/resvg-wasm/index_bg.wasm`));

const S = resolve(process.argv[2] ?? ".") + "/";
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
const PANEL = "#EFC69E";
const RED = "#D8432B";

// 背景の一部を切り出して任意の位置・倍率で置く（overflow hiddenの枠の中で画像をずらす）
const crop = (sx, sy, sw, shh, dx, dy, scale) => h("div", { position: "absolute", left: dx, top: dy, width: sw * scale, height: shh * scale, overflow: "hidden" }, [
  { type: "img", props: { src: BG, width: 1024 * scale, height: 1024 * scale, style: { position: "absolute", left: -sx * scale, top: -sy * scale } } },
]);

// 1. 背景全体（オレンジの縁＋桃色のパネル）
const base = { type: "img", props: { src: BG, width: W, height: W, style: { position: "absolute", left: 0, top: 0 } } };
// 2. パネルの中の元の場面を塗りつぶし、3. 猫の場面を縮小して下に寄せる
const cover = h("div", { position: "absolute", left: 100 * K, top: 110 * K, width: 830 * K, height: 800 * K, background: PANEL }, []);
const SC = 0.66;
const scene = crop(95, 135, 830, 770, 540 - (830 * SC) / 2, 440, SC);

// ── 文字 ──
const title = h("div", { position: "absolute", left: 0, top: 88, width: W, flexDirection: "column", alignItems: "center" }, [
  t("SUZURI", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 40, letterSpacing: 6, color: RED, textShadow: stroke(["#FFFFFF", 5]) }),
  h("div", { alignItems: "flex-end", marginTop: -4 }, [
    t("秋のビッグセール", { fontFamily: "Mochiy", fontSize: 76, color: "#FFFFFF", textShadow: stroke([RED, 7], ["rgba(120,30,0,0.3)", 11]) }),
    t("開催中！", { fontFamily: "Mochiy", fontSize: 46, color: RED, marginLeft: 8, marginBottom: 8, textShadow: stroke(["#FFFFFF", 5]) }),
  ]),
]);
const discountParts = (fill) => [
  t("最大", { fontFamily: "Mochiy", fontSize: 64, lineHeight: 1, marginRight: 4, marginBottom: 10, ...fill }),
  t("1,000", { fontFamily: "Mochiy", fontSize: 118, lineHeight: 1, ...fill }),
  t("円OFF", { fontFamily: "Mochiy", fontSize: 76, lineHeight: 1, marginLeft: 4, marginBottom: 8, ...fill }),
];
const discountRow = (fill) => h("div", { position: "absolute", left: 0, top: 0, width: W, height: 130, justifyContent: "center", alignItems: "flex-end" }, discountParts(fill));
const discount = h("div", { position: "absolute", left: 0, top: 225, width: W, height: 130 }, [
  discountRow({ color: "#8C1D00", textShadow: stroke(["#8C1D00", 9], ["rgba(0,0,0,0.2)", 14]) }),
  discountRow({ color: "#FFFFFF", textShadow: stroke(["#FFFFFF", 5]) }),
  discountRow({ backgroundImage: "linear-gradient(180deg, #FFE45C 0%, #FFA41F 55%, #F2551F 100%)", backgroundClip: "text", color: "transparent" }),
]);
const deadline = h("div", { position: "absolute", left: 0, top: 368, width: W, justifyContent: "center" }, [
  h("div", { background: "#8C2A12", borderRadius: 999, padding: "6px 36px", border: "4px solid #FFFFFF" }, [
    t("10/4（日）23:59まで", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 40, color: "#FFFFFF" }),
  ]),
]);

// ── 実物グッズ（セール対象のみ）──
const product = (file, size, left, top, label, off, tint) => h("div", { position: "absolute", left, top, width: size, height: size }, [
  h("div", { position: "absolute", left: 6, top: 6, width: size - 12, height: size - 12, borderRadius: 999, background: tint, border: "6px solid #FFFFFF", boxShadow: "0 8px 18px rgba(120,40,0,0.35)" }, []),
  { type: "img", props: { src: uri(file), width: size - 20, height: size - 20, style: { position: "absolute", left: 10, top: 6 } } },
  h("div", { position: "absolute", right: -14, top: -10, background: "#D32F2F", borderRadius: 999, padding: "8px 16px", border: "4px solid #FFFFFF", transform: "rotate(10deg)", flexDirection: "column", alignItems: "center" }, [
    t(label, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 22, color: "#FFFFFF", lineHeight: 1.1 }),
    t(off, { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 30, color: "#FFEB3B", lineHeight: 1.1 }),
  ]),
]);
const products = h("div", { position: "absolute", left: 0, top: 0, width: W, height: W }, [
  product("t-shirt.png", 250, 40, 560, "Tシャツ", "1,000円OFF", "#F28C4B"),
  product("sticker.png", 250, W - 40 - 250, 560, "ステッカー", "100円OFF", "#7FB7A0"),
]);

// ── 下部: 限定の帯・ショップ名 ──
const notice = h("div", { position: "absolute", left: 0, top: 852, width: W, height: 64, background: "#E8541E", alignItems: "center", justifyContent: "center" }, [
  t("限定デザインは14日間だけ！", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 36, color: "#FFFFFF" }),
]);
const shop = h("div", { position: "absolute", left: 0, top: 940, width: W, justifyContent: "center", alignItems: "baseline", gap: 40 }, [
  t("にゃんバーサリー", { fontFamily: "Mochiy", fontSize: 38, color: "#FFFFFF", textShadow: stroke([RED, 5]) }),
  t("suzuri.jp/nyanmusu", { fontFamily: "ZenMaru", fontWeight: 900, fontSize: 36, color: "#FFFFFF", textShadow: stroke([RED, 5]) }),
]);

const el = h("div", { width: W, height: W, position: "relative" }, [base, cover, scene, title, discount, deadline, notice, products, shop]);
const svg = await satori(el, { width: W, height: W, fonts });
writeFileSync(`${S}banner.png`, new resvg.Resvg(svg).render().asPng());
console.log(`wrote ${S}banner.png`);
