/**
 * Cloudflare Worker - Anniversary Cat API Proxy + Bluesky Bot
 * @updated 2026-03-23
 *
 * 環境変数（secrets）:
 *   GEMINI_API_KEY  ... Cloudflare ダッシュボード > Settings > Variables and Secrets で設定
 *
 * 環境変数（vars / wrangler.toml）:
 *   ALLOWED_ORIGIN  ... GitHub Pages の URL（例: https://hiroshikuze.github.io）
 */

import { runBot, notifyDiscord } from "./bluesky-bot.js";
import { saveToR2, getMetaFromR2, getImageFromR2, listExpiredIds, deleteFromR2, updateMetaInR2 } from "./r2-storage.js";
import { createSuzuriProducts, deleteSuzuriMaterial } from "./suzuri.js";
import { submitFalJob, getFalResult } from "./fal.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ---------------------------------------------------------------------------
// レート制限設定
// ---------------------------------------------------------------------------
const RATE_LIMITS = {
  generate: { perIp: 3,  global: 50  },
  research: { perIp: 10, global: null },
};

/**
 * バイパストークンが有効かチェック
 * ブラウザのコンソールで localStorage.setItem('bypassToken', '<値>') を実行しておくと
 * フロントエンドがこのヘッダーを付与し、レート制限をスキップします
 */
function isBypassed(request, env) {
  if (!env.BYPASS_TOKEN) return false;
  return request.headers.get("X-Bypass-Token") === env.BYPASS_TOKEN;
}

/**
 * レート制限チェック＆カウント更新
 * 上限超過時は { limited: true, message } を返す。問題なければ { limited: false }
 */
async function checkRateLimit(kv, ip, endpoint) {
  const limits = RATE_LIMITS[endpoint];
  if (!limits || !kv) return { limited: false };

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const TTL   = 25 * 60 * 60; // 25時間（日付をまたいでも翌日リセットされる）

  // --- IP別チェック ---
  const ipKey   = `ip:${ip}:${today}:${endpoint}`;
  const ipCount = parseInt((await kv.get(ipKey)) ?? "0");
  if (ipCount >= limits.perIp) {
    return { limited: true, message: `本日の利用上限（${limits.perIp}回）に達しました。明日またお試しください。` };
  }

  // --- グローバルチェック ---
  if (limits.global !== null) {
    const globalKey   = `global:${today}:${endpoint}`;
    const globalCount = parseInt((await kv.get(globalKey)) ?? "0");
    if (globalCount >= limits.global) {
      return { limited: true, message: "本日のサービス全体の利用上限に達しました。明日またお試しください。" };
    }
    await kv.put(globalKey, String(globalCount + 1), { expirationTtl: TTL });
  }

  // --- カウント更新 ---
  await kv.put(ipKey, String(ipCount + 1), { expirationTtl: TTL });

  return { limited: false };
}

// ---------------------------------------------------------------------------
// モデル自動選択（1時間キャッシュ）
// ---------------------------------------------------------------------------
let _modelCache = { name: null, expiry: 0 };

async function selectBestModel(apiKey) {
  const now = Date.now();
  if (_modelCache.name && now < _modelCache.expiry) {
    return _modelCache.name;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    const data = await res.json();

    const candidates = (data.models ?? [])
      .filter(m => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .filter(m => m.name.includes("gemini"))
      .filter(m => !m.name.includes("embedding") && !m.name.includes("aqa"))
      // -exp 単体モデルは無料枠クォータが0のため除外（-exp-image-generation は別途扱う）
      .filter(m => !/models\/.*-exp$/.test(m.name));

    const scored = candidates.map(m => {
      let score = 0;
      if (m.name.includes("flash"))    score += 20;
      if (!m.name.includes("preview")) score += 10;
      const ver = m.name.match(/gemini-(\d+)\.(\d+)/);
      if (ver) score += parseInt(ver[1]) * 3 + parseInt(ver[2]);
      return { shortName: m.name.replace("models/", ""), score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0]?.shortName ?? "gemini-1.5-flash";

    console.log("[model-select] selected:", selected,
      "| candidates:", scored.slice(0, 3).map(s => `${s.shortName}(${s.score})`).join(", "));

    _modelCache = { name: selected, expiry: now + 60 * 60 * 1000 };
    return selected;
  } catch (e) {
    console.warn("[model-select] fallback due to:", e.message);
    return _modelCache.name ?? "gemini-1.5-flash";
  }
}

// ---------------------------------------------------------------------------
// CORS ヘッダー生成
// ---------------------------------------------------------------------------
function makeCorsHeaders(origin, allowedOrigin) {
  const isLocal =
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");
  const isAllowed = !allowedOrigin || origin === allowedOrigin || isLocal;

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : (allowedOrigin || "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Bypass-Token",
    "Access-Control-Max-Age": "86400",
  };
}

// ---------------------------------------------------------------------------
// XML特殊文字エスケープ（RSS生成用）
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// JST日付文字列（YYYY-MM-DD）を返す
function toJSTDateStringWorker(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 事前リサーチプール ― SEASONAL_FLOWERS / getSeasonalFlower / filterAndDedupePool
// ---------------------------------------------------------------------------

const SEASONAL_FLOWERS = [
  { startMd: "01-01", endMd: "01-15", name: "寒椿" },
  { startMd: "01-16", endMd: "01-31", name: "水仙" },
  { startMd: "02-01", endMd: "02-14", name: "蝋梅" },
  { startMd: "02-15", endMd: "02-28", name: "梅" },
  { startMd: "03-01", endMd: "03-15", name: "菜の花" },
  { startMd: "03-16", endMd: "03-31", name: "彼岸桜" },
  { startMd: "04-01", endMd: "04-15", name: "染井吉野" },
  { startMd: "04-16", endMd: "04-30", name: "藤" },
  { startMd: "05-01", endMd: "05-15", name: "杜若" },
  { startMd: "05-16", endMd: "05-31", name: "皐月" },
  { startMd: "06-01", endMd: "06-15", name: "紫陽花" },
  { startMd: "06-16", endMd: "06-30", name: "苔" },
  { startMd: "07-01", endMd: "07-15", name: "蓮" },
  { startMd: "07-16", endMd: "07-31", name: "桔梗" },
  { startMd: "08-01", endMd: "08-15", name: "向日葵" },
  { startMd: "08-16", endMd: "08-31", name: "百日紅" },
  { startMd: "09-01", endMd: "09-15", name: "萩" },
  { startMd: "09-16", endMd: "09-30", name: "彼岸花" },
  { startMd: "10-01", endMd: "10-15", name: "秋桜" },
  { startMd: "10-16", endMd: "10-31", name: "金木犀" },
  { startMd: "11-01", endMd: "11-15", name: "菊" },
  { startMd: "11-16", endMd: "11-30", name: "紅葉" },
  { startMd: "12-01", endMd: "12-15", name: "銀杏" },
  { startMd: "12-16", endMd: "12-31", name: "千両" },
];

/** 日付文字列（YYYY-MM-DD）から季節の花名を返す */
export function getSeasonalFlower(dateStr) {
  const md = dateStr.slice(5); // "YYYY-MM-DD" → "MM-DD"
  return SEASONAL_FLOWERS.find(e => md >= e.startMd && md <= e.endMd)?.name ?? "梅";
}

/**
 * handleResearch()の結果配列から google-search-fallback を除外し theme 重複を除去する。
 * @param {object[]} entries - handleResearch()の戻り値の配列
 * @returns {object[]}
 */
export function filterAndDedupePool(entries) {
  const valid = entries.filter(e => e.sourceUrlKind !== "google-search-fallback");
  const seen = new Set();
  return valid.filter(e => {
    if (seen.has(e.theme)) return false;
    seen.add(e.theme);
    return true;
  });
}

/** 季節の花（isSeasonalFallback: true）エントリが選ばれる確率 */
export const SEASONAL_FLOWER_SELECT_PROBABILITY = 0.10;

/**
 * プールから1件を確率制御付きでランダム選択する。
 * 通常エントリが存在する場合、季節の花は SEASONAL_FLOWER_SELECT_PROBABILITY（10%）の確率でのみ選ばれる。
 * 季節の花のみの場合は通常通りランダム選択する。
 *
 * @param {{ entries?: object[] }} pool - R2から取得したプールオブジェクト
 * @param {() => number} [rand=Math.random] - テスト用乱数関数
 * @returns {object|null}
 */
export function pickFromPool(pool, rand = Math.random) {
  const entries  = pool.entries ?? [];
  const normal   = entries.filter(e => !e.isSeasonalFallback);
  const fallback = entries.filter(e => e.isSeasonalFallback);

  if (normal.length === 0) {
    return entries[Math.floor(rand() * entries.length)] ?? null;
  }
  if (fallback.length > 0 && rand() < SEASONAL_FLOWER_SELECT_PROBABILITY) {
    return fallback[Math.floor(rand() * fallback.length)];
  }
  return normal[Math.floor(rand() * normal.length)];
}

/**
 * 当日分のリサーチプールを生成してR2に保存し、Discord通知を送る。
 * Cron `0 15 * * *`（毎日0:00 JST）から呼ばれる。
 */
async function generateResearchPool(env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey || !env.IMAGE_BUCKET) {
    console.log("[pool] スキップ: GEMINI_API_KEY または IMAGE_BUCKET 未設定");
    return;
  }

  const todayJst = toJSTDateStringWorker(new Date());
  const poolKey  = `research-pool/${todayJst}`;

  // 既存プールがあればスキップ（Cron重複発火対策）
  const existing = await env.IMAGE_BUCKET.get(`${poolKey}.json`);
  if (existing) {
    console.log(`[pool] ${todayJst} 既存プールあり・スキップ`);
    return;
  }

  // Geminiプロンプト用の日付文字列
  const [year, month, day] = todayJst.split("-").map(Number);
  const dateStr = `${year}年${month}月${day}日`;

  // 10件並列生成
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => handleResearch({ date: dateStr }, apiKey))
  );

  const raw          = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const failedCount  = results.filter(r => r.status === "rejected").length;
  const fbCount      = raw.filter(e => e.sourceUrlKind === "google-search-fallback").length;
  let   entries      = filterAndDedupePool(raw);

  console.log(`[pool] 取得 ${raw.length}/10件（失敗 ${failedCount}件・fallback除外 ${fbCount}件）→ dedup後 ${entries.length}件`);

  // 3件未満なら季節の花で補充
  let supplemented = false;
  if (entries.length < 3) {
    const flowerName = getSeasonalFlower(todayJst);
    entries = [...entries, {
      theme:              `${flowerName}の季節`,
      description:        `今の季節を彩る${flowerName}`,
      visualHint:         `${flowerName} flowers, Japanese garden, soft petals, gentle breeze`,
      foodItem:           null,
      kanjiChar:          null,
      sourceUrl:          "",
      sourceUrlKind:      "seasonal-flower-fallback",
      isSeasonalFallback: true,
    }];
    supplemented = true;
    console.log(`[pool] 季節の花補充: ${flowerName}`);
  }

  await env.IMAGE_BUCKET.put(
    `${poolKey}.json`,
    JSON.stringify({ entries, generatedAt: new Date().toISOString(), date: todayJst }),
    { httpMetadata: { contentType: "application/json" } }
  );

  const themeList = entries.map((e, i) => `  [${i + 1}] ${e.theme}`).join("\n");
  const msg = [
    `✅ リサーチプール生成完了 ${todayJst}`,
    `📊 生成 ${raw.length}/10件 → fallback除外 ${fbCount}件 → 重複除去後 ${entries.length - (supplemented ? 1 : 0)}件${supplemented ? " → 季節補充1件追加" : ""}`,
    `📅 テーマ一覧:\n${themeList}`,
  ].join("\n");

  try {
    await notifyDiscord(env.DISCORD_WEBHOOK_URL, msg, "✅");
  } catch (e) {
    console.warn(`[pool] Discord通知失敗: ${e.message}`);
  }

  console.log(`[pool] ${todayJst} 完了 ${entries.length}件`);
}

// ---------------------------------------------------------------------------
// 指数バックオフ付きフェッチ（Worker 内 → Google API）
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);
    // 429 quota exceeded はリトライしても無駄なので即リターン
    if (res.status === 429) return res;
    if (res.status >= 500 && i < maxRetries - 1) {
      await new Promise((r) =>
        setTimeout(r, Math.pow(2, i) * 1000 + Math.random() * 500)
      );
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// /research  ― Gemini + Google Search で今日の記念日を調査
// ---------------------------------------------------------------------------
export async function handleResearch(body, apiKey) {
  const { date } = body;
  if (!date) throw new Error("date フィールドが必要です");

  const model = await selectBestModel(apiKey);

  const prompt =
    `今日は${date}です。この日の日本の記念日・季節の行事・季節の花を` +
    `Google検索で調べ、最も特徴的なものを1つ選んでください（速報ニュース・災害・事故・訃報は除く）。` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` +
    `{"theme":"記念日名","description":"50文字以内の説明（日付・曜日は含めない）","visualHint":"このテーマをかわいい猫のイラストで表現するとき使えるASCII英語キーワード5〜8語。テーマの象徴となる動物・物・人物を先頭1〜2語に必ず含め、続いて背景・小物・雰囲気を続ける（例: 象の日→large friendly elephant, Kyoto imperial garden, pine trees, stone lanterns）","foodItem":"その記念日の主な行為・目的が食べることである場合のみ食材・料理名をASCII英語で1〜3語。農業・収穫・行事の象徴として食材が登場するだけの場合はnull。そうでなければnull","kanjiChar":"このテーマを象徴する漢字一字（常用漢字・旧字体不可）。具体的な漢字が思い浮かばない場合はnull","sourceUrl":"参照した実際のURL"}`;

  const res = await fetchWithRetry(
    `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  const resText = await res.text();
  if (!res.ok) {
    let msg;
    try { msg = JSON.parse(resText).error?.message; } catch { msg = resText.slice(0, 120); }
    throw new Error(`Gemini API エラー (${res.status}): ${msg ?? ""}`);
  }
  let data;
  try { data = JSON.parse(resText); } catch {
    throw new Error(`Gemini レスポンス解析エラー: ${resText.slice(0, 120)}`);
  }

  const rawText =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const groundingChunks =
    data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

  let result;
  try {
    const cleaned = rawText.replace(/```json\s*|\s*```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*?\}/);
    result = JSON.parse(match ? match[0] : cleaned);
  } catch {
    result = {
      theme: "記念日",
      description: rawText.slice(0, 50),
      sourceUrl: "",
    };
  }

  const queries =
    data.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];

  // JSON内のsourceUrlがvertexaisearchリダイレクトの場合は除去してフォールバックへ
  if (result.sourceUrl?.includes("vertexaisearch.cloud.google.com")) {
    result.sourceUrl = "";
  }

  // sourceUrlKind を確定する
  // 優先順: json > grounding > vertexaisearch-skipped > google-search-fallback > none
  // vertexaisearch-skipped はグラウンディングが存在する（URLが非表示なだけ）ので
  // google-search-fallback とは区別し、プールフィルタを通過させる。
  const groundingUri = groundingChunks[0]?.web?.uri ?? "";
  let sourceUrlKind;

  if (result.sourceUrl) {
    sourceUrlKind = "json";
  } else if (groundingUri && !groundingUri.includes("vertexaisearch.cloud.google.com")) {
    result.sourceUrl = groundingUri;
    sourceUrlKind = "grounding";
  } else if (groundingUri) {
    // vertexaisearch URL → グラウンディングあり・URL非表示。Googleサーチで代替
    sourceUrlKind = "vertexaisearch-skipped";
    if (queries.length > 0) {
      result.sourceUrl = `https://www.google.com/search?q=${encodeURIComponent(queries[0])}`;
    }
  } else if (queries.length > 0) {
    // グラウンディングなし → google-search-fallback（プールフィルタで除外対象）
    result.sourceUrl = `https://www.google.com/search?q=${encodeURIComponent(queries[0])}`;
    sourceUrlKind = "google-search-fallback";
  } else {
    sourceUrlKind = "none";
  }

  result.kanjiChar = normalizeKanjiChar(result.kanjiChar);
  result.sourceUrlKind = sourceUrlKind;

  console.log(
    `[research] model=${model}` +
    ` theme="${result.theme}"` +
    ` descLen=${result.description?.length ?? 0}` +
    ` kanjiChar=${result.kanjiChar}` +
    ` sourceUrlKind=${sourceUrlKind}` +
    ` sourceUrl=${result.sourceUrl ? result.sourceUrl.slice(0, 80) : "(none)"}`
  );

  return result;
}

// ---------------------------------------------------------------------------
// 画像生成モデルを動的に選択（キャッシュなし・毎回確認）
// ---------------------------------------------------------------------------
// 画像生成 Gemini モデルの既知候補リスト（優先度順）
// Discovery API 呼び出しは tryGemini() のレイテンシ増加の原因になるため廃止。
// モデルが廃止された場合は KNOWN_IMAGE_CANDIDATES を直接更新する。
// 確認先: https://ai.google.dev/gemini-api/docs/models
const KNOWN_IMAGE_CANDIDATES = [
  "gemini-2.5-flash-image",              // 2026-03 現在の stable（メイン）
  "gemini-2.0-flash-exp",                // フォールバック
  "gemini-2.0-flash-preview-image-generation",  // 廃止済みの可能性あり
];

// ---------------------------------------------------------------------------
// Pollinations.ai フォールバック（base64 画像を返す）
// ---------------------------------------------------------------------------
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 猫ペルソナ（重み付き確率でランダム選択）
// ---------------------------------------------------------------------------
const CAT_PERSONAS = [
  // Common (weight 60)
  { weight: 20, desc: "orange mackerel tabby with white chest, amber eyes" },
  { weight: 15, desc: "gray and black classic tabby, swirling coat pattern" },
  { weight: 10, desc: "black and white tuxedo cat" },
  { weight: 10, desc: "silver tabby with distinct striped markings" },
  { weight:  5, desc: "cream solid-colored cat with soft fluffy coat" },
  // Uncommon (weight 25)
  { weight: 10, desc: "tortoiseshell cat with brindled black and orange fur" },
  { weight:  8, desc: "gray Scottish Fold with folded ears and round face" },
  { weight:  7, desc: "white Ragdoll with blue eyes and fluffy long coat" },
  // Rare (weight 12)
  { weight:  7, desc: "calico cat with white, black, and orange tri-color patches" },
  { weight:  5, desc: "Bengal cat with leopard-like spotted rosette pattern" },
  // Ultra Rare (weight 3)
  { weight:  2, desc: "male tortoiseshell cat, extremely rare coloring" },
  { weight:  1, desc: "smoke-patterned Persian, pale undercoat with dark silver tips" },
  // Omakase: AIに外見を自由に決めさせる (weight 10)
  { weight: 10, desc: null },
];

export function pickPersona() {
  const total = CAT_PERSONAS.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of CAT_PERSONAS) {
    r -= p.weight;
    if (r <= 0) return p.desc;
  }
  return CAT_PERSONAS[0].desc;
}

// ---------------------------------------------------------------------------
// 猫の性格（重み付き確率でランダム選択・毛柄とは独立）
// ---------------------------------------------------------------------------
// Finka(2017) リンカーン大学5タイプを参考に、本サービスのトーン（記念日・かわいい）に合わせ調整。
// 攻撃的・神経質・触られ嫌い・衝動的なタイプは除外。ツンデレはRare(3%)。
const CAT_PERSONALITIES = [
  { weight: 35, desc: "gazing lovingly at viewer, sitting close, soft gentle expression" },
  { weight: 30, desc: "crouching in playful pounce position, alert bright eyes, paw reaching for theme item" },
  { weight: 25, desc: "leaning forward with wide curious eyes, carefully investigating the theme item" },
  { weight:  7, desc: "grooming itself serenely, self-contained and peaceful" },
  { weight:  7, desc: "curled up softly, head gently drooping in a cozy drowsy nap" },
  { weight:  3, desc: "sitting with back slightly turned, dignified aloof expression, secretly glancing back" },
  // Omakase: AIにポーズ・表情を自由に決めさせる (weight 10)
  { weight: 10, desc: null },
];

export function pickPersonality() {
  const total = CAT_PERSONALITIES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of CAT_PERSONALITIES) {
    r -= p.weight;
    if (r <= 0) return p.desc;
  }
  return CAT_PERSONALITIES[0].desc;
}

// ---------------------------------------------------------------------------
// 猫の感情の瞬間（重み付き確率でランダム選択・毛柄・性格とは独立）
// ---------------------------------------------------------------------------
// Florkiewicz & Scott(2023)の友好的表情カテゴリおよびスロウブリンク研究をベースに、
// 「キャラクターの感情が伝わることで視聴者の心が動く」ことを目的とした設計。
// personality が「気質・傾向」を表すのに対し、emotion は「その瞬間の感情状態」を表す。
const CAT_EMOTIONS = [
  { weight: 25, desc: "serene composed expression, dignified and self-possessed" },
  { weight: 25, desc: "eyes narrowed with intense focus, completely absorbed in play" },
  { weight: 20, desc: "eyes wide with surprise, ears pricked forward, caught off-guard" },
  { weight: 20, desc: "open-mouth play face, pure joyful delight" },
  { weight: 20, desc: "eyes peacefully closed, warm drowsy contentment, slow-blink expression" },
  // Omakase: AIに感情表現を自由に決めさせる (weight 10)
  { weight: 10, desc: null },
];

export function pickEmotion() {
  const total = CAT_EMOTIONS.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of CAT_EMOTIONS) {
    r -= p.weight;
    if (r <= 0) return p.desc;
  }
  return CAT_EMOTIONS[0].desc;
}

// ---------------------------------------------------------------------------
// 食べ物テーマの eating action（foodItem が指定された場合のみ 30% で追加）
// ---------------------------------------------------------------------------
const EATING_ACTION_PROBABILITY = 0.30;

const CAT_EATING_ACTIONS = [
  (food) => `holding a tiny ${food} with both paws, taking a delighted bite`,
  (food) => `nibbling on ${food}, eyes half-closed in bliss`,
  (food) => `licking ${food} with tongue out, whiskers twitching happily`,
  (food) => `sniffing ${food} curiously, nose twitching with interest`,
];

/**
 * foodItem から eating action 文字列を返す。
 * - null / 空文字 / 全角文字を含む場合は null を返す（Pollinations ASCII 制約）
 * - EATING_ACTION_PROBABILITY（30%）の確率でランダムな action を選択
 * @param {string|null} foodItem
 * @returns {string|null}
 */
// ---------------------------------------------------------------------------
// 漢字一字の正規化（Tシャツ背面印刷用）
// ---------------------------------------------------------------------------

/**
 * Gemini が返した kanjiChar を検証し、有効な漢字一字ならそのまま返す。
 * null / 無効 / 漢字以外の場合は "😺" を返す（印刷可能なフォールバック）。
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function normalizeKanjiChar(raw) {
  if (!raw || typeof raw !== "string") return "😺";
  const c = raw.trim();
  if (c.length === 1 && /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(c)) return c;
  return "😺";
}

export function pickEatingAction(foodItem) {
  if (!foodItem) return null;
  // 全角文字（非ASCII）を含む場合は除外（2重チェック: research プロンプトでも英語限定を指示）
  if (/[^\x20-\x7E]/.test(foodItem)) return null;
  if (Math.random() > EATING_ACTION_PROBABILITY) return null;
  const fn = CAT_EATING_ACTIONS[Math.floor(Math.random() * CAT_EATING_ACTIONS.length)];
  return fn(foodItem);
}

// ---------------------------------------------------------------------------
// ゲストキャラクター（10%確率で登場・メイン猫の感情を共有）
// ---------------------------------------------------------------------------
const GUEST_ANIMAL_PROBABILITY = 0.10;
const GUEST_TYPE_COUNT = 8; // 将来タイプを追加する場合はこの値とswitchを更新

// No.1 犬
const DOG_VARIANTS = [
  "golden retriever",
  "red shiba inu",
  "black-and-tan shiba inu",
  "cream shiba inu",
  "brindle French Bulldog",
  "pied French Bulldog",
];
const DOG_PERSONALITY = "friendly and energetic, approaching the cat with enthusiasm";

// No.2 ウサギ（品種×毛色を独立抽選）
const RABBIT_BREEDS = ["Netherland Dwarf rabbit", "Holland Lop rabbit", "Mini Rex rabbit"];
const RABBIT_COLORS = ["chestnut", "cream", "mixed"];
const RABBIT_PERSONALITY = "sitting neatly with ears alert, nose twitching with curiosity";

// No.3 パンダ
const PANDA_VARIANT = "giant panda cub";
const PANDA_PERSONALITY = "sitting peacefully nearby, watching the cat with calm gentle eyes, relaxed and unhurried";

// No.4 ペンギン
const PENGUIN_VARIANTS = ["emperor penguin chick", "little blue penguin"];
const PENGUIN_PERSONALITY = "waddling cheerfully with flippers out, sociable and bright-eyed";

// No.5 豚
const PIG_VARIANTS = ["pink miniature pig", "black and white spotted miniature pig"];
const PIG_PERSONALITY = "trotting over with snout twitching, cheerful and friendly";

// No.6 鶏（1/3の確率でひよこ、2/3で成鳥）
const CHICKEN_CHICK_PROBABILITY = 1 / 3;
const CHICKEN_ADULT_VARIANTS = ["fluffy white Silkie chicken", "colorful bantam rooster"];
const CHICKEN_ADULT_PERSONALITY = "pecking nearby and tilting head sideways with sharp curious eyes";
const CHICKEN_CHICK_VARIANT = "tiny fluffy yellow baby chick";
const CHICKEN_CHICK_PERSONALITY = "toddling unsteadily with tiny wings flapping, wide-eyed and curious";

// No.7 伴侶猫（独立選択の性格・毛柄は主人公との関係で決定）
const COMPANION_CAT_COAT_WEIGHTS = { similar: 60, contrast: 30, random: 10 }; // 合計100
const COMPANION_CAT_APPEARANCES = {
  similar:  "a companion cat with a matching coat to the main cat, sitting together as close friends",
  contrast: "a companion cat with contrasting markings, sharing the scene as a friendly pair",
  random:   "another cat with a distinct coat, joining the scene as a companion",
};
const COMPANION_CAT_PERSONALITIES = [
  "sitting calmly, sharing the scene with gentle companionship",
  "watching curiously with bright eyes, attentive and present",
  "relaxed and at ease, a quiet friendly presence",
];

// No.8 子猫（主人公の性格に保護者修飾を追加）
const KITTEN_PERSONALITY = "leaning forward with wide curious eyes, captivated by everything";
const KITTEN_GUARDIAN_MODIFIER = "calmly watching over the kitten nearby";

/**
 * ゲスト動物を選択する。
 * GUEST_ANIMAL_PROBABILITY（10%）の確率でゲストを返し、それ以外は null を返す。
 * rand はテスト用のランダム関数差し替え口（デフォルト Math.random）。
 * @param {string|null} mainPersona - メイン猫のペルソナ文字列（No.7/8の毛柄選択に使用）
 * @param {() => number} rand
 * @returns {{ appearance: string, personality: string, guardianModifier: string|null }|null}
 */
export function pickGuestAnimal(mainPersona, rand = Math.random) {
  if (rand() >= GUEST_ANIMAL_PROBABILITY) return null;

  const typeIndex = Math.floor(rand() * GUEST_TYPE_COUNT);
  switch (typeIndex) {
    case 0: { // 犬
      const v = DOG_VARIANTS[Math.floor(rand() * DOG_VARIANTS.length)];
      return { appearance: v, personality: DOG_PERSONALITY, guardianModifier: null };
    }
    case 1: { // ウサギ（品種×毛色を独立抽選）
      const breed = RABBIT_BREEDS[Math.floor(rand() * RABBIT_BREEDS.length)];
      const color = RABBIT_COLORS[Math.floor(rand() * RABBIT_COLORS.length)];
      return { appearance: `${color} ${breed}`, personality: RABBIT_PERSONALITY, guardianModifier: null };
    }
    case 2: { // パンダ
      return { appearance: PANDA_VARIANT, personality: PANDA_PERSONALITY, guardianModifier: null };
    }
    case 3: { // ペンギン
      const v = PENGUIN_VARIANTS[Math.floor(rand() * PENGUIN_VARIANTS.length)];
      return { appearance: v, personality: PENGUIN_PERSONALITY, guardianModifier: null };
    }
    case 4: { // 豚
      const v = PIG_VARIANTS[Math.floor(rand() * PIG_VARIANTS.length)];
      return { appearance: v, personality: PIG_PERSONALITY, guardianModifier: null };
    }
    case 5: { // 鶏（ひよこ or 成鳥）
      if (rand() < CHICKEN_CHICK_PROBABILITY) {
        return { appearance: CHICKEN_CHICK_VARIANT, personality: CHICKEN_CHICK_PERSONALITY, guardianModifier: null };
      }
      const v = CHICKEN_ADULT_VARIANTS[Math.floor(rand() * CHICKEN_ADULT_VARIANTS.length)];
      return { appearance: v, personality: CHICKEN_ADULT_PERSONALITY, guardianModifier: null };
    }
    case 6: { // 伴侶猫（毛柄はメイン猫との関係で決定）
      const coatRand = rand();
      let coatType;
      if (coatRand < COMPANION_CAT_COAT_WEIGHTS.similar / 100) {
        coatType = "similar";
      } else if (coatRand < (COMPANION_CAT_COAT_WEIGHTS.similar + COMPANION_CAT_COAT_WEIGHTS.contrast) / 100) {
        coatType = "contrast";
      } else {
        coatType = "random";
      }
      const appearance  = COMPANION_CAT_APPEARANCES[coatType];
      const personality = COMPANION_CAT_PERSONALITIES[Math.floor(rand() * COMPANION_CAT_PERSONALITIES.length)];
      return { appearance, personality, guardianModifier: null };
    }
    case 7: { // 子猫（メイン猫に保護者修飾を付与）
      const appearance = mainPersona
        ? "a tiny kitten with a matching coat to the main cat"
        : "a tiny fluffy kitten";
      return { appearance, personality: KITTEN_PERSONALITY, guardianModifier: KITTEN_GUARDIAN_MODIFIER };
    }
    default:
      return null;
  }
}

function buildPollinationsPrompt(theme, description, persona, personality, visualHint = null, emotion = null, eatingAction = null, guest = null) {
  // Pollinations API のプロンプトは ASCII のみ使用
  // 日本語等の非ASCII文字はURLパス内でサーバー側エラー(500)の原因になるためフィルタリング
  const toAscii = (s) => (s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const themeAscii = toAscii(theme);
  const descAscii  = toAscii(description).slice(0, 30);
  // theme・descriptionが日本語のみで空になった場合、visualHintをsubjectとして使う
  const subject    = themeAscii || descAscii || visualHint?.split(",")[0]?.trim() || "anniversary";
  // テーマ関連要素より先に「kawaii watercolor cat」を置き、サービスの根幹（水彩画風の可愛い猫）を先頭で宣言する
  // 「kawaii watercolor cat」にcatが含まれるため persona が null のときの "cat" フォールバックは不要
  const guestPart  = guest ? `with ${guest.appearance}` : null;
  const parts = ["kawaii watercolor cat", subject, visualHint, persona, personality, emotion, eatingAction, guestPart, "pastel colors, white background"];
  return parts.filter(Boolean).join(", ");
}

function buildPollinationsUrl(theme, description, persona, personality, model = "flux", visualHint = null, emotion = null, eatingAction = null, guest = null) {
  const prompt = buildPollinationsPrompt(theme, description, persona, personality, visualHint, emotion, eatingAction, guest);
  const seed = Math.floor(Math.random() * 1_000_000);
  return (
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${model}&width=1024&height=1024&seed=${seed}&nologo=true`
  );
}

// ---------------------------------------------------------------------------
// /generate  ― Gemini と Pollinations を並列実行し、先に成功した方を返す
// ---------------------------------------------------------------------------
export async function handleGenerate(body, apiKey) {
  const { theme, description } = body;
  if (!theme) throw new Error("theme フィールドが必要です");

  const persona      = pickPersona();
  const personality  = pickPersonality();
  const emotion      = pickEmotion();
  const visualHint   = body.visualHint ?? null;
  const eatingAction = pickEatingAction(body.foodItem ?? null);
  const guest        = pickGuestAnimal(persona);
  // No.8 子猫の場合はメイン猫の性格に保護者修飾を追加
  const effectivePersonality = (personality && guest?.guardianModifier)
    ? `${personality}, ${guest.guardianModifier}`
    : personality;
  const prompt =
    `Create a cute kawaii watercolor style cat character illustration. ` +
    (persona              ? `Cat appearance: ${persona}. `                           : "") +
    (effectivePersonality ? `Cat personality and pose: ${effectivePersonality}. `    : "") +
    (emotion              ? `Cat facial expression and emotion: ${emotion}. `        : "") +
    (eatingAction         ? `Cat action: ${eatingAction}. `                          : "") +
    (guest                ? `Guest animal in the scene: ${guest.appearance}. Guest demeanor: ${guest.personality}. ` : "") +
    `Theme: ${theme}. ` +
    (description  ? `Context: ${description}. `              : "") +
    (visualHint   ? `Setting and surrounding atmosphere; the cat may naturally interact with theme-related items (approaching, touching, or holding them as fits the scene): ${visualHint}. ` : "") +
    `Style: soft pastel colors, light pink and beige tones, gentle watercolor brushstrokes, ` +
    `white background, Japanese illustration style. ` +
    `High quality charming illustration. ` +
    `IMPORTANT: Do not include any text, letters, words, titles, captions, or typography in the image.` +
    (eatingAction ? ` Only the cat has a face and expressions; all food items must be depicted as ordinary objects without faces or eyes.` : "");

  async function tryGemini() {
    const candidates = KNOWN_IMAGE_CANDIDATES;
    // 無限ループ防止: 最大 4 候補まで
    const MAX_TRIES = 4;
    let lastError;
    for (const model of candidates.slice(0, MAX_TRIES)) {
      // 1モデルあたり最大 15 秒（実測最大 ~10s + 余裕5s）
      const res = await fetchWithRetry(
        `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
          }),
          signal: AbortSignal.timeout(15_000),
        }
      );
      const resText = await res.text();
      if (!res.ok) {
        let msg;
        try { msg = JSON.parse(resText).error?.message; } catch { msg = resText.slice(0, 120); }
        msg = msg ?? `Gemini エラー (${res.status})`;
        // モデルが存在しない / API バージョン非対応 → 次の候補へ
        if (res.status === 404 || msg.includes("not found") || msg.includes("not supported")) {
          console.warn(`[generate] model=${model} unavailable(${res.status}): ${msg.slice(0, 100)}`);
          lastError = new Error(msg);
          continue;
        }
        // クォータ超過
        if (res.status === 429) {
          console.warn(`[generate] model=${model} quota exceeded: ${msg.slice(0, 100)}`);
        }
        // その他のエラー（クォータ超過・安全フィルタ等）は即座に失敗
        throw new Error(msg);
      }
      let data;
      try { data = JSON.parse(resText); } catch {
        throw new Error(`Gemini レスポンス解析エラー: ${resText.slice(0, 120)}`);
      }
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData);
      if (!imagePart) {
        const msg = parts.find((p) => p.text)?.text ?? "";
        console.warn(`[generate] model=${model} no image part. text="${msg.slice(0, 80)}"`);
        throw new Error("Gemini: 画像パートなし" + (msg ? `: ${msg.slice(0, 80)}` : ""));
      }
      console.log(`[generate] Gemini success model=${model} mimeType=${imagePart.inlineData.mimeType}`);
      return { imageData: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType || "image/png", source: "gemini" };
    }
    throw lastError ?? new Error("Gemini: 利用可能な画像モデルが見つかりませんでした");
  }

  async function tryPollinations() {
    // 遅延なし: Phase制御（下記）でGemini優先ウィンドウを管理するためここでは即座に開始する
    // 1モデルあたり最大 20 秒。4モデル並列なので全体も最大 20 秒で完結する
    const POLLINATIONS_TIMEOUT_MS = 20_000;
    const MODELS = ["flux", "turbo", "flux-realism", "flux-anime"];
    return Promise.any(
      MODELS.map(async (model) => {
        const url = buildPollinationsUrl(theme, description, persona, effectivePersonality, model, visualHint, emotion, eatingAction, guest);
        console.log(`[pollinations] trying model=${model}`);
        const imgRes = await fetch(url, { signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS) });
        if (!imgRes.ok) throw new Error(`status=${imgRes.status}`);
        const buffer = await imgRes.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const mimeType = imgRes.headers.get("Content-Type") || "image/jpeg";
        console.log(`[pollinations] success model=${model} size=${buffer.byteLength}`);
        return { imageData: base64, mimeType, source: "pollinations" };
      })
    );
  }

  const pollinationsPrompt = buildPollinationsPrompt(theme, description, persona, effectivePersonality, visualHint, emotion, eatingAction, guest);

  // 2フェーズ方式の実行（ロジックは _twoPhaseRace に切り出し済み）
  const result = await _twoPhaseRace(tryGemini, tryPollinations);
  return { ...result, persona, personality: effectivePersonality, emotion, eatingAction, guest, prompt, pollinationsPrompt };
}

// ---------------------------------------------------------------------------
// 2フェーズ画像生成レース（テスト可能なようにexport）
//
// Phase1（0〜priorityMs）: Gemini優先ウィンドウ。時間内に完了すればGeminiを採用。
// Phase2（priorityMs〜）:  ウィンドウ超過 or Gemini失敗 → 先着優先。
//                          Pollinationsが既に完了済みの場合は即返却。
//
// 引数:
//   tryGemini      - () => Promise<{imageData, mimeType, source}>
//   tryPollinations - () => Promise<{imageData, mimeType, source}>
//   priorityMs     - Gemini優先ウィンドウの長さ（ms）。デフォルト 12_000。
// ---------------------------------------------------------------------------
export async function _twoPhaseRace(tryGemini, tryPollinations, priorityMs = 12_000) {
  const geminiPromise      = tryGemini();
  const pollinationsPromise = tryPollinations();

  const phase1 = await Promise.race([
    geminiPromise.then((r) => ({ winner: "gemini", result: r })),
    new Promise((resolve) => setTimeout(() => resolve({ winner: "timeout" }), priorityMs)),
  ]).catch((err) => ({ winner: "gemini-error", error: err }));

  if (phase1.winner === "gemini") {
    console.log("[generate] final source=gemini (phase1 priority window)");
    return phase1.result;
  }
  if (phase1.winner === "gemini-error") {
    console.warn(`[generate] Gemini失敗 (phase1): ${phase1.error?.message}`);
  } else {
    console.log("[generate] phase1 timeout → phase2 先着優先");
  }

  try {
    const result = await Promise.any([geminiPromise, pollinationsPromise]);
    console.log(`[generate] final source=${result.source} (phase2)`);
    return result;
  } catch (err) {
    const reasons = err instanceof AggregateError
      ? err.errors.map((e) => e?.message ?? String(e))
      : [err?.message ?? String(err)];
    console.error("[generate] ALL SOURCES FAILED:", reasons.join(" | "));
    throw new Error(`画像生成に失敗しました（${reasons.join(" / ")}）`);
  }
}

// ---------------------------------------------------------------------------
// /image/:id  ― R2 から画像とメタデータを返す
// ---------------------------------------------------------------------------
async function handleGetImage(id, env, corsH) {
  if (!env.IMAGE_BUCKET) {
    return new Response("Not Found", { status: 404, headers: corsH });
  }
  const [meta, image] = await Promise.all([
    getMetaFromR2(env.IMAGE_BUCKET, id),
    getImageFromR2(env.IMAGE_BUCKET, id),
  ]);
  if (!meta || !image) {
    return new Response("Not Found", { status: 404, headers: corsH });
  }
  return Response.json(
    { ...meta, imageData: image.data, mimeType: image.mimeType },
    { headers: corsH }
  );
}

// ---------------------------------------------------------------------------
// /proxy-image  ― Pollinations.ai の画像をプロキシ（CORS 回避）
// ---------------------------------------------------------------------------
async function handleProxyImage(request, corsH) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  // Pollinations.ai 以外は拒否（オープンプロキシ化を防止）
  if (!targetUrl || !targetUrl.startsWith("https://image.pollinations.ai/")) {
    return new Response("Invalid URL", { status: 403, headers: corsH });
  }

  const imageRes = await fetch(targetUrl);
  return new Response(imageRes.body, {
    status: 200,
    headers: {
      ...corsH,
      "Content-Type": imageRes.headers.get("Content-Type") || "image/png",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// ---------------------------------------------------------------------------
// メインハンドラ
// ---------------------------------------------------------------------------
export default {
  // ── Cron Trigger ──────────────────────────────────────────────────────────
  // "0 15 * * *"   → 毎日 0:00 JST  リサーチプール生成
  // "0 10 * * 2-6" → 月〜金 19:00 JST  Bluesky 営業 Bot
  async scheduled(event, env, ctx) {
    if (event.cron === "0 15 * * *") {
      ctx.waitUntil(generateResearchPool(env));
      return;
    }

    // Bot Cron（月〜金）+ 期限切れエントリのクリーンアップ
    ctx.waitUntil((async () => {
      if (env.IMAGE_BUCKET) {
        try {
          const expiredIds = await listExpiredIds(env.IMAGE_BUCKET);
          for (const id of expiredIds) {
            if (env.SUZURI_API_KEY) {
              const meta = await getMetaFromR2(env.IMAGE_BUCKET, id);
              if (meta?.materialId) {
                try {
                  await deleteSuzuriMaterial(meta.materialId, env);
                  console.log(`[cleanup] SUZURI material=${meta.materialId} 削除完了`);
                } catch (e) {
                  console.warn(`[cleanup] SUZURI material=${meta.materialId} 削除失敗: ${e.message}`);
                }
              }
            }
            await deleteFromR2(env.IMAGE_BUCKET, id);
            console.log(`[cleanup] R2 id=${id} 削除完了`);
          }
          if (expiredIds.length > 0) {
            console.log(`[cleanup] ${expiredIds.length}件削除完了`);
          }
        } catch (e) {
          console.error(`[cleanup] エラー: ${e.message}`);
        }
      }
      await runBot(env, handleResearch, handleGenerate);
    })());
  },

  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") ?? "";
    const corsH = makeCorsHeaders(origin, env.ALLOWED_ORIGIN ?? "");
    const url = new URL(request.url);

    // プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsH });
    }

    // GET: 画像プロキシ
    if (request.method === "GET" && url.pathname === "/proxy-image") {
      return handleProxyImage(request, corsH);
    }

    // GET: R2画像取得（/image/bot/YYYY-MM-DD または /image/user/{uuid}）
    if (request.method === "GET" && url.pathname.startsWith("/image/")) {
      const id = url.pathname.slice("/image/".length);
      return handleGetImage(id, env, corsH);
    }

    // GET: R2メタデータのみ取得（ポーリング用軽量エンドポイント）
    if (request.method === "GET" && url.pathname.startsWith("/meta/")) {
      const id = url.pathname.slice("/meta/".length);
      if (!env.IMAGE_BUCKET) return new Response("Not Found", { status: 404, headers: corsH });
      const meta = await getMetaFromR2(env.IMAGE_BUCKET, id);
      if (!meta) return new Response("Not Found", { status: 404, headers: corsH });
      return Response.json(meta, { headers: corsH });
    }

    // GET: R2画像バイナリを直接返す（ギャラリーサムネイル用・base64不要）
    if (request.method === "GET" && url.pathname.startsWith("/thumb/")) {
      const id = url.pathname.slice("/thumb/".length);
      if (!id || !env.IMAGE_BUCKET) return new Response("Not Found", { status: 404, headers: corsH });
      // saveToR2() は web.png または web.jpg で保存するため両方試みる
      let obj = await env.IMAGE_BUCKET.get(`${id}/web.png`);
      if (!obj) obj = await env.IMAGE_BUCKET.get(`${id}/web.jpg`);
      if (!obj) return new Response("Not Found", { status: 404, headers: corsH });
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
          "Cache-Control": "public, max-age=86400",
          ...corsH,
        },
      });
    }

    // GET: RSSフィード（直近14日のボット作品）
    if (request.method === "GET" && url.pathname === "/rss.xml") {
      const PAGES_URL  = "https://hiroshikuze.github.io/anniversary-cat-worker";
      const WORKER_URL = "https://anniversary-cat-worker.hiroshikuze.workers.dev";
      const RSS_DAYS   = 14;

      // 直近14日分のメタデータを並列取得
      const now = new Date();
      const ids = [];
      for (let i = 0; i < RSS_DAYS; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        ids.push(`bot/${toJSTDateStringWorker(d)}`);
      }
      const metas = env.IMAGE_BUCKET
        ? await Promise.all(ids.map(id =>
            getMetaFromR2(env.IMAGE_BUCKET, id)
              .then(meta => meta ? { id, meta } : null)
              .catch(() => null)
          ))
        : [];
      const items = metas.filter(Boolean);

      const itemsXml = items.map(({ id, meta }) => {
        const dateStr   = id.replace("bot/", "");
        const [, m, d]  = dateStr.split("-");
        const title     = `${parseInt(m)}月${parseInt(d)}日 - ${meta.theme ?? ""}`;
        const link      = `${PAGES_URL}/?id=${id}`;
        const thumbUrl  = `${WORKER_URL}/thumb/${id}`;
        const pubDate   = meta.createdAt ? new Date(meta.createdAt).toUTCString() : "";
        const descHtml  = [
          `<img src="${thumbUrl}" alt="${escapeXml(meta.theme ?? "")}"/>`,
          meta.description ? `<p>${escapeXml(meta.description)}</p>` : "",
        ].filter(Boolean).join("");
        return [
          "    <item>",
          `      <title>${escapeXml(title)}</title>`,
          `      <link>${link}</link>`,
          `      <description><![CDATA[${descHtml}]]></description>`,
          pubDate ? `      <pubDate>${pubDate}</pubDate>` : "",
          `      <guid isPermaLink="true">${link}</guid>`,
          `      <enclosure url="${thumbUrl}" type="image/png" length="0"/>`,
          "    </item>",
        ].filter(Boolean).join("\n");
      }).join("\n");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>にゃんバーサリー</title>
    <link>${PAGES_URL}/</link>
    <description>今日の記念日をAIが調べて、水彩画風の猫イラストを生成します</description>
    <language>ja</language>
    <image>
      <url>${PAGES_URL}/images/og-image.png</url>
      <title>にゃんバーサリー</title>
      <link>${PAGES_URL}/</link>
    </image>
${itemsXml}
  </channel>
</rss>`;

      return new Response(xml, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          ...corsH,
        },
      });
    }

    // GET: fal.ai高解像度画像をR2から返す（SUZURI向け安定URL）
    if (request.method === "GET" && url.pathname.startsWith("/hires/")) {
      const id = url.pathname.slice("/hires/".length);
      if (!env.IMAGE_BUCKET) return new Response("Not Found", { status: 404, headers: corsH });
      const obj = await env.IMAGE_BUCKET.get(`${id}/hires.png`);
      if (!obj) return new Response("Not Found", { status: 404, headers: corsH });
      const buf = await obj.arrayBuffer();
      return new Response(buf, {
        headers: { "Content-Type": "image/png", "Content-Length": String(buf.byteLength), ...corsH },
      });
    }

    // GET /resume-hires/:id - fal.ai queue結果確認 → 必要なら SUZURI 登録を完了させる（安全網）
    if (request.method === "GET" && url.pathname.startsWith("/resume-hires/")) {
      const id = url.pathname.slice("/resume-hires/".length);
      if (!id || !env.IMAGE_BUCKET) return new Response("Not Found", { status: 404, headers: corsH });
      const meta = await getMetaFromR2(env.IMAGE_BUCKET, id);
      if (!meta) return new Response("Not Found", { status: 404, headers: corsH });

      // t-shirt がすでに登録済み → 重複防止
      if ((meta.products ?? []).some(p => p.slug === "t-shirt")) {
        return Response.json({ products: meta.products }, { headers: corsH });
      }

      if (!env.SUZURI_API_KEY) {
        return Response.json({ error: "SUZURI_API_KEY 未設定" }, { status: 503, headers: corsH });
      }

      const RIGHT_SLUGS = ["t-shirt", "sticker"];
      const workerOrigin = new URL(request.url).origin;
      let suzuriTexture = null;

      // fal.ai queue から結果を取得
      if (meta.falRequestId && env.FAL_KEY) {
        try {
          const result = await getFalResult(meta.falRequestId, env);
          if (result.status === "IN_QUEUE" || result.status === "IN_PROGRESS") {
            console.log(`[resume-hires] fal まだ処理中 status=${result.status}`);
            return Response.json({ stillProcessing: true }, { headers: corsH });
          }
          if (result.status === "COMPLETED" && result.cdnUrl) {
            const cdnRes = await fetch(result.cdnUrl, { signal: AbortSignal.timeout(10_000) });
            if (cdnRes.ok) {
              const buf = await cdnRes.arrayBuffer();
              if (buf.byteLength > 0 && buf.byteLength <= 20_000_000) {
                await env.IMAGE_BUCKET.put(`${id}/hires.png`, buf, {
                  httpMetadata: { contentType: "image/png" },
                });
                suzuriTexture = `${workerOrigin}/hires/${id}`;
                console.log(`[resume-hires] hires R2保存完了 → ${suzuriTexture}`);
              } else if (buf.byteLength > 20_000_000) {
                console.warn(`[resume-hires] hires 20MB超のためbase64フォールバック byteLength=${buf.byteLength}`);
                await notifyDiscord(env.DISCORD_WEBHOOK_URL,
                  `fal.ai 出力画像が20MB超（SUZURI上限超過）\nbyteLength=${buf.byteLength}\nモデルの出力サイズを確認してください`);
              }
            }
          }
        } catch (e) {
          console.warn(`[resume-hires] fal result取得失敗: ${e.message}`);
        }
      }

      // フォールバック: オリジナル画像を R2 から取得して base64 で登録
      if (!suzuriTexture) {
        const img = await getImageFromR2(env.IMAGE_BUCKET, id);
        if (!img) return Response.json({ error: "画像データが見つかりません" }, { status: 404, headers: corsH });
        suzuriTexture = `data:${img.mimeType};base64,${img.data}`;
        console.log(`[resume-hires] base64フォールバック`);
      }

      try {
        const sr = await createSuzuriProducts(suzuriTexture, meta.theme ?? "", env, RIGHT_SLUGS, null, meta.description ?? "", id);
        await updateMetaInR2(env.IMAGE_BUCKET, id, { products: sr.products });
        console.log(`[resume-hires] SUZURI登録完了`);
        return Response.json({ products: sr.products }, { headers: corsH });
      } catch (e) {
        console.error(`[resume-hires] SUZURI登録失敗: ${e.message}`);
        return Response.json({ error: e.message }, { status: 500, headers: corsH });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsH });
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "GEMINI_API_KEY が設定されていません" },
        { status: 500, headers: corsH }
      );
    }

    try {
      const body = await request.json();
      let result;

      if (url.pathname === "/research") {
        if (!isBypassed(request, env)) {
          const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
          const rl = await checkRateLimit(env.RATE_KV, clientIp, "research");
          if (rl.limited) {
            return Response.json({ error: rl.message }, { status: 429, headers: corsH });
          }
        }
        // プールから取得を試みる（R2が利用可能かつ当日プールが存在する場合）
        if (env.IMAGE_BUCKET) {
          const todayJst = toJSTDateStringWorker(new Date());
          const poolObj  = await env.IMAGE_BUCKET.get(`research-pool/${todayJst}.json`);
          if (poolObj) {
            const pool = await poolObj.json();
            result = pickFromPool(pool);
            if (result) {
              console.log(`[research] pool hit date=${todayJst} theme="${result.theme}" fallback=${!!result.isSeasonalFallback}`);
            }
          }
        }
        // プールがない場合はリアルタイムGeminiにフォールバック
        if (!result) {
          result = await handleResearch(body, apiKey);
        }
      } else if (url.pathname === "/generate") {
        if (!isBypassed(request, env)) {
          const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
          const rl = await checkRateLimit(env.RATE_KV, clientIp, "generate");
          if (rl.limited) {
            return Response.json({ error: rl.message }, { status: 429, headers: corsH });
          }
        }
        result = await handleGenerate(body, apiKey);

        // R2保存（best-effort: 失敗しても imageData は返す）
        // SUZURI商品生成はフロントでウォーターマーク合成後に /suzuri-create で行う
        if (env.IMAGE_BUCKET) {
          try {
            const r2Id = `user/${crypto.randomUUID()}`;
            const meta = {
              theme:       body.theme,
              description: body.description ?? "",
              sourceUrl:   "",
              materialId:  null,
              products:    [],
              createdAt:   new Date().toISOString(),
            };
            await saveToR2(
              env.IMAGE_BUCKET,
              r2Id,
              { data: result.imageData, mimeType: result.mimeType },
              meta
            );
            result = { ...result, id: r2Id };
          } catch (e) {
            console.warn(`[generate] R2保存失敗: ${e.message}`);
          }
        }
      } else if (url.pathname === "/suzuri-create") {
        // フロントでウォーターマーク合成済み画像を受け取りSUZURI登録する
        if (!env.SUZURI_API_KEY) {
          return Response.json({ error: "SUZURI_API_KEY が設定されていません" }, { status: 503, headers: corsH });
        }
        const { imageData, mimeType, theme, r2Id, slugs, hiresImageData, description, backTexture } = body;
        if (!imageData || !mimeType || !theme) {
          return Response.json({ error: "imageData, mimeType, theme が必要です" }, { status: 400, headers: corsH });
        }

        // 重複防止: 対象スラッグが既に全件登録済みなら既存データを返して終了
        // （ボット画像の初回訪問者トリガー登録で、複数ユーザーが同時訪問した場合の二重登録防止）
        if (r2Id && env.IMAGE_BUCKET && (slugs ?? []).length > 0) {
          try {
            const existingMeta = await getMetaFromR2(env.IMAGE_BUCKET, r2Id);
            const existingSlugs = new Set((existingMeta?.products ?? []).map(p => p.slug));
            if ((slugs ?? []).every(s => existingSlugs.has(s))) {
              console.log(`[suzuri-create] 重複スキップ slugs=${slugs.join(",")} r2Id=${r2Id}`);
              return Response.json(
                { products: (existingMeta.products ?? []).filter(p => slugs.includes(p.slug)) },
                { headers: corsH }
              );
            }
          } catch (_) { /* R2読み取り失敗は無視して続行 */ }
        }

        // t-shirt / sticker は fal.ai アップスケールを試みるため ctx.waitUntil() でバックグラウンド処理
        // can-badge / acrylic-keychain は即時処理して先にレスポンスを返す
        const RIGHT_SLUGS = ["t-shirt", "sticker"];
        const isRightGroup = (slugs ?? []).some(s => RIGHT_SLUGS.includes(s));

        if (isRightGroup) {
          const workerOrigin = new URL(request.url).origin;

          // fal.ai Queue にジョブ投入（ctx.waitUntil 前に実行 → request_id を確実に R2 保存）
          let falRequestId = null;
          try {
            const { requestId } = await submitFalJob(imageData, mimeType, env);
            falRequestId = requestId;
          } catch (e) {
            console.warn(`[suzuri-create] fal queue投入失敗（base64で継続）: ${e.message}`);
          }
          if (falRequestId && r2Id && env.IMAGE_BUCKET) {
            try {
              await updateMetaInR2(env.IMAGE_BUCKET, r2Id, { falRequestId });
            } catch (e) {
              console.warn(`[suzuri-create] falRequestId R2保存失敗: ${e.message}`);
            }
          }

          // バックグラウンド: queue をポーリング（最大3回・5秒間隔）
          // → 15秒以内に完了すれば高解像度 SUZURI、それ以外は base64 フォールバック
          ctx.waitUntil((async () => {
            console.log(`[suzuri-create] bg開始 falRequestId=${falRequestId ?? "none"}`);
            let suzuriTexture = null;

            if (falRequestId) {
              for (let i = 0; i < 3; i++) {
                await new Promise(r => setTimeout(r, 5_000));
                try {
                  const result = await getFalResult(falRequestId, env);
                  if (result.status === "COMPLETED" && result.cdnUrl) {
                    const cdnRes = await fetch(result.cdnUrl, { signal: AbortSignal.timeout(10_000) });
                    console.log(`[suzuri-create] CDN fetch status=${cdnRes.status}`);
                    if (cdnRes.ok) {
                      const buf = await cdnRes.arrayBuffer();
                      console.log(`[suzuri-create] CDN byteLength=${buf.byteLength}`);
                      if (buf.byteLength > 0 && buf.byteLength <= 20_000_000 && r2Id && env.IMAGE_BUCKET) {
                        await env.IMAGE_BUCKET.put(`${r2Id}/hires.png`, buf, {
                          httpMetadata: { contentType: "image/png" },
                        });
                        suzuriTexture = `${workerOrigin}/hires/${r2Id}`;
                        console.log(`[suzuri-create] hires R2保存完了 → ${suzuriTexture}`);
                      } else if (buf.byteLength > 20_000_000) {
                        console.warn(`[suzuri-create] hires 20MB超のためbase64フォールバック byteLength=${buf.byteLength}`);
                        await notifyDiscord(env.DISCORD_WEBHOOK_URL,
                          `fal.ai 出力画像が20MB超（SUZURI上限超過）\nbyteLength=${buf.byteLength}\nモデルの出力サイズを確認してください`);
                      }
                    }
                    break;
                  }
                  if (result.status === "FAILED" || result.status === "error") break;
                  // IN_QUEUE or IN_PROGRESS: 次のポーリングへ
                } catch (e) {
                  console.warn(`[suzuri-create] poll ${i + 1} 失敗: ${e.message}`);
                  break;
                }
              }
            }

            if (!suzuriTexture) {
              // ポーリング3回未完了またはFAILED → フォールバック画像で継続するが運営に通知
              if (falRequestId) {
                await notifyDiscord(env.DISCORD_WEBHOOK_URL,
                  `fal.ai アップスケール未完了（base64フォールバック）\nrequestId=${falRequestId}\n3回×5秒ポーリングで完了せず。Cloudflareログを確認してください`);
              }
              // hiresImageData があればブラウザ側 2048px bicubic リサイズ版を優先（元画像より印刷品質が高い）
              const fallbackData = hiresImageData ?? imageData;
              suzuriTexture = `data:${mimeType};base64,${fallbackData}`;
              console.log(`[suzuri-create] base64フォールバック source=${hiresImageData ? "hires(2048px bicubic)" : "original"}`);
            }
            console.log(`[suzuri-create] texture type=${suzuriTexture.startsWith("data:") ? "base64" : "url"}`);
            try {
              const sr = await createSuzuriProducts(suzuriTexture, theme, env, slugs ?? null, backTexture ?? null, description ?? "", r2Id ?? null);
              if (r2Id && env.IMAGE_BUCKET) {
                await updateMetaInR2(env.IMAGE_BUCKET, r2Id, { products: sr.products });
              }
              console.log(`[suzuri-create] right グループ完了 slugs=${slugs?.join(",")}`);
            } catch (e) {
              console.error(`[suzuri-create] right グループ失敗: ${e.message}`);
            }
          })());
          result = { queued: true, slugs };
        } else {
          // center グループ: 即時処理
          const suzuriTexture = `data:${mimeType};base64,${imageData}`;
          const suzuriResult = await createSuzuriProducts(suzuriTexture, theme, env, slugs ?? null, null, description ?? "", r2Id ?? null);
          if (r2Id && env.IMAGE_BUCKET) {
            try {
              await updateMetaInR2(env.IMAGE_BUCKET, r2Id, {
                materialId: suzuriResult.materialId,
                products:   suzuriResult.products,
              });
            } catch (e) {
              console.warn(`[suzuri-create] R2メタ更新失敗: ${e.message}`);
            }
          }
          result = { products: suzuriResult.products, materialId: suzuriResult.materialId };
        }
      } else {
        return new Response("Not Found", { status: 404, headers: corsH });
      }

      return Response.json(result, { headers: corsH });
    } catch (err) {
      return Response.json(
        { error: err.message },
        { status: 500, headers: corsH }
      );
    }
  },
};
