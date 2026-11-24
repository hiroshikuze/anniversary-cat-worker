#!/usr/bin/env node
/**
 * test-compare-image-models.mjs - scripts/compare-image-models.mjs ユニットテスト
 *
 * 外部API接続は不要（純粋関数のみ）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-compare-image-models.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import {
  DEFAULT_MODELS,
  CASES,
  PRICES,
  parseArgs,
  buildRequestBody,
  extractImage,
  parseUsage,
  estimateCostUsd,
  summarize,
  redactKey,
  safeFileName,
  buildReportHtml,
} from "./compare-image-models.mjs";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// ---------------------------------------------------------------------------
console.log("\n[parseArgs]");
{
  const d = parseArgs([]);
  assert("既定のモデルは2つ（現行と3.1 flash-lite-image）", d.models.length === 2 && d.models[0] === "gemini-2.5-flash-image" && d.models[1] === "gemini-3.1-flash-lite-image");
  assert("既定の試行回数は2", d.trials === 2);
  assert("既定はdry-runでない", d.dryRun === false);
  assert("既定の出力先はtmp/image-model-compare", d.out === "tmp/image-model-compare");

  const c = parseArgs(["--models", "a,b , c", "--trials", "3", "--out", "tmp/x", "--dry-run"]);
  assert("--modelsはカンマ区切り・空白を除く", c.models.join("|") === "a|b|c");
  assert("--trialsを数値にする", c.trials === 3);
  assert("--outを受け取る", c.out === "tmp/x");
  assert("--dry-run", c.dryRun === true);

  assert("--trialsが0なら例外", throws(() => parseArgs(["--trials", "0"])));
  assert("--trialsが数値でなければ例外", throws(() => parseArgs(["--trials", "abc"])));
  assert("--trialsが大きすぎれば例外（課金の事故防止）", throws(() => parseArgs(["--trials", "11"])));
  assert("--modelsが空なら例外", throws(() => parseArgs(["--models", ""])));
  assert("未知の引数は例外", throws(() => parseArgs(["--unknown"])));
  assert("値のない--modelsは例外", throws(() => parseArgs(["--models"])));
  assert("DEFAULT_MODELSと一致", d.models.join() === DEFAULT_MODELS.join());
}

// ---------------------------------------------------------------------------
console.log("\n[ケース（プロンプト）]");
{
  assert("ケースは3つ以上", CASES.length >= 3);
  assert("idが重複しない", new Set(CASES.map((c) => c.id)).size === CASES.length);
  assert("本番の_buildGeminiPrompt()で作られている", CASES.every((c) => c.prompt.startsWith("Create a cute kawaii watercolor style cat character illustration.")));
  assert("文字禁止の指示を含む", CASES.every((c) => c.prompt.includes("Do not include any text")));
  assert("猫以外に顔をつけない指示を含む（Bug#33）", CASES.every((c) => c.prompt.includes("Only the cat(s) described above should have a face")));
  assert("各ケースにテーマ名がある", CASES.every((c) => typeof c.theme === "string" && c.theme.length > 0));
}

// ---------------------------------------------------------------------------
console.log("\n[buildRequestBody / extractImage]");
{
  const body = buildRequestBody("hello");
  assert("本番と同じresponseModalities", JSON.stringify(body.generationConfig.responseModalities) === JSON.stringify(["IMAGE", "TEXT"]));
  assert("プロンプトがpartsに入る", body.contents[0].parts[0].text === "hello");

  const ok = extractImage({ candidates: [{ content: { parts: [{ text: "t" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] } }] });
  assert("画像パートを取り出す", ok.mimeType === "image/png" && ok.data === "QUJD");
  assert("mimeTypeが無ければimage/png", extractImage({ candidates: [{ content: { parts: [{ inlineData: { data: "QUJD" } }] } }] }).mimeType === "image/png");
  assert("画像パートが無ければnull", extractImage({ candidates: [{ content: { parts: [{ text: "only text" }] } }] }) === null);
  assert("candidatesが無ければnull", extractImage({}) === null);
  assert("空の入力でもnull", extractImage(null) === null);
}

// ---------------------------------------------------------------------------
console.log("\n[parseUsage]");
{
  const u = parseUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 1400,
    totalTokenCount: 1500,
    candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }, { modality: "TEXT", tokenCount: 110 }],
  });
  assert("入力トークン", u.prompt === 100);
  assert("画像トークンは詳細のIMAGEの合計", u.image === 1290);
  assert("テキストトークンは出力から画像を引く", u.text === 110);
  assert("合計", u.total === 1500);
  assert("画像の内訳が分かる", u.imageKnown === true);

  const t = parseUsage({ promptTokenCount: 50, candidatesTokenCount: 1290, thoughtsTokenCount: 200, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }] });
  assert("思考トークンはテキスト側に数える", t.text === 200 && t.image === 1290);
  assert("totalTokenCountが無ければ合算", t.total === 50 + 1290 + 200);

  const n = parseUsage({ promptTokenCount: 10, candidatesTokenCount: 1300, totalTokenCount: 1310 });
  assert("詳細が無ければ画像の内訳は不明", n.imageKnown === false && n.image === 0);

  const e = parseUsage(undefined);
  assert("usageが無くても0で返す", e.prompt === 0 && e.text === 0 && e.image === 0 && e.total === 0 && e.imageKnown === false);
  assert("出力より画像が多くてもテキストは負にならない", parseUsage({ candidatesTokenCount: 5, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 9 }] }).text === 0);
}

// ---------------------------------------------------------------------------
console.log("\n[estimateCostUsd]");
{
  const price = { input: 0.25, textOut: 1.5, imageOut: 30 };
  const usage = { prompt: 1_000_000, text: 1_000_000, image: 1_000_000, total: 3_000_000, imageKnown: true };
  assert("入力＋テキスト＋画像の合計", Math.abs(estimateCostUsd(usage, price) - (0.25 + 1.5 + 30)) < 1e-9);
  assert("1枚の目安（約1,290画像トークン）", Math.abs(estimateCostUsd({ prompt: 0, text: 0, image: 1290, total: 1290, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) - 0.0387) < 1e-9);
  assert("テキストが0なら、テキスト価格が不明でも計算できる", estimateCostUsd({ prompt: 100, text: 0, image: 1290, total: 1390, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) !== null);
  assert("テキストがあるのにテキスト価格が不明ならnull", estimateCostUsd({ prompt: 0, text: 5, image: 1290, total: 1295, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) === null);
  assert("画像の内訳が不明ならnull", estimateCostUsd({ prompt: 1, text: 0, image: 0, total: 1, imageKnown: false }, price) === null);
  assert("価格表に無いモデルならnull", estimateCostUsd(usage, undefined) === null);
  assert("PRICESに既定モデルの価格がある", DEFAULT_MODELS.every((m) => PRICES[m]));
}

// ---------------------------------------------------------------------------
console.log("\n[summarize]");
{
  const trials = [
    { success: true, elapsedMs: 8000, bytes: 1000, usage: { total: 1500 }, costUsd: 0.04 },
    { success: true, elapsedMs: 10000, bytes: 3000, usage: { total: 1700 }, costUsd: 0.05 },
    { success: false, elapsedMs: 2000, error: "x" },
  ];
  const s = summarize(trials);
  assert("試行数・成功数", s.trials === 3 && s.successes === 2);
  assert("成功率", Math.abs(s.successRate - 2 / 3) < 1e-9);
  assert("所要時間は成功した試行だけで集計", s.minMs === 8000 && s.maxMs === 10000 && s.avgMs === 9000);
  assert("平均のバイト数・トークン", s.avgBytes === 2000 && s.avgTokens === 1600);
  assert("平均コスト", Math.abs(s.avgCostUsd - 0.045) < 1e-9);
  assert("12秒以内の件数", s.within12s === 2);

  const slow = summarize([{ success: true, elapsedMs: 13000, bytes: 1, usage: { total: 1 }, costUsd: null }]);
  assert("12秒を超えた成功は12秒以内に数えない", slow.within12s === 0);
  assert("コストが不明なら平均コストもnull", slow.avgCostUsd === null);

  const none = summarize([{ success: false, elapsedMs: 1, error: "e" }]);
  assert("全失敗なら集計値はnull", none.successes === 0 && none.avgMs === null && none.minMs === null && none.avgBytes === null && none.avgCostUsd === null);
  const empty = summarize([]);
  assert("空でも例外にならず成功率は0", empty.trials === 0 && empty.successRate === 0);
}

// ---------------------------------------------------------------------------
console.log("\n[redactKey / safeFileName]");
{
  assert("APIキーを***に置き換える", redactKey("failed key=SECRET123 and SECRET123", "SECRET123") === "failed key=*** and ***");
  assert("キーが空なら何もしない", redactKey("abc", "") === "abc");
  assert("URLのkeyパラメーターも伏せる", !redactKey("https://x/y?key=abcdef&z=1", "").includes("abcdef"));
  assert("ファイル名に使えない文字を置き換える", safeFileName("a/b c:d") === "a_b_c_d");
  assert("英数字・ドット・ハイフンはそのまま", safeFileName("gemini-3.1-flash-lite-image") === "gemini-3.1-flash-lite-image");
}

// ---------------------------------------------------------------------------
console.log("\n[buildReportHtml]");
{
  const report = {
    startedAt: "2026-11-24T00:00:00.000Z",
    models: ["m<1>", "m2"],
    cases: [{ id: "case1", theme: "<script>alert(1)</script>" }],
    trials: [
      { model: "m<1>", caseId: "case1", n: 1, success: true, elapsedMs: 9000, bytes: 2048, usage: { total: 1500 }, costUsd: 0.04, file: "m_1___case1__1.png" },
      { model: "m2", caseId: "case1", n: 1, success: false, elapsedMs: 100, error: "boom <b>" },
    ],
    summaries: {
      "m<1>": summarize([{ success: true, elapsedMs: 9000, bytes: 2048, usage: { total: 1500 }, costUsd: 0.04 }]),
      m2: summarize([{ success: false, elapsedMs: 100, error: "boom" }]),
    },
  };
  const html = buildReportHtml(report);
  assert("HTMLの文書になっている", html.startsWith("<!doctype html>") && html.includes("<title>"));
  assert("モデル名の<をエスケープ", !html.includes("m<1>") && html.includes("m&lt;1&gt;"));
  assert("テーマ名のスクリプトをエスケープ", !html.includes("<script>alert(1)</script>"));
  assert("失敗の理由もエスケープして載せる", html.includes("boom &lt;b&gt;"));
  assert("画像を相対パスで参照する", html.includes('src="m_1___case1__1.png"'));
  assert("目視のチェック項目を載せる", html.includes("文字の混入") && html.includes("猫以外の顔"));
  assert("価格は要確認の注記がある", html.includes("要確認"));
  assert("APIキーらしい文字列（key=）を含まない", !/key=/i.test(html));
}

console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
