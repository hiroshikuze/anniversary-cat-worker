/**
 * Gemini 画像生成の所要時間を実測するスクリプト
 *
 * 使い方:
 *   GEMINI_API_KEY=your_key node scripts/test-gemini-image-timing.mjs
 *
 * 目的:
 *   handleGenerate() における tryGemini() の実際の所要時間を計測し、
 *   Pollinations との競合設計（遅延時間・タイムアウト値）の根拠とする
 */

import https from "node:https";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ GEMINI_API_KEY が未設定です");
  process.exit(1);
}

const MODEL = "gemini-2.5-flash-image";
const HOST = "generativelanguage.googleapis.com";
const PATH = `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

// 本番と同等のプロンプト（花まつりテーマで固定）
const PROMPT =
  "Create a cute kawaii watercolor style cat character illustration. " +
  "Cat appearance: orange mackerel tabby with white chest, amber eyes. " +
  "Cat personality and pose: leaning forward with wide eyes, investigating theme item curiously. " +
  "Theme: 花まつり（灌仏会）. " +
  "Context: 釈迦の誕生日を祝う仏教行事。甘茶を誕生仏に注ぐ風習がある。. " +
  "Visual elements to incorporate: lotus flower, baby Buddha statue, sweet tea ceremony, temple bell, cherry blossom petals, incense smoke, soft golden light. " +
  "Style: soft pastel colors, white background, Japanese kawaii style. " +
  "The cat is holding or surrounded by items related to the theme. " +
  "High quality charming illustration. " +
  "IMPORTANT: Do not include any text, letters, words, titles, captions, or typography in the image.";

const BODY = JSON.stringify({
  contents: [{ parts: [{ text: PROMPT }] }],
  generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
});

function httpsPost(host, path, body, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`タイムアウト (${timeoutMs}ms)`));
    }, timeoutMs);

    const req = https.request(
      { hostname: host, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch {
            reject(new Error(`JSON parse error: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

const TRIALS = 3;

async function runTrial(trialNum) {
  console.log(`\n--- Trial ${trialNum}/${TRIALS} ---`);
  const start = Date.now();

  try {
    const { status, data } = await httpsPost(HOST, PATH, BODY, 60_000);
    const elapsed = Date.now() - start;

    if (status !== 200) {
      const msg = data.error?.message ?? `status=${status}`;
      console.log(`❌ 失敗 (${elapsed}ms): ${msg}`);
      return { success: false, elapsed, error: msg };
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData);

    if (!imagePart) {
      const text = parts.find((p) => p.text)?.text ?? "";
      console.log(`⚠️  画像パートなし (${elapsed}ms): ${text.slice(0, 100)}`);
      return { success: false, elapsed, error: "no image part" };
    }

    const sizeKB = Math.round((imagePart.inlineData.data.length * 3) / 4 / 1024);
    console.log(`✅ 成功 ${elapsed}ms  mimeType=${imagePart.inlineData.mimeType}  size≈${sizeKB}KB`);
    return { success: true, elapsed };
  } catch (e) {
    const elapsed = Date.now() - start;
    console.log(`❌ エラー (${elapsed}ms): ${e.message}`);
    return { success: false, elapsed, error: e.message };
  }
}

const results = [];
for (let i = 1; i <= TRIALS; i++) {
  results.push(await runTrial(i));
  if (i < TRIALS) {
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

console.log("\n========== 集計 ==========");
const successes = results.filter((r) => r.success);
const failures = results.filter((r) => !r.success);

if (successes.length > 0) {
  const times = successes.map((r) => r.elapsed);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`成功: ${successes.length}/${TRIALS}回`);
  console.log(`所要時間: 最小=${min}ms  最大=${max}ms  平均=${avg}ms`);
  console.log(`\n推奨設定:`);
  console.log(`  Pollinationsへのフォールバック遅延: ${Math.round(avg / 1000) + 2}秒（平均+2秒）`);
  console.log(`  Geminiタイムアウト上限: ${Math.round(max / 1000) + 5}秒（最大+5秒）`);
} else {
  console.log(`成功: 0/${TRIALS}回（全試行失敗）`);
}
if (failures.length > 0) {
  console.log(`失敗理由: ${failures.map((r) => r.error).join(", ")}`);
}
