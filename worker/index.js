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

import { runBot } from "./bluesky-bot.js";
import { saveToR2, getMetaFromR2, getImageFromR2, listExpiredIds, deleteFromR2, updateMetaInR2 } from "./r2-storage.js";
import { createSuzuriProducts, deleteSuzuriMaterial } from "./suzuri.js";

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
    `今日は${date}です。この日の日本の記念日・記念日・季節の花・重要なイベントを` +
    `Google検索で調べ、最も特徴的なものを1つ選んでください。` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` +
    `{"theme":"記念日名","description":"50文字以内の説明","sourceUrl":"参照した実際のURL"}`;

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

  console.log(
    `[research] model=${model}` +
    ` theme="${result.theme}"` +
    ` descLen=${result.description?.length ?? 0}` +
    ` sourceUrlKind=${sourceUrlKind}` +
    ` sourceUrl=${result.sourceUrl ? result.sourceUrl.slice(0, 80) : "(none)"}`
  );

  return result;
}

// ---------------------------------------------------------------------------
// 画像生成モデルを動的に選択（キャッシュなし・毎回確認）
// ---------------------------------------------------------------------------
// 画像生成に使える Gemini モデルの候補リストを返す（優先度順）
// 動的に発見したモデルを先頭に置き、既知の候補をフォールバックとして追加する
async function listImageModelCandidates(apiKey) {
  // コスパ重視の既知候補（新しい/安価なものを先に）
  // 2026-03 時点の有効モデル: gemini-2.5-flash-image が現行 stable
  const KNOWN_CANDIDATES = [
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-exp",
    "gemini-2.0-flash-preview-image-generation",
  ];

  let discovered = [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
    );
    const data = await res.json();
    const models = data.models ?? [];

    // generateContent をサポートし、画像生成関連の名前を持つモデルを収集
    discovered = models
      .filter((m) => {
        const methods = m.supportedGenerationMethods ?? [];
        const name = m.name;
        return (
          methods.includes("generateContent") &&
          (name.includes("image-generation") || name.includes("imagen") || name.includes("flash-exp"))
        );
      })
      .map((m) => m.name.replace("models/", ""));

    if (discovered.length > 0) {
      console.log("[image-model] discovered:", discovered.join(", "));
    } else {
      console.warn("[image-model] discovery found no image models");
    }
  } catch (e) {
    console.warn("[image-model] discovery failed:", e.message);
  }

  // 発見済みを先頭に、既知候補を後ろに（重複排除）
  return [...new Set([...discovered, ...KNOWN_CANDIDATES])];
}

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

function buildPollinationsUrl(theme, description, persona, model = "flux") {
  // Pollinations API のプロンプトは ASCII のみ使用
  // 日本語等の非ASCII文字はURLパス内でサーバー側エラー(500)の原因になるためフィルタリング
  const toAscii = (s) => (s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const themeAscii = toAscii(theme);
  const descAscii  = toAscii(description).slice(0, 30);
  const subject    = themeAscii || descAscii || "anniversary";
  const prompt =
    `kawaii watercolor ${persona}, ${subject}, pastel colors, white background, kawaii style`;
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

  const persona = pickPersona();
  const prompt =
    `Create a cute kawaii watercolor style cat character illustration. ` +
    `Cat appearance: ${persona}. ` +
    `Theme: ${theme}. ` +
    (description ? `Background: ${description}. ` : "") +
    `Style: soft pastel colors, light pink and beige tones, gentle watercolor brushstrokes, ` +
    `white background, Japanese kawaii style. ` +
    `The cat is holding or surrounded by items related to the theme. ` +
    `High quality charming illustration. ` +
    `IMPORTANT: Do not include any text, letters, words, titles, captions, or typography in the image.`;

  async function tryGemini() {
    const candidates = await listImageModelCandidates(apiKey);
    // 無限ループ防止: 最大 4 候補まで
    const MAX_TRIES = 4;
    let lastError;
    for (const model of candidates.slice(0, MAX_TRIES)) {
      // 1モデルあたり最大 25 秒
      const res = await fetchWithRetry(
        `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
          }),
          signal: AbortSignal.timeout(25_000),
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
    // 1モデルあたり最大 20 秒。4モデル並列なので全体も最大 20 秒で完結する
    const POLLINATIONS_TIMEOUT_MS = 20_000;
    const MODELS = ["flux", "turbo", "flux-realism", "flux-anime"];
    return Promise.any(
      MODELS.map(async (model) => {
        const url = buildPollinationsUrl(theme, description, persona, model);
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

  try {
    const result = await Promise.any([tryGemini(), tryPollinations()]);
    console.log(`[generate] final source=${result.source}`);
    return result;
  } catch (err) {
    // AggregateError から各失敗理由を取り出してログ・レスポンスに含める
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

  async fetch(request, env) {
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
        const { imageData, mimeType, theme, r2Id, slugs } = body;
        if (!imageData || !mimeType || !theme) {
          return Response.json({ error: "imageData, mimeType, theme が必要です" }, { status: 400, headers: corsH });
        }
        const dataUri = `data:${mimeType};base64,${imageData}`;
        const suzuriResult = await createSuzuriProducts(dataUri, theme, env, slugs ?? null);
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
