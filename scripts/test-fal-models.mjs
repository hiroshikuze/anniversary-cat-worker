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

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("FAL_KEY が設定されていません。export FAL_KEY=xxx を実行してください。");
  process.exit(1);
}

// fal.ai はURLから直接画像を取得できないケースがあるため、
// まずローカルでURLから画像を取得してbase64 data URIに変換する（本番と同じ方式）
const TEST_IMAGE_SOURCE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/400px-Cat03.jpg";

async function loadTestImageAsDataUri() {
  process.stdout.write(`テスト画像を取得中 (${TEST_IMAGE_SOURCE_URL})... `);
  const res = await fetch(TEST_IMAGE_SOURCE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; test-script)" },
  });
  if (!res.ok) throw new Error(`画像取得失敗: status=${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const b64 = Buffer.from(buf).toString("base64");
  console.log(`完了 (${(buf.byteLength / 1024).toFixed(0)} KB)`);
  return `data:${mime};base64,${b64}`;
}

const FAL_QUEUE_BASE = "https://queue.fal.run";

const MODELS = [
  {
    id: "fal-ai/aura-sr",
    label: "AuraSR 4x（現行）",
    makeBody: (imageDataUri) => ({ image_url: imageDataUri }),
  },
  {
    id: "fal-ai/aura-sr",
    label: "AuraSR upscaling_factor=2（2x試験）",
    makeBody: (imageDataUri) => ({ image_url: imageDataUri, upscaling_factor: 2 }),
  },
  {
    id: "fal-ai/esrgan",
    label: "ESRGAN（デフォルト）",
    makeBody: (imageDataUri) => ({ image_url: imageDataUri }),
  },
  {
    id: "fal-ai/clarity-upscaler",
    label: "Clarity Upscaler（デフォルト）",
    makeBody: (imageDataUri) => ({ image_url: imageDataUri }),
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
    throw new Error(`submit失敗 status=${res.status} ${err.slice(0, 200)}`);
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
  throw new Error("タイムアウト（180秒）");
}

function extractCdnUrl(result) {
  // モデルによりレスポンス構造が異なるため候補を全探索
  return (
    result?.image?.url ??
    result?.images?.[0]?.url ??
    result?.output?.image?.url ??
    result?.output?.[0]?.url ??
    result?.output?.url ??
    result?.url ??
    null
  );
}

async function measureOutput(cdnUrl) {
  const res = await fetch(cdnUrl);
  if (!res.ok) return { bytes: -1, mimeType: "unknown", width: -1, height: -1 };
  const buf = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "unknown";
  const { width, height } = parsePngDimensions(buf);
  return { bytes: buf.byteLength, mimeType, width, height };
}

// PNG IHDRチャンクから幅・高さを取得（依存ライブラリなし）
function parsePngDimensions(buf) {
  const view = new DataView(buf);
  // PNG signature: 8 bytes, IHDR chunk: 4(length)+4(type)+4(width)+4(height)
  try {
    if (view.getUint32(0) === 0x89504e47) { // PNG
      const width  = view.getUint32(16);
      const height = view.getUint32(20);
      return { width, height };
    }
  } catch {}
  return { width: -1, height: -1 };
}

// メイン処理
console.log("=== fal.ai アップスケールモデル比較 ===\n");

let testImageDataUri;
try {
  testImageDataUri = await loadTestImageAsDataUri();
} catch (e) {
  console.error(`テスト画像の取得に失敗しました: ${e.message}`);
  process.exit(1);
}

const results = [];

for (const model of MODELS) {
  process.stdout.write(`\n[${model.label}] 投入中... `);
  try {
    const body = model.makeBody(testImageDataUri);
    const requestId = await submitJob(model.id, body);
    process.stdout.write(`投入完了 (${requestId.slice(0, 8)}...) ポーリング中`);
    const { result, elapsedMs } = await pollResult(model.id, requestId);

    const cdnUrl = extractCdnUrl(result);
    if (!cdnUrl) {
      console.log(`\n  result keys: ${Object.keys(result ?? {}).join(", ")}`);
      console.log(`  raw result: ${JSON.stringify(result).slice(0, 400)}`);
      throw new Error("CDN URL が取得できません");
    }

    process.stdout.write(` 完了\n  → CDN URL: ${cdnUrl}\n  → サイズ・解像度計測中... `);
    const { bytes, mimeType, width, height } = await measureOutput(cdnUrl);
    const mb = (bytes / 1_000_000).toFixed(2);
    const sec = (elapsedMs / 1000).toFixed(1);
    const ok20mb = bytes <= 20_000_000 ? "✅" : "❌";
    const dimStr = width > 0 ? `${width}×${height}px` : "不明";
    // 入力400pxに対する倍率
    const scaleStr = width > 0 ? `(${(width / 400).toFixed(1)}x)` : "";

    console.log(`${bytes.toLocaleString()} bytes (${mb} MB) ${ok20mb}  ${dimStr} ${scaleStr}  形式: ${mimeType}  処理時間: ${sec}秒`);
    results.push({ label: model.label, bytes, mb, mimeType, sec, ok20mb, width, height, scaleStr });
  } catch (e) {
    console.log(`\n  ❌ エラー: ${e.message}`);
    results.push({ label: model.label, error: e.message });
  }
}

console.log("\n=== 結果サマリー ===");
console.log("モデル                                  | サイズ      | 20MB | 解像度            | 倍率  | 処理時間");
console.log("-".repeat(95));
for (const r of results) {
  if (r.error) {
    console.log(`${r.label.padEnd(40)}| エラー: ${r.error}`);
  } else {
    const dim = r.width > 0 ? `${r.width}×${r.height}` : "不明";
    console.log(
      `${r.label.padEnd(40)}| ${(r.mb + " MB").padEnd(12)}| ${r.ok20mb}   | ${dim.padEnd(18)}| ${(r.scaleStr ?? "").padEnd(6)}| ${r.sec}秒`
    );
  }
}

console.log("\n=== 判定基準 ===");
console.log("SUZURI上限: 20MB");
console.log("SUZURI推奨解像度: 3000px以上");
console.log("Tシャツ品質として許容: 2048px以上（元画像の2倍以上）");
