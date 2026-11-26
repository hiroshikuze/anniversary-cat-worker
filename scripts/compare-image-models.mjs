#!/usr/bin/env node
/**
 * compare-image-models.mjs - Gemini画像生成モデルの比較（所要時間・トークン・推定コスト・画像の目視比較）
 *
 * 使い方:
 *   node scripts/compare-image-models.mjs --dry-run      # 条件の確認だけ（APIを呼ばない）
 *   GEMINI_API_KEY=xxx node scripts/compare-image-models.mjs
 *   GEMINI_API_KEY=xxx node scripts/compare-image-models.mjs --models gemini-2.5-flash-image,gemini-3.1-flash-image --trials 3
 *   GEMINI_API_KEY=xxx node scripts/compare-image-models.mjs --models gemini-3.1-flash-lite-image --variants A,B,C --trials 1
 *
 * 外部APIを呼び、GEMINI_API_KEYの課金対象になる（既定は 2モデル × 1変種 × 3ケース × 2試行 = 12回）。
 * --variants で、プロンプトの変種（A=現行 / B=「画面を埋める」系を外して白背景のスポットイラスト / C=B+縦横比1:1）も比べられる。
 * プロンプトは本番と同じ _buildGeminiPrompt() で作る。生成画像と index.html（モデルを並べた一覧）・
 * results.json を tmp/image-model-compare/<日時>/ に保存する（tmp/ は .gitignore 対象）。
 * 詳細・比較の基準は .claude/docs/architecture/gemini.md の「画像モデルの見直し（2026-11-24）」。
 *
 * APIキーは URL に載せず x-goog-api-key ヘッダーで送り、出力・保存ファイルには書かない。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _buildGeminiPrompt } from "../worker/index.js";

export const DEFAULT_MODELS = ["gemini-2.5-flash-image", "gemini-3.1-flash-lite-image"];
const DEFAULT_TRIALS = 2;
const MAX_TRIALS = 10; // 課金の事故防止
const DEFAULT_OUT = "tmp/image-model-compare";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 60_000;
const PAUSE_MS = 2_000;
const PRIORITY_MS = 12_000; // 本番の2フェーズ方式の優先ウィンドウ（_twoPhaseRace の priorityMs）

/**
 * 推定コスト用の価格表（USD／100万トークン）。
 * 2026-11-24に読んだ公式料金ページの**要約**による数字で、原文は未確認（要確認）。
 * 2.5-flash-image は画像出力$0.039／枚（約1,290トークン）＝$30／100万トークン相当。
 * null は不明。原文で確認できたら更新する。
 */
export const PRICES = {
  "gemini-2.5-flash-image":      { input: 0.30, textOut: null, imageOut: 30.0 },
  "gemini-3.1-flash-lite-image": { input: 0.25, textOut: 1.5,  imageOut: 30.0 },
};

// 本番と同じ _buildGeminiPrompt() で作る固定ケース（毛柄・性格・感情は固定して、モデル差だけを見る）
const PERSONA = "orange mackerel tabby with white chest, amber eyes";
const PERSONALITY = "leaning forward with wide eyes, investigating theme item curiously";
const EMOTION = "eyes wide with surprise, ears pricked forward, caught off-guard";

function makeCase(id, theme, themeEn, description, visualHint, eatingAction = null) {
  return {
    id,
    theme,
    prompt: _buildGeminiPrompt(theme, description, PERSONA, PERSONALITY, visualHint, EMOTION, eatingAction, null, themeEn, description),
  };
}

/**
 * プロンプトの変種。本番の_buildGeminiPrompt()は変えず、ここで文字列を差し替えて作る。
 * 3.1が背景まで描き込む原因の仮説（「白背景」と「画面を埋める・没入感」の指示の矛盾）を試すためのもの。
 * imageConfig は generationConfig に入れる（公式ドキュメントの要約によるキー名。拒否されれば400等で分かる）。
 */
export const VARIANTS = {
  A: { label: "現行のプロンプト", edit: false, imageConfig: null },
  B: { label: "「画面を埋める」系を外し、白背景のスポットイラストを指定", edit: true, imageConfig: null },
  C: { label: "B＋縦横比1:1（imageConfig）", edit: true, imageConfig: { aspectRatio: "1:1" } },
};

// 本番のプロンプト（worker/index.js _buildGeminiPrompt）にある、変種Bで差し替え・削除する文
const FILL_FRAME_SENTENCE =
  "Composition: fill the frame with the cat and scene elements, leaving only a small, even margin around the edges. Avoid large empty corners or a distant, isolated subject floating in excess white space — the illustration should feel full and immersive, not small or shrunken. ";
const NO_BLANK_MARGIN_SENTENCE = "Do not leave large blank margins or empty corners around the subject. ";
const SPOT_ILLUSTRATION_SENTENCE = "Composition: a spot illustration isolated on a pure white background. Do not draw a full scenery background. ";

export const columnKey = (model, variant) => `${model}__${variant}`;

/** 変種に合わせてプロンプトを作る。想定の文が本番のプロンプトに無ければ例外（黙って何もしない事故を防ぐ） */
export function applyVariant(prompt, variant) {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`未知の変種: ${variant}`);
  if (!v.edit) return prompt;
  for (const sentence of [FILL_FRAME_SENTENCE, NO_BLANK_MARGIN_SENTENCE]) {
    if (!prompt.includes(sentence)) throw new Error("本番のプロンプトに、差し替え対象の文が見つかりません（worker/index.js の _buildGeminiPrompt が変わった可能性）");
  }
  return prompt.replace(FILL_FRAME_SENTENCE, SPOT_ILLUSTRATION_SENTENCE).replace(NO_BLANK_MARGIN_SENTENCE, "");
}

export const CASES = [
  makeCase(
    "flower-festival", "花まつり", "Flower Festival (Hanamatsuri)",
    "Buddhist event celebrating the birth of Buddha, pouring sweet tea over a small statue",
    "lotus flower, baby Buddha statue, sweet tea ladle, temple bell, incense smoke, soft golden light",
  ),
  makeCase(
    "takoyaki-day", "たこ焼きの日", "Takoyaki Day",
    "A day celebrating takoyaki, the octopus ball snack from Osaka",
    "takoyaki on a wooden boat tray, bonito flakes, sauce and mayonnaise, small paper flag, warm street-stall lights",
    "licking its lips and sniffing the food with delight",
  ),
  makeCase(
    "tea-day", "紅茶の日", "Black Tea Day",
    "A day celebrating black tea, first brought to Japan in the Edo period",
    "teapot and teacup with rising steam, tea leaves, a small plate of biscuits, autumn leaves, cozy afternoon light",
  ),
];

// ---------------------------------------------------------------------------
// 引数・リクエスト・レスポンス（純粋関数）
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { models: [...DEFAULT_MODELS], variants: ["A"], trials: DEFAULT_TRIALS, out: DEFAULT_OUT, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} に値が必要です`);
      return argv[++i];
    };
    if (a === "--models") {
      opts.models = value().split(",").map((m) => m.trim()).filter(Boolean);
      if (opts.models.length === 0) throw new Error("--models にモデル名が必要です");
    } else if (a === "--variants") {
      const names = [...new Set(value().split(",").map((v) => v.trim()).filter(Boolean))];
      if (names.length === 0) throw new Error("--variants に変種が必要です");
      const unknown = names.filter((n) => !VARIANTS[n]);
      if (unknown.length) throw new Error(`未知の変種: ${unknown.join(", ")}（${Object.keys(VARIANTS).join("・")}から選んでください）`);
      opts.variants = names;
    } else if (a === "--trials") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_TRIALS) throw new Error(`--trials は1〜${MAX_TRIALS}の整数にしてください`);
      opts.trials = n;
    } else if (a === "--out") {
      opts.out = value();
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`未知の引数: ${a}`);
    }
  }
  return opts;
}

/** 本番（worker/index.js tryGemini）と同じリクエスト本文 */
export function buildRequestBody(prompt, imageConfig = null) {
  const generationConfig = { responseModalities: ["IMAGE", "TEXT"] };
  if (imageConfig) generationConfig.imageConfig = imageConfig;
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig };
}

/** PNG・JPEGのヘッダーから幅と高さを読む（画像を保存せずに出力サイズを知るため）。読めなければnull */
export function parseImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function extractImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const part = parts.find((p) => p?.inlineData?.data);
  if (!part) return null;
  return { mimeType: part.inlineData.mimeType || "image/png", data: part.inlineData.data };
}

export function parseUsage(meta) {
  const m = meta ?? {};
  const prompt = m.promptTokenCount ?? 0;
  const candidates = m.candidatesTokenCount ?? 0;
  const thoughts = m.thoughtsTokenCount ?? 0;
  const details = Array.isArray(m.candidatesTokensDetails) ? m.candidatesTokensDetails : null;
  const image = details
    ? details.filter((d) => d?.modality === "IMAGE").reduce((sum, d) => sum + (d.tokenCount ?? 0), 0)
    : 0;
  return {
    prompt,
    image,
    text: Math.max(0, candidates - image) + thoughts,
    total: m.totalTokenCount ?? prompt + candidates + thoughts,
    imageKnown: details !== null,
  };
}

/** 単価（USD／100万トークン）で試算する。内訳が不明、または必要な単価が不明ならnull */
export function estimateCostUsd(usage, price) {
  if (!price || !usage.imageKnown) return null;
  if (usage.text > 0 && price.textOut == null) return null;
  const perM = 1_000_000;
  return (usage.prompt * price.input + usage.text * (price.textOut ?? 0) + usage.image * price.imageOut) / perM;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(trials) {
  const ok = trials.filter((t) => t.success);
  const costs = ok.map((t) => t.costUsd);
  const times = ok.map((t) => t.elapsedMs);
  return {
    trials: trials.length,
    successes: ok.length,
    successRate: trials.length ? ok.length / trials.length : 0,
    avgMs: avg(times),
    minMs: times.length ? Math.min(...times) : null,
    maxMs: times.length ? Math.max(...times) : null,
    within12s: ok.filter((t) => t.elapsedMs <= PRIORITY_MS).length,
    avgBytes: avg(ok.map((t) => t.bytes)),
    avgTokens: avg(ok.map((t) => t.usage?.total ?? 0)),
    avgCostUsd: ok.length && costs.every((c) => typeof c === "number") ? avg(costs) : null,
    sizes: [...new Set(ok.map((t) => t.size).filter(Boolean))],
  };
}

/** APIキーを出力に出さないための伏せ字（URLのkey=…も伏せる） */
export function redactKey(text, apiKey) {
  let out = String(text).replace(/([?&]key=)[^&\s]+/gi, "$1***");
  if (apiKey) out = out.split(apiKey).join("***");
  return out;
}

export function safeFileName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, "_");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (v, digits = 0, unit = "") => (v === null || v === undefined ? "—" : `${Number(v).toFixed(digits)}${unit}`);

export function buildReportHtml(report) {
  const { columns, cases, trials, summaries } = report;
  const colName = (c) => `${c.model}（案${c.variant}）`;
  const summaryRows = columns.map((c) => {
    const s = summaries[c.key];
    return `<tr><th>${esc(colName(c))}<br><small>${esc(c.label)}</small></th><td>${s.successes}/${s.trials}</td><td>${fmt(s.avgMs, 0, "ms")}</td><td>${fmt(s.minMs, 0, "ms")}〜${fmt(s.maxMs, 0, "ms")}</td>` +
      `<td>${s.within12s}/${s.successes}</td><td>${s.sizes.length ? esc(s.sizes.join(", ")) : "—"}</td><td>${fmt(s.avgBytes === null ? null : s.avgBytes / 1024, 0, "KB")}</td><td>${fmt(s.avgTokens, 0)}</td>` +
      `<td>${s.avgCostUsd === null ? "不明" : `$${s.avgCostUsd.toFixed(4)}`}</td></tr>`;
  }).join("\n");

  const caseSections = cases.map((c) => {
    const cols = columns.map((col) => {
      const cells = trials.filter((t) => t.column === col.key && t.caseId === c.id).map((t) =>
        t.success
          ? `<figure><img src="${esc(t.file)}" alt="${esc(colName(col))} ${esc(c.id)} ${t.n}" loading="lazy"><figcaption>#${t.n} ${esc(t.size ?? "")} ${fmt(t.elapsedMs, 0, "ms")} / ${fmt(t.bytes / 1024, 0, "KB")} / ${fmt(t.usage?.total, 0)}トークン / ${t.costUsd === null ? "コスト不明" : `$${t.costUsd.toFixed(4)}`}</figcaption></figure>`
          : `<figure class="ng"><figcaption>#${t.n} 失敗（${fmt(t.elapsedMs, 0, "ms")}）: ${esc(t.error ?? "不明")}</figcaption></figure>`).join("\n");
      return `<td><h4>${esc(colName(col))}</h4>${cells}</td>`;
    }).join("\n");
    return `<section><h3>${esc(c.theme)}（${esc(c.id)}）</h3><table class="grid"><tr>${cols}</tr></table></section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>画像モデルの比較 ${esc(report.startedAt)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;line-height:1.5}
table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:4px 8px;vertical-align:top}
.grid td{border:none;padding:0 12px 0 0}img{max-width:320px;height:auto;display:block}
figure{margin:0 0 12px}figcaption{font-size:12px;color:#555}.ng figcaption{color:#b00}
</style></head><body>
<h1>画像モデルの比較</h1>
<p>実行: ${esc(report.startedAt)}。推定コストは価格表（2026-11-24の料金ページの要約）による参考値で、<b>要確認</b>です。</p>
<h2>集計</h2>
<table><tr><th>モデル（変種）</th><th>成功</th><th>平均</th><th>最小〜最大</th><th>12秒以内</th><th>出力サイズ</th><th>平均サイズ</th><th>平均トークン</th><th>推定コスト／枚</th></tr>
${summaryRows}</table>
<h2>目視のチェック項目</h2>
<ul><li>文字の混入（看板・ラベル・文字化け）</li><li>猫以外の顔（食べ物・植物に目や口がないか。Bug#33）</li><li>桜の誤生成（テーマにない花びら。Bug#26）</li><li>余白（被写体が小さく浮いていないか）</li><li>白背景か（背景まで描き込んでいないか。枠・ビネットがないか）</li><li>水彩・パステルの雰囲気、猫のかわいさ</li></ul>
<h2>画像</h2>
${caseSections}
</body></html>
`;
}

// ---------------------------------------------------------------------------
// 実行（外部API）
// ---------------------------------------------------------------------------

/**
 * 1回生成する。計測のため fetchWithRetry は使わない（再試行すると所要時間が歪むため意図的に非リトライ）。
 */
async function generateOnce(model, prompt, imageConfig, apiKey) {
  const start = Date.now();
  try {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildRequestBody(prompt, imageConfig)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const elapsedMs = Date.now() - start;
    let data;
    try { data = JSON.parse(text); } catch {
      return { success: false, elapsedMs, error: `非JSONレスポンス（HTTP ${res.status}）` };
    }
    if (!res.ok) return { success: false, elapsedMs, error: redactKey(data?.error?.message ?? `HTTP ${res.status}`, apiKey).slice(0, 200) };
    const image = extractImage(data);
    const usage = parseUsage(data.usageMetadata);
    if (!image) return { success: false, elapsedMs, usage, error: "画像パートなし" };
    return { success: true, elapsedMs, image, usage, costUsd: estimateCostUsd(usage, PRICES[model]) };
  } catch (e) {
    return { success: false, elapsedMs: Date.now() - start, error: redactKey(e?.name === "TimeoutError" ? "タイムアウト" : (e?.message ?? String(e)), apiKey).slice(0, 200) };
  }
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const columns = opts.models.flatMap((model) => opts.variants.map((variant) => ({ key: columnKey(model, variant), model, variant, label: VARIANTS[variant].label })));
  const calls = columns.length * CASES.length * opts.trials;
  console.log(`モデル: ${opts.models.join(", ")}`);
  console.log(`変種: ${opts.variants.map((v) => `${v}（${VARIANTS[v].label}）`).join(" / ")}`);
  console.log(`ケース: ${CASES.map((c) => c.id).join(", ")} / 試行: ${opts.trials}回ずつ / API呼び出し: ${calls}回（課金対象）`);
  const unpriced = opts.models.filter((m) => !PRICES[m]);
  if (unpriced.length) console.log(`価格表にないモデル（コストは「不明」になる）: ${unpriced.join(", ")}`);

  if (opts.dryRun) {
    console.log("\n--dry-run: APIは呼びません。");
    for (const v of opts.variants) {
      const prompt = applyVariant(CASES[0].prompt, v);
      const i = prompt.indexOf("Composition:");
      console.log(`\n[変種${v}] ${VARIANTS[v].label} / imageConfig=${JSON.stringify(VARIANTS[v].imageConfig)}`);
      console.log(`  Composition行: ${i >= 0 ? prompt.slice(i, i + 160) : "（なし）"}…`);
      console.log(`  プロンプトの長さ: ${prompt.length}文字`);
    }
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY が未設定です");
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const dir = join(opts.out, startedAt.replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });

  const trials = [];
  // 時間帯の偏りを避けるため、列（モデル×変種）を交互に回す（ケース → 試行 → 列の順）
  for (const c of CASES) {
    for (let n = 1; n <= opts.trials; n++) {
      for (const col of columns) {
        const prompt = applyVariant(c.prompt, col.variant);
        const r = await generateOnce(col.model, prompt, VARIANTS[col.variant].imageConfig, apiKey);
        const trial = { column: col.key, model: col.model, variant: col.variant, caseId: c.id, n, success: r.success, elapsedMs: r.elapsedMs, usage: r.usage, costUsd: r.costUsd ?? null, error: r.error };
        if (r.success) {
          const buf = Buffer.from(r.image.data, "base64");
          const dim = parseImageSize(buf);
          trial.bytes = buf.length;
          trial.size = dim ? `${dim.width}x${dim.height}` : null;
          trial.file = `${safeFileName(col.model)}__${col.variant}__${safeFileName(c.id)}__${n}.${EXT[r.image.mimeType] ?? "png"}`;
          writeFileSync(join(dir, trial.file), buf);
        }
        trials.push(trial);
        console.log(`${r.success ? "✅" : "❌"} ${col.model} 案${col.variant} / ${c.id} #${n}: ${r.elapsedMs}ms ${r.success ? `${trial.size ?? "サイズ不明"} ${Math.round(trial.bytes / 1024)}KB ${r.usage.total}トークン` : r.error}`);
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
    }
  }

  const summaries = Object.fromEntries(columns.map((col) => [col.key, summarize(trials.filter((t) => t.column === col.key))]));
  const report = { startedAt, columns, cases: CASES.map(({ id, theme }) => ({ id, theme })), trials, summaries };
  writeFileSync(join(dir, "results.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "index.html"), buildReportHtml(report));

  console.log("\n========== 集計 ==========");
  for (const col of columns) {
    const s = summaries[col.key];
    console.log(`${col.model} 案${col.variant}: 成功 ${s.successes}/${s.trials}、平均 ${fmt(s.avgMs, 0, "ms")}（最小〜最大 ${fmt(s.minMs, 0, "ms")}〜${fmt(s.maxMs, 0, "ms")}）、12秒以内 ${s.within12s}/${s.successes}、` +
      `出力 ${s.sizes.length ? s.sizes.join(", ") : "—"}、平均トークン ${fmt(s.avgTokens, 0)}、推定コスト／枚 ${s.avgCostUsd === null ? "不明" : `$${s.avgCostUsd.toFixed(4)}`}`);
  }
  console.log(`\n画像と一覧: ${join(dir, "index.html")}（ブラウザで開いてモデルと変種を並べて見比べてください）`);
  if (trials.every((t) => !t.success)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`❌ ${redactKey(e?.message ?? String(e), process.env.GEMINI_API_KEY ?? "")}`);
    process.exit(1);
  });
}
