/**
 * scripts/test-fal-models.mjs
 *
 * fal.ai のアップスケールモデルを実際に呼び出し、
 * 出力サイズ・処理時間・フォーマットを比較するスクリプト。
 *
 * 実行方法:
 *   export FAL_KEY=<あなたのFAL_KEY>
 *   node scripts/test-fal-models.mjs
 *
 * ⚠ fal.ai APIクレジットを消費します。
 * ⚠ このサンドボックスからは実行できません。ローカル環境で実行してください。
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("FAL_KEY が設定されていません。export FAL_KEY=xxx を実行してください。");
  process.exit(1);
}

// テスト用の小さな画像（1x1 白ピクセルのJPEG base64）
// 実際の生成画像に近いサイズに差し替えると精度が上がる
const SMALL_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" +
  "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN" +
  "DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy" +
  "MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";

// テスト用画像URL（小さめの猫画像 ~400px）
const TEST_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/400px-Cat03.jpg";

const FAL_QUEUE_BASE = "https://queue.fal.run";
const MODELS = [
  {
    id: "fal-ai/aura-sr",
    label: "AuraSR 4x（現行）",
    body: { image_url: TEST_IMAGE_URL },
  },
  {
    id: "fal-ai/aura-sr",
    label: "AuraSR upscaling_factor=2（2x試験）",
    body: { image_url: TEST_IMAGE_URL, upscaling_factor: 2 },
  },
  {
    id: "fal-ai/esrgan",
    label: "ESRGAN（デフォルト）",
    body: { image_url: TEST_IMAGE_URL },
  },
  {
    id: "fal-ai/clarity-upscaler",
    label: "Clarity Upscaler（デフォルト）",
    body: { image_url: TEST_IMAGE_URL },
  },
];

async function submitJob(modelId, body) {
  const res = await fetch(`${FAL_QUEUE_BASE}/${modelId}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`submit失敗 status=${res.status} ${err}`);
  }
  const data = await res.json();
  return data.request_id;
}

async function pollResult(modelId, requestId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3_000));
    const res = await fetch(`${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}/status`, {
      headers: { "Authorization": `Key ${FAL_KEY}` },
    });
    if (!res.ok) continue;
    const { status } = await res.json();
    if (status === "COMPLETED") {
      const elapsed = Date.now() - start;
      const resultRes = await fetch(`${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}`, {
        headers: { "Authorization": `Key ${FAL_KEY}` },
      });
      const result = await resultRes.json();
      return { result, elapsedMs: elapsed };
    }
    if (status === "FAILED") throw new Error("ジョブ失敗");
    process.stdout.write(".");
  }
  throw new Error("タイムアウト（120秒）");
}

async function measureOutputSize(cdnUrl) {
  const res = await fetch(cdnUrl);
  if (!res.ok) return { bytes: -1, mimeType: "unknown" };
  const buf = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "unknown";
  return { bytes: buf.byteLength, mimeType };
}

console.log("=== fal.ai アップスケールモデル比較 ===\n");
console.log(`テスト画像: ${TEST_IMAGE_URL}\n`);

const results = [];

for (const model of MODELS) {
  process.stdout.write(`\n[${model.label}] 投入中... `);
  try {
    const requestId = await submitJob(model.id, model.body);
    process.stdout.write(`投入完了 (${requestId.slice(0, 8)}...) ポーリング中`);
    const { result, elapsedMs } = await pollResult(model.id, requestId);
    // モデルによりレスポンス構造が異なるため候補を全探索
    const cdnUrl =
      result?.image?.url ??
      result?.images?.[0]?.url ??
      result?.output?.image?.url ??
      result?.output?.[0]?.url ??
      result?.url;
    console.log(`  → result keys: ${Object.keys(result ?? {}).join(", ")}`);
    if (!cdnUrl) {
      console.log(`  → raw result: ${JSON.stringify(result).slice(0, 300)}`);
      throw new Error("CDN URL が取得できません");
    }

    process.stdout.write(` 完了\n  → CDN URL: ${cdnUrl}\n  → サイズ計測中... `);
    const { bytes, mimeType } = await measureOutputSize(cdnUrl);
    const mb = (bytes / 1_000_000).toFixed(2);
    const sec = (elapsedMs / 1000).toFixed(1);

    const ok20mb = bytes <= 20_000_000 ? "✅" : "❌";
    console.log(`${bytes.toLocaleString()} bytes (${mb} MB) ${ok20mb}  形式: ${mimeType}  処理時間: ${sec}秒`);
    results.push({ label: model.label, bytes, mb, mimeType, sec, ok20mb, cdnUrl });
  } catch (e) {
    console.log(`\n  ❌ エラー: ${e.message}`);
    results.push({ label: model.label, error: e.message });
  }
}

console.log("\n=== 結果サマリー ===");
console.log("モデル                              | サイズ    | 20MB制限 | 形式    | 処理時間");
console.log("-".repeat(80));
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(36)}| エラー: ${r.error}`);
  } else {
    console.log(
      `${r.label.padEnd(36)}| ${(r.mb + " MB").padEnd(10)}| ${r.ok20mb}        | ${r.mimeType.padEnd(8)}| ${r.sec}秒`
    );
  }
}

console.log("\n=== 判定基準 ===");
console.log("SUZURI上限: 20MB");
console.log("SUZURI推奨解像度: 3000px以上");
console.log("Tシャツ品質として許容: 2048px以上（元画像の2倍以上）");
