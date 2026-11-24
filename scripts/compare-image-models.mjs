#!/usr/bin/env node
/**
 * compare-image-models.mjs - Gemini画像生成モデルの比較（所要時間・トークン・推定コスト・画像の目視比較）
 *
 * 使い方:
 *   node scripts/compare-image-models.mjs --dry-run      # 条件の確認だけ（APIを呼ばない）
 *   GEMINI_API_KEY=xxx node scripts/compare-image-models.mjs
 *   GEMINI_API_KEY=xxx node scripts/compare-image-models.mjs --models gemini-2.5-flash-image,gemini-3.1-flash-image --trials 3
 *
 * 外部APIを呼び、GEMINI_API_KEYの課金対象になる（既定は 2モデル × 3ケース × 2試行 = 12回）。
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
  const opts = { models: [...DEFAULT_MODELS], trials: DEFAULT_TRIALS, out: DEFAULT_OUT, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} に値が必要です`);
      return argv[++i];
    };
    if (a === "--models") {
      opts.models = value().split(",").map((m) => m.trim()).filter(Boolean);
      if (opts.models.length === 0) throw new Error("--models にモデル名が必要です");
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
export function buildRequestBody(prompt) {
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  };
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
  const { models, cases, trials, summaries } = report;
  const summaryRows = models.map((m) => {
    const s = summaries[m];
    return `<tr><th>${esc(m)}</th><td>${s.successes}/${s.trials}</td><td>${fmt(s.avgMs, 0, "ms")}</td><td>${fmt(s.minMs, 0, "ms")}〜${fmt(s.maxMs, 0, "ms")}</td>` +
      `<td>${s.within12s}/${s.successes}</td><td>${fmt(s.avgBytes === null ? null : s.avgBytes / 1024, 0, "KB")}</td><td>${fmt(s.avgTokens, 0)}</td>` +
      `<td>${s.avgCostUsd === null ? "不明" : `$${s.avgCostUsd.toFixed(4)}`}</td></tr>`;
  }).join("\n");

  const caseSections = cases.map((c) => {
    const cols = models.map((m) => {
      const cells = trials.filter((t) => t.model === m && t.caseId === c.id).map((t) =>
        t.success
          ? `<figure><img src="${esc(t.file)}" alt="${esc(m)} ${esc(c.id)} ${t.n}" loading="lazy"><figcaption>#${t.n} ${fmt(t.elapsedMs, 0, "ms")} / ${fmt(t.bytes / 1024, 0, "KB")} / ${fmt(t.usage?.total, 0)}トークン / ${t.costUsd === null ? "コスト不明" : `$${t.costUsd.toFixed(4)}`}</figcaption></figure>`
          : `<figure class="ng"><figcaption>#${t.n} 失敗（${fmt(t.elapsedMs, 0, "ms")}）: ${esc(t.error ?? "不明")}</figcaption></figure>`).join("\n");
      return `<td><h4>${esc(m)}</h4>${cells}</td>`;
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
<table><tr><th>モデル</th><th>成功</th><th>平均</th><th>最小〜最大</th><th>12秒以内</th><th>平均サイズ</th><th>平均トークン</th><th>推定コスト／枚</th></tr>
${summaryRows}</table>
<h2>目視のチェック項目</h2>
<ul><li>文字の混入（看板・ラベル・文字化け）</li><li>猫以外の顔（食べ物・植物に目や口がないか。Bug#33）</li><li>桜の誤生成（テーマにない花びら。Bug#26）</li><li>余白（被写体が小さく浮いていないか）</li><li>水彩・パステルの雰囲気、猫のかわいさ</li></ul>
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
async function generateOnce(model, prompt, apiKey) {
  const start = Date.now();
  try {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildRequestBody(prompt)),
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
  const calls = opts.models.length * CASES.length * opts.trials;
  console.log(`モデル: ${opts.models.join(", ")}`);
  console.log(`ケース: ${CASES.map((c) => c.id).join(", ")} / 試行: ${opts.trials}回ずつ / API呼び出し: ${calls}回（課金対象）`);
  const unpriced = opts.models.filter((m) => !PRICES[m]);
  if (unpriced.length) console.log(`価格表にないモデル（コストは「不明」になる）: ${unpriced.join(", ")}`);

  if (opts.dryRun) {
    console.log("\n--dry-run: APIは呼びません。プロンプト（先頭200文字）:");
    for (const c of CASES) console.log(`\n[${c.id}] ${c.prompt.slice(0, 200)}…`);
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
  // 時間帯の偏りを避けるため、モデルを交互に回す（ケース → 試行 → モデルの順）
  for (const c of CASES) {
    for (let n = 1; n <= opts.trials; n++) {
      for (const model of opts.models) {
        const r = await generateOnce(model, c.prompt, apiKey);
        const trial = { model, caseId: c.id, n, success: r.success, elapsedMs: r.elapsedMs, usage: r.usage, costUsd: r.costUsd ?? null, error: r.error };
        if (r.success) {
          const buf = Buffer.from(r.image.data, "base64");
          trial.bytes = buf.length;
          trial.file = `${safeFileName(model)}__${safeFileName(c.id)}__${n}.${EXT[r.image.mimeType] ?? "png"}`;
          writeFileSync(join(dir, trial.file), buf);
        }
        trials.push(trial);
        console.log(`${r.success ? "✅" : "❌"} ${model} / ${c.id} #${n}: ${r.elapsedMs}ms ${r.success ? `${Math.round(trial.bytes / 1024)}KB ${r.usage.total}トークン` : r.error}`);
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
    }
  }

  const summaries = Object.fromEntries(opts.models.map((m) => [m, summarize(trials.filter((t) => t.model === m))]));
  const report = { startedAt, models: opts.models, cases: CASES.map(({ id, theme }) => ({ id, theme })), trials, summaries };
  writeFileSync(join(dir, "results.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "index.html"), buildReportHtml(report));

  console.log("\n========== 集計 ==========");
  for (const m of opts.models) {
    const s = summaries[m];
    console.log(`${m}: 成功 ${s.successes}/${s.trials}、平均 ${fmt(s.avgMs, 0, "ms")}（最小〜最大 ${fmt(s.minMs, 0, "ms")}〜${fmt(s.maxMs, 0, "ms")}）、12秒以内 ${s.within12s}/${s.successes}、` +
      `平均トークン ${fmt(s.avgTokens, 0)}、推定コスト／枚 ${s.avgCostUsd === null ? "不明" : `$${s.avgCostUsd.toFixed(4)}`}`);
  }
  console.log(`\n画像と一覧: ${join(dir, "index.html")}（ブラウザで開いてモデルを並べて見比べてください）`);
  if (trials.every((t) => !t.success)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`❌ ${redactKey(e?.message ?? String(e), process.env.GEMINI_API_KEY ?? "")}`);
    process.exit(1);
  });
}
