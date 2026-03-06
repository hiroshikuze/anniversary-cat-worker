/**
 * Cloudflare Worker - Anniversary Cat API Proxy
 *
 * 環境変数（secrets）:
 *   GEMINI_API_KEY  ... wrangler secret put GEMINI_API_KEY で設定
 *
 * 環境変数（vars / wrangler.toml）:
 *   ALLOWED_ORIGIN  ... GitHub Pages の URL（例: https://hiroshikuze.github.io）
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
      .filter(m => !m.name.includes("embedding") && !m.name.includes("aqa"));

    const scored = candidates.map(m => {
      let score = 0;
      if (m.name.includes("flash"))    score += 20;
      if (!m.name.includes("preview")) score += 10;
      const ver = m.name.match(/gemini-(\d+)\.(\d+)/);
      if (ver) score += parseInt(ver[1]) * 3 + parseInt(ver[2]);
      return { shortName: m.name.replace("models/", ""), score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0]?.shortName ?? "gemini-2.0-flash";

    console.log("[model-select] selected:", selected,
      "| candidates:", scored.slice(0, 3).map(s => `${s.shortName}(${s.score})`).join(", "));

    _modelCache = { name: selected, expiry: now + 60 * 60 * 1000 };
    return selected;
  } catch (e) {
    console.warn("[model-select] fallback due to:", e.message);
    return _modelCache.name ?? "gemini-2.0-flash";
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ---------------------------------------------------------------------------
// 指数バックオフ付きフェッチ（Worker 内 → Google API）
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);
    if ((res.status === 429 || res.status >= 500) && i < maxRetries - 1) {
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

  if (!result.sourceUrl) {
    const uri = groundingChunks[0]?.web?.uri ?? "";
    if (uri && !uri.includes("<vertexaisearch.cloud.google.com>")) {
      result.sourceUrl = uri;
    }
  }
  if (!result.sourceUrl && queries.length > 0) {
    result.sourceUrl =
      `https://www.google.com/search?q=${encodeURIComponent(queries[0])}`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 画像生成モデルを動的に選択（キャッシュなし・毎回確認）
// ---------------------------------------------------------------------------
async function selectImageModel(apiKey) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
    );
    const data = await res.json();
    const models = data.models ?? [];

    // "image-generation" または "imagen" を含み generateContent をサポートするモデル
    const found = models
      .filter((m) => {
        const methods = m.supportedGenerationMethods ?? [];
        return (
          methods.includes("generateContent") &&
          (m.name.includes("image-generation") || m.name.includes("imagen"))
        );
      })
      .map((m) => m.name.replace("models/", ""))[0];

    if (found) {
      console.log("[image-model] selected:", found);
      return found;
    }

    console.warn("[image-model] no image model found, available models:",
      models.map((m) => m.name.replace("models/", "")).join(", "));
  } catch (e) {
    console.warn("[image-model] discovery failed:", e.message);
  }

  // フォールバック（実験的モデル名）
  return "gemini-2.0-flash-exp-image-generation";
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

function buildPollinationsUrl(theme, description) {
  const prompt =
    `kawaii watercolor cat illustration, ${theme} theme, ` +
    (description ? `${description}, ` : "") +
    `soft pastel colors, pink beige, white background, Japanese kawaii style`;
  const seed = Math.floor(Math.random() * 1_000_000);
  return (
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=flux&width=1024&height=1024&seed=${seed}&nologo=true`
  );
}

// ---------------------------------------------------------------------------
// /generate  ― Gemini で猫イラストを生成、失敗時は Pollinations.ai にフォールバック
// ---------------------------------------------------------------------------
async function handleGenerate(body, apiKey) {
  const { theme, description } = body;
  if (!theme) throw new Error("theme フィールドが必要です");

  const imageModel = await selectImageModel(apiKey);

  const prompt =
    `Create a cute kawaii watercolor style cat character illustration. ` +
    `Theme: ${theme}. ` +
    (description ? `Background: ${description}. ` : "") +
    `Style: soft pastel colors, light pink and beige tones, gentle watercolor brushstrokes, ` +
    `white background, Japanese kawaii style. ` +
    `The cat is holding or surrounded by items related to the theme. ` +
    `High quality charming illustration.`;

  let geminiError = null;
  try {
    const res = await fetchWithRetry(
      `${GEMINI_BASE}/${imageModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
      }
    );

    const data = await res.json();
    if (res.ok) {
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData);
      if (imagePart) {
        return {
          imageData: imagePart.inlineData.data,
          mimeType: imagePart.inlineData.mimeType || "image/png",
          source: "gemini",
        };
      }
      const msg = parts.find((p) => p.text)?.text ?? "";
      geminiError = "Gemini: 画像パートなし" + (msg ? `: ${msg.slice(0, 80)}` : "");
    } else {
      geminiError = data.error?.message || `Gemini エラー (${res.status})`;
    }
  } catch (e) {
    geminiError = e.message;
  }

  console.warn("[generate] Gemini failed, falling back to Pollinations:", geminiError);
  const pollinationsUrl = buildPollinationsUrl(theme, description);
  console.log("[pollinations] returning URL to frontend:", pollinationsUrl.slice(0, 100));
  return { pollinationsUrl, source: "pollinations" };
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
        result = await handleResearch(body, apiKey);
      } else if (url.pathname === "/generate") {
        result = await handleGenerate(body, apiKey);
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
