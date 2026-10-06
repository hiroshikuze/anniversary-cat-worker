/**
 * テーマ連動「ウィットに富んだ一言」(themeHook) 生成の品質検証スクリプト
 *
 * 使い方:
 *   GEMINI_API_KEY=your_key node scripts/test-theme-hook.mjs
 *
 * 目的:
 *   Bluesky短縮版投稿用に「テーマ＋猫」を絡めた一言（themeHook/themeHookEn）を
 *   Geminiで安定して生成できるかを、実装前に目視確認する。
 *   本番の handleResearch() には組み込まず、プロンプト案の比較のみを行う。
 *
 * 比較観点:
 *   - テーマごとに毎回違う言い回しになるか（同一テーマを2回試行して比較）
 *   - 事実説明（description）に寄らずウィット・問いかけ調になっているか
 *   - 英語版（themeHookEn）がそのまま海外向けに使える自然さか
 *   - 生成失敗・空文字・不適切な長さ（Blueskyは短尺が望ましい）のケースがないか
 *
 * 注意:
 *   実際のGemini APIを呼び出します。課金が発生します。
 */

import https from "node:https";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ GEMINI_API_KEY が未設定です");
  process.exit(1);
}

const MODEL = "gemini-2.5-flash";
const HOST  = "generativelanguage.googleapis.com";
const BASE  = `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

// 実際の運用で出てきそうなテーマを、カテゴリーの異なる例でカバーする
const TEST_CASES = [
  {
    theme: "国際協力の日",
    description: "国際社会における協力の重要性を考える日。日本の国際協力への貢献を広めることを目的としている。",
  },
  {
    theme: "象の日",
    description: "タイの象の保護を目的に制定された日。日本では上野動物園に初めて象が来園した日として知られる。",
  },
  {
    theme: "大仏の日",
    description: "奈良の大仏が奈良時代に開眼法要を迎えた日。日本最大級の仏像として知られる。",
  },
  {
    theme: "草の日",
    description: "「く（9）さ（3）」の語呂合わせから。身近な草花に目を向けるきっかけの日。",
  },
  {
    theme: "図書館記念日",
    description: "図書館法が公布された日。本と図書館の役割を見直す記念日。",
  },
  {
    theme: "世界猫の日",
    description: "猫との共生を考える国際的な記念日。多くの国でイベントが行われる。",
  },
];

// プロンプト案（1案のみ。必要なら複数案を配列で比較してもよい）
function buildHookPrompt(theme, description) {
  return (
    `あなたは「にゃんバーサリー」という、猫のイラストで日本の記念日を紹介するSNSアカウントの中の人です。\n` +
    `以下のテーマについて、猫目線で呟くような、ウィットに富んだ一言をひとつ考えてください。\n\n` +
    `テーマ: ${theme}\n` +
    `説明: ${description}\n\n` +
    `条件:\n` +
    `- 説明文の内容をそのまま要約しない（事実説明ではなく問いかけ・つぶやき・ボケ寄りのトーン）\n` +
    `- 猫が話している/思っているていで書く（「〜かな？」「〜してみたい」等の口語）\n` +
    `- 日本語は20〜30文字程度、短く\n` +
    `- 絵文字は使わない\n` +
    `- 英語版（themeHookEn）も用意する。直訳ではなく英語として自然な短いフレーズにする\n\n` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` +
    `{"themeHook":"日本語の一言","themeHookEn":"English one-liner"}`
  );
}

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9 },
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

function extractHook(data) {
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  try {
    const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    return { themeHook: parsed.themeHook ?? "(なし)", themeHookEn: parsed.themeHookEn ?? "(なし)" };
  } catch {
    return { themeHook: "(JSON解析失敗)", themeHookEn: rawText.slice(0, 80) };
  }
}

console.log(`${"═".repeat(70)}`);
console.log(`themeHook生成テスト（同一テーマを2回試行して言い回しのブレを確認）`);
console.log("═".repeat(70));

for (const { theme, description } of TEST_CASES) {
  console.log(`\n【${theme}】`);
  console.log(`  説明: ${description}`);

  for (let trial = 1; trial <= 2; trial++) {
    const prompt = buildHookPrompt(theme, description);
    const t0 = Date.now();
    const data = await callGemini(prompt);
    const ms = Date.now() - t0;
    const { themeHook, themeHookEn } = extractHook(data);

    const jaLen = [...themeHook].length;
    console.log(`  [${trial}回目 ${ms}ms, ${jaLen}文字]`);
    console.log(`    JA: ${themeHook}`);
    console.log(`    EN: ${themeHookEn}`);
  }
}

console.log(`\n${"═".repeat(70)}`);
console.log("【確認ポイント】");
console.log("  - 同一テーマの2回で表現が変わっているか（ワンパターンでないか）");
console.log("  - 説明文の言い換えになっていないか（ウィット・問いかけ調か）");
console.log("  - 日本語が短尺（20〜30文字目安）に収まっているか");
console.log("  - 英語版が直訳調でなく自然か");
console.log("═".repeat(70));
