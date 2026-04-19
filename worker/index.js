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
async function handleResearch(body, apiKey) {
  const { date } = body;
  if (!date) throw new Error("date フィールドが必要です");

  const model = await selectBestModel(apiKey);

  const prompt =
    `今日は${date}です。この日の日本の記念日・季節の花・重要なイベントを` +
    `Google検索で調べ、最も特徴的なものを1つ選んでください。` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` +
    `{"theme":"記念日名","description":"50文字以内の説明","visualHint":"このテーマをかわいい猫のイラストで表現するとき背景・小物・雰囲気として使える英語キーワードを5〜8語","foodItem":"その記念日の主な行為・目的が食べることである場合のみ食材・料理名をASCII英語で1〜3語。農業・収穫・行事の象徴として食材が登場するだけの場合はnull。そうでなければnull","kanjiChar":"このテーマを象徴する漢字一字（常用漢字・旧字体不可）。具体的な漢字が思い浮かばない場合はnull","sourceUrl":"参照した実際のURL"}`;

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

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini API エラー (${res.status})`);
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

  let sourceUrlKind = "none";
  if (!result.sourceUrl) {
    const uri = groundingChunks[0]?.web?.uri ?? "";
    if (uri && !uri.includes("vertexaisearch.cloud.google.com")) {
      result.sourceUrl = uri;
      sourceUrlKind = "grounding";
    } else if (uri) {
      sourceUrlKind = "vertexaisearch-skipped";
    }
  } else {
    sourceUrlKind = "json";
  }
  if (!result.sourceUrl && queries.length > 0) {
    result.sourceUrl =
      `https://www.google.com/search?q=${encodeURIComponent(queries[0])}`;
    sourceUrlKind = "google-search-fallback";
  }

  result.kanjiChar = normalizeKanjiChar(result.kanjiChar);

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

function buildPollinationsPrompt(theme, description, persona, personality, visualHint = null, emotion = null, eatingAction = null) {
  // Pollinations API のプロンプトは ASCII のみ使用
  // 日本語等の非ASCII文字はURLパス内でサーバー側エラー(500)の原因になるためフィルタリング
  const toAscii = (s) => (s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const themeAscii = toAscii(theme);
  const descAscii  = toAscii(description).slice(0, 30);
  // theme・descriptionが日本語のみで空になった場合、visualHintをsubjectとして使う
  const subject    = themeAscii || descAscii || visualHint?.split(",")[0]?.trim() || "anniversary";
  // テーマ関連要素より先に「kawaii watercolor cat」を置き、サービスの根幹（水彩画風の可愛い猫）を先頭で宣言する
  // 「kawaii watercolor cat」にcatが含まれるため persona が null のときの "cat" フォールバックは不要
  const parts = ["kawaii watercolor cat", subject, visualHint, persona, personality, emotion, eatingAction, "pastel colors, white background"];
  return parts.filter(Boolean).join(", ");
}

function buildPollinationsUrl(theme, description, persona, personality, model = "flux", visualHint = null, emotion = null, eatingAction = null) {
  const prompt = buildPollinationsPrompt(theme, description, persona, personality, visualHint, emotion, eatingAction);
  const seed = Math.floor(Math.random() * 1_000_000);
  return (
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${model}&width=1024&height=1024&seed=${seed}&nologo=true`
  );
}

// ---------------------------------------------------------------------------
// /generate  ― Gemini と Pollinations を並列実行し、先に成功した方を返す
// ---------------------------------------------------------------------------
async function handleGenerate(body, apiKey) {
  const { theme, description } = body;
  if (!theme) throw new Error("theme フィールドが必要です");

  const persona      = pickPersona();
  const personality  = pickPersonality();
  const emotion      = pickEmotion();
  const visualHint   = body.visualHint ?? null;
  const eatingAction = pickEatingAction(body.foodItem ?? null);
  const prompt =
    `Create a cute kawaii watercolor style cat character illustration. ` +
    (persona      ? `Cat appearance: ${persona}. `                    : "") +
    (personality  ? `Cat personality and pose: ${personality}. `      : "") +
    (emotion      ? `Cat facial expression and emotion: ${emotion}. ` : "") +
    (eatingAction ? `Cat action: ${eatingAction}. `                   : "") +
    `Theme: ${theme}. ` +
    (description  ? `Context: ${description}. `              : "") +
    (visualHint   ? `Visual elements to incorporate: ${visualHint}. ` : "") +
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
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.message ?? `Gemini エラー (${res.status})`;
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
        const url = buildPollinationsUrl(theme, description, persona, personality, model, visualHint, emotion, eatingAction);
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

  const pollinationsPrompt = buildPollinationsPrompt(theme, description, persona, personality, visualHint, emotion, eatingAction);

  // 2フェーズ方式の実行（ロジックは _twoPhaseRace に切り出し済み）
  const result = await _twoPhaseRace(tryGemini, tryPollinations);
  return { ...result, persona, personality, emotion, eatingAction, prompt, pollinationsPrompt };
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
  // ── Cron Trigger: Bluesky 営業 Bot（月〜金 10:00 UTC = 19:00 JST）──────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // 期限切れ R2/SUZURI エントリのクリーンアップ
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
        result = await handleResearch(body, apiKey);
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
