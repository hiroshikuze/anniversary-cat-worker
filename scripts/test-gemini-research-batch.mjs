/**
 * バッチ方式 vs シングル方式の精度比較スクリプト
 *
 * 使い方:
 *   GEMINI_API_KEY=your_key node scripts/test-gemini-research-batch.mjs
 *
 * 目的:
 *   事前リサーチプール設計において、Gemini を1回呼んで複数候補を一括取得する
 *   「バッチ方式」と、1件ずつ呼ぶ「シングル方式」の品質差を実測する。
 *
 *   主な比較指標:
 *     - sourceUrlKind 分布（grounding / json / google-search-fallback 等）
 *     - google-search-fallback 率（根拠なし候補の割合）
 *     - 処理時間
 *     - テーマ一覧（目視確認用）
 *
 * 注意:
 *   実際のGemini APIを呼び出します。課金が発生します。
 *   シングル方式は5回呼び出し（コスト抑制）、バッチ方式は1回。
 */

import https from "node:https";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ GEMINI_API_KEY が未設定です");
  process.exit(1);
}

const MODEL   = "gemini-2.5-flash";
const HOST    = "generativelanguage.googleapis.com";
const BASE    = `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

// 今日の JST 日付（固定日付での比較が目的なので実行日を使う）
const now = new Date();
const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const DATE_STR =
  `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;

// ── 共通フィールド定義（プロンプトに埋め込む JSON スキーマ） ───────────────
const SCHEMA_SINGLE =
  `{"theme":"記念日名","description":"50文字以内の説明",` +
  `"visualHint":"このテーマをかわいい猫のイラストで表現するとき背景・小道具・雰囲気として使える英語キーワードを5〜8語",` +
  `"foodItem":"主な行為が食べることである場合のみ食材・料理名をASCII英語で1〜3語。それ以外はnull",` +
  `"kanjiChar":"テーマを象徴する常用漢字1文字。適切なものがなければnull",` +
  `"sourceUrl":"参照した実際のURL"}`;

// ── APIリクエスト共通関数 ─────────────────────────────────────────────────────
function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    });
    const req = https.request(
      { hostname: HOST, path: BASE, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}\n${raw.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── sourceUrlKind の判定（worker/index.js と同ロジック） ─────────────────────
function detectSourceUrlKind(data, resultSourceUrl) {
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const queries         = data.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];

  let sourceUrl = resultSourceUrl ?? "";
  if (sourceUrl.includes("vertexaisearch.cloud.google.com")) sourceUrl = "";

  if (sourceUrl) return "json";

  const uri = groundingChunks[0]?.web?.uri ?? "";
  if (uri && !uri.includes("vertexaisearch.cloud.google.com")) return "grounding";
  if (uri) return "vertexaisearch-skipped";
  if (queries.length > 0) return "google-search-fallback";
  return "none";
}

// ── 結果集計ユーティリティ ────────────────────────────────────────────────────
function summarize(items) {
  const counts = {};
  for (const { kind } of items) counts[kind] = (counts[kind] ?? 0) + 1;
  const fallbackRate = ((counts["google-search-fallback"] ?? 0) / items.length * 100).toFixed(0);
  return { counts, fallbackRate };
}

// ════════════════════════════════════════════════════════════════════════════
// 【シングル方式】1件ずつ5回呼び出し（現行 handleResearch のパターン）
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`【シングル方式】1件ずつ × 5回 (日付: ${DATE_STR})`);
console.log("═".repeat(60));

const SINGLE_TRIES = 5;
const singleResults = [];
const singleStart = Date.now();

for (let i = 0; i < SINGLE_TRIES; i++) {
  const prompt =
    `今日は${DATE_STR}です。この日の日本の記念日・季節の花・重要なイベントを` +
    `Google検索で調べ、最も特徴的なものを1つ選んでください。` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` + SCHEMA_SINGLE;

  const t0 = Date.now();
  const data = await callGemini(prompt);
  const ms = Date.now() - t0;

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let result = {};
  try { result = JSON.parse(rawText.replace(/```json|```/g, "").trim()); } catch {}

  const kind = detectSourceUrlKind(data, result.sourceUrl);
  singleResults.push({ theme: result.theme ?? "(取得失敗)", kind, ms });
  console.log(`  [${i + 1}] ${ms}ms  ${kind.padEnd(26)} ${result.theme ?? "(取得失敗)"}`);
}

const singleElapsed = Date.now() - singleStart;
const singleSummary = summarize(singleResults);
console.log(`\n  合計: ${singleElapsed}ms`);
console.log(`  sourceUrlKind 分布:`, singleSummary.counts);
console.log(`  google-search-fallback 率: ${singleSummary.fallbackRate}%`);

// ════════════════════════════════════════════════════════════════════════════
// 【バッチ方式】1回呼び出しで10件を一括取得
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`【バッチ方式】1回呼び出しで10件一括 (日付: ${DATE_STR})`);
console.log("═".repeat(60));

const batchPrompt =
  `今日は${DATE_STR}です。この日の日本の記念日・季節の花・重要なイベントを` +
  `Google検索で調べ、特徴的なものを最大10件リストアップしてください。` +
  `内容が重複しないよう、できるだけ多様なテーマを選んでください。` +
  `回答は以下のJSON配列のみ（マークダウン・説明文は不要）:\n` +
  `[${SCHEMA_SINGLE}, ...]`;

const batchStart = Date.now();
const batchData  = await callGemini(batchPrompt);
const batchMs    = Date.now() - batchStart;

const batchRawText = batchData.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
let batchItems = [];
try {
  batchItems = JSON.parse(batchRawText.replace(/```json|```/g, "").trim());
  if (!Array.isArray(batchItems)) batchItems = [];
} catch {
  console.log("  ⚠️ JSON パース失敗。生テキスト:");
  console.log(" ", batchRawText.slice(0, 300));
}

// バッチはグラウンディングチャンクが1セットしかない（全候補共通）
// → 全アイテムに同じ sourceUrlKind を割り当てて比較
const batchKind = detectSourceUrlKind(batchData, batchItems[0]?.sourceUrl ?? "");

console.log(`  処理時間: ${batchMs}ms`);
console.log(`  取得件数: ${batchItems.length} 件`);
console.log(`  グラウンディング sourceUrlKind: ${batchKind}`);
console.log(`\n  テーマ一覧（目視確認）:`);
for (const [i, item] of batchItems.entries()) {
  const url = item.sourceUrl ? item.sourceUrl.slice(0, 60) : "(なし)";
  console.log(`  [${i + 1}] ${(item.theme ?? "(取得失敗)").padEnd(24)} sourceUrl=${url}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 【比較サマリー】
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log("【比較サマリー】");
console.log("═".repeat(60));
console.log(`  シングル方式 (${SINGLE_TRIES}回):`);
console.log(`    合計時間: ${singleElapsed}ms / 平均: ${Math.round(singleElapsed / SINGLE_TRIES)}ms/件`);
console.log(`    sourceUrlKind 分布:`, singleSummary.counts);
console.log(`    fallback 率: ${singleSummary.fallbackRate}%`);
console.log();
console.log(`  バッチ方式 (1回で${batchItems.length}件):`);
console.log(`    合計時間: ${batchMs}ms`);
console.log(`    sourceUrlKind: ${batchKind}`);
console.log(`    ※ バッチはグラウンディングチャンクが全候補共通のため個別判定不可`);
console.log();
console.log("【判断のポイント】");
console.log("  - バッチで google-search-fallback が返る → 候補全件が根拠なしになる");
console.log("  - シングルで fallback 率が低い → 個別呼び出しはグラウンディング有効");
console.log("  - 時間差がコスト設計の参考になる（シングルは並列化で短縮可能）");
