#!/usr/bin/env node
/**
 * health-check.js - Anniversary Cat Worker ヘルスチェック
 *
 * 使い方:
 *   # Gemini API を直接チェック（デプロイ前確認、CI に最適）
 *   GEMINI_API_KEY=xxx node scripts/health-check.js
 *
 *   # デプロイ済み Worker をエンドツーエンドでチェック
 *   WORKER_URL=https://anniversary-cat-worker.xxx.workers.dev \
 *   BYPASS_TOKEN=xxx \
 *   node scripts/health-check.js
 *
 *   # 両方同時に実行
 *   GEMINI_API_KEY=xxx WORKER_URL=https://... BYPASS_TOKEN=xxx node scripts/health-check.js
 *
 * Claude Code からの自律実行:
 *   問題発生時にこのスクリプトを実行すると全チェック結果がまとめて出力されます。
 *   終了コード 0 = 正常、1 = 1件以上失敗
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// worker/index.js と同期しておく候補リスト
const KNOWN_IMAGE_CANDIDATES = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-preview-image-generation",
];

// ─── 出力ユーティリティ ──────────────────────────────────────────────────────
let failures = 0;

function pass(msg)  { console.log(`  ✓ ${msg}`); }
function fail(msg)  { console.error(`  ✗ ${msg}`); failures++; }
function warn(msg)  { console.warn(`  ⚠ ${msg}`); }
function note(msg)  { console.log(`  ℹ ${msg}`); }

function check(label, passed, detail = "") {
  const suffix = detail ? `: ${detail}` : "";
  passed ? pass(`${label}${suffix}`) : fail(`${label}${suffix}`);
  return passed;
}

async function safeFetch(url, options = {}, timeoutMs = 20_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
    return { ok: true, res, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── チェック 1: Gemini API 到達 & モデル一覧 ────────────────────────────────
async function checkGeminiReachable(apiKey) {
  console.log("\n[1] Gemini API 到達確認");
  const { ok: reached, res, error } = await safeFetch(
    `${GEMINI_BASE}?key=${apiKey}&pageSize=200`
  );
  if (!check("Gemini API へ到達できる", reached, error)) return null;

  const data = await res.json();
  if (!check("HTTP 200", res.status === 200, `status=${res.status}`)) {
    fail(`エラー内容: ${data.error?.message ?? JSON.stringify(data).slice(0, 100)}`);
    return null;
  }
  check("models フィールドあり", Array.isArray(data.models), `${data.models?.length} 件`);
  return data.models ?? [];
}

// ─── チェック 2: 画像生成モデル確認 ─────────────────────────────────────────
async function checkImageModels(apiKey, allModels) {
  console.log("\n[2] 画像生成モデル確認");

  const apiNames = allModels.map(m => m.name.replace("models/", ""));

  // 既知候補が API 上に存在するか
  for (const candidate of KNOWN_IMAGE_CANDIDATES) {
    if (apiNames.includes(candidate)) {
      pass(`${candidate} → API に存在する`);
    } else {
      warn(`${candidate} → API のモデル一覧に見当たらない（廃止済み・名前変更の可能性）`);
    }
  }

  // 実際に最優先モデルで画像生成できるか
  const testModel = KNOWN_IMAGE_CANDIDATES[0];
  console.log(`\n  [2b] ${testModel} で実際に画像生成テスト（最大35秒かかります）`);

  const { ok: reached, res, error } = await safeFetch(
    `${GEMINI_BASE}/${testModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "A tiny cute cat. Simple illustration." }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
    },
    35_000  // Geminiの画像生成は最大20秒超かかる場合がある（GitHub Actionsネットワーク考慮）
  );
  if (!check(`${testModel} へ到達できる`, reached, error)) return;

  const data = await res.json();
  if (!res.ok) {
    check(`${testModel} API 成功`, false, data.error?.message?.slice(0, 120));
    // 次の候補も試す
    note("KNOWN_CANDIDATES の 2 番目以降は Worker 実行時に自動フォールバックされます");
    return;
  }

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const hasImage = parts.some(p => p.inlineData);
  check(
    `${testModel} 画像パートあり`, hasImage,
    hasImage ? `mimeType=${parts.find(p => p.inlineData)?.inlineData?.mimeType}` :
      (parts.find(p => p.text)?.text?.slice(0, 80) ?? `parts=${JSON.stringify(parts).slice(0, 80)}`)
  );
}

// ─── チェック 3: Research（記念日テキスト取得）────────────────────────────
async function checkResearch(apiKey, allModels) {
  console.log("\n[3] Research（記念日テキスト取得）確認");

  // Worker と同じモデル選択ロジックを再現
  const candidates = allModels
    .filter(m => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .filter(m => m.name.includes("gemini"))
    .filter(m => !m.name.includes("embedding") && !m.name.includes("aqa"))
    .filter(m => !/models\/.*-exp$/.test(m.name))
    .map(m => {
      const name = m.name.replace("models/", "");
      let score = 0;
      if (name.includes("flash"))    score += 20;
      if (!name.includes("preview")) score += 10;
      const ver = name.match(/gemini-(\d+)\.(\d+)/);
      if (ver) score += parseInt(ver[1]) * 3 + parseInt(ver[2]);
      return { name, score };
    })
    .sort((a, b) => b.score - a.score);

  check("Research 用モデルが 1 件以上ある", candidates.length > 0, `${candidates.length} 件`);
  if (candidates.length === 0) return;

  const researchModel = candidates[0].name;
  note(`選択された Research モデル: ${researchModel} (score=${candidates[0].score})`);
  note(`上位 3 件: ${candidates.slice(0, 3).map(c => `${c.name}(${c.score})`).join(", ")}`);

  const today = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric" });
  const prompt =
    `今日は${today}です。この日の日本の記念日・季節の花・重要なイベントを` +
    `Google検索で調べ、最も特徴的なものを1つ選んでください。` +
    `回答は以下のJSONのみ（マークダウン・説明文は不要）:\n` +
    `{"theme":"記念日名","description":"50文字以内の説明","sourceUrl":"参照した実際のURL"}`;

  console.log("  （Gemini + Google Search を呼び出し中…）");
  const { ok: callOk, res, error } = await safeFetch(
    `${GEMINI_BASE}/${researchModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
    },
    60_000  // Google Search grounding は応答に時間がかかるため60秒
  );
  if (!check("Research API 呼び出し成功", callOk, error)) return;

  const data = await res.json();
  if (!check("HTTP 200", res.ok, `status=${res.status} ${data.error?.message?.slice(0, 80) ?? ""}`)) return;

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  check("レスポンスにテキストあり", !!rawText, rawText.slice(0, 60));

  let result;
  try {
    const cleaned = rawText.replace(/```json\s*|\s*```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*?\}/);
    result = JSON.parse(match ? match[0] : cleaned);
  } catch {
    check("JSON パース", false, `生のテキスト: ${rawText.slice(0, 100)}`);
    return;
  }

  check("JSON パース成功",         true);
  check("theme あり",       !!result.theme,       result.theme ?? "(空)");
  check("description あり", !!result.description, result.description?.slice(0, 50) ?? "(空)");

  // worker/index.js と同じ sourceUrl 解決ロジック
  // 1) JSON内がvertexaisearchなら除去
  if (result.sourceUrl?.includes("vertexaisearch.cloud.google.com")) {
    warn(`JSON内のsourceUrlがvertexaisearch → worker同様に除去してフォールバックへ`);
    result.sourceUrl = "";
  }
  // 2) groundingChunksから非vertexaisearch URLを探す
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  if (!result.sourceUrl) {
    const uri = groundingChunks[0]?.web?.uri ?? "";
    if (uri && !uri.includes("vertexaisearch.cloud.google.com")) {
      result.sourceUrl = uri;
    }
  }
  // 3) Google Search クエリでフォールバック
  const queries = data.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  if (!result.sourceUrl && queries.length > 0) {
    result.sourceUrl = `https://www.google.com/search?q=${encodeURIComponent(queries[0])}`;
  }

  if (result.sourceUrl) {
    check("sourceUrl あり", true, result.sourceUrl.slice(0, 80));
    await checkSourceUrl(result.sourceUrl);
  } else {
    check("sourceUrl あり", false, "sourceUrl もフォールバック用クエリも取得できませんでした");
  }
}

// ─── チェック 3b: sourceUrl の到達確認 ───────────────────────────────────────
async function checkSourceUrl(url) {
  console.log(`\n  [3b] sourceUrl 到達確認`);
  note(`URL: ${url.slice(0, 100)}`);

  if (url.includes("vertexaisearch.cloud.google.com")) {
    check(
      "vertexaisearch URL でない（フィルタが効いている）", false,
      "vertexaisearch リダイレクト URL が混入 → worker/index.js のフィルターを確認"
    );
    return;
  }

  if (url.startsWith("https://www.google.com/search")) {
    note("Google 検索フォールバック URL です（直接の根拠 URL は取得できませんでした）");
    return;
  }

  const { ok: reached, res, error } = await safeFetch(url);
  if (!reached) {
    warn(`sourceUrl ネットワークエラー: ${error}（外部サイトのため警告のみ）`);
    return;
  }
  if (res.status < 400) {
    check(`sourceUrl HTTP ${res.status} (< 400)`, true, url.slice(0, 60));
  } else {
    warn(`sourceUrl HTTP ${res.status} → 外部サイトが一時的に不達（コードの問題ではない）`);
  }
}

// ─── チェック 4: Pollinations.ai 到達確認 ────────────────────────────────────
async function checkPollinations() {
  console.log("\n[4] Pollinations.ai 到達確認");
  const url =
    "https://image.pollinations.ai/prompt/cat?model=flux&width=64&height=64&seed=1&nologo=true";

  const { ok: reached, res, error } = await safeFetch(url);
  // フォールバックサービスのため、到達不能・HTTP 異常・非画像レスポンスはすべて警告扱い（CI 失敗にしない）
  if (!reached) { warn(`Pollinations API へ到達できない: ${error}`); return; }
  if (!res.ok) { warn(`HTTP ${res.status}: Pollinations が一時的に利用不可の可能性あり`); return; }
  const ct = res.headers.get("Content-Type") ?? "";
  if (!ct.startsWith("image/")) warn(`画像でないレスポンス: Content-Type=${ct}（一時障害の可能性）`);
  else pass(`画像 (image/*) を返す: Content-Type=${ct}`);
}

// ─── チェック B1: Bluesky 認証確認 ───────────────────────────────────────────
async function checkBlueskyAuth(identifier, appPassword) {
  console.log("\n[B1] Bluesky 認証確認");
  const { ok, res, error } = await safeFetch(
    "https://bsky.social/xrpc/com.atproto.server.createSession",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password: appPassword }),
    }
  );
  if (!check("Bluesky API へ到達できる", ok, error)) return false;
  const data = await res.json();
  if (!check("HTTP 200", res.ok, `status=${res.status} ${data.error ?? ""} ${data.message ?? ""}`)) return false;
  check("accessJwt あり", !!data.accessJwt);
  check("did あり",       !!data.did, data.did ?? "(空)");
  check("handle あり",    !!data.handle, data.handle ?? "(空)");
  return !!data.accessJwt;
}

// ─── チェック D1: Discord Webhook 確認 ───────────────────────────────────────
async function checkDiscordWebhook(webhookUrl) {
  console.log("\n[D1] Discord Webhook 確認");
  // GET リクエストはメッセージ送信なしで Webhook の情報のみ返す
  const { ok, res, error } = await safeFetch(webhookUrl);
  if (!check("Discord Webhook URL へ到達できる", ok, error)) return;
  const data = await res.json().catch(() => ({}));
  if (!check("HTTP 200", res.ok, `status=${res.status}`)) return;
  check("Webhook 名あり",  !!data.name,       `name=${data.name ?? "(空)"}`);
  check("channel_id あり", !!data.channel_id, `channel_id=${data.channel_id ?? "(空)"}`);
}

// ─── チェック Bot: 投稿テキスト生成確認（外部通信なし）─────────────────────
function checkBotPostText() {
  console.log("\n[Bot] 投稿テキスト生成確認");

  const SITE_URL     = "https://hiroshikuze.github.io/anniversary-cat-worker/";
  const HASHTAG_LIST = ["#AIart", "#cat", "#kitten", "#ほのぼの", "#猫"];
  const HASHTAGS     = HASHTAG_LIST.join(" ");

  // worker/bluesky-bot.js の buildPostText と同一ロジック
  function buildPostText(theme, description) {
    const header = `今日は「${theme}」の日！🐱`;
    const body   = description ? `\n${description}` : "";
    const cta    = `\n\nあなたも今日のにゃんバーサリーを作ってみませんか？\n${SITE_URL}`;
    const tags   = `\n\n${HASHTAGS}`;
    return header + body + cta + tags;
  }

  // worker/bluesky-bot.js の buildHashtagFacets と同一ロジック
  function buildHashtagFacets(text) {
    const encoder = new TextEncoder();
    const facets  = [];
    for (const tag of HASHTAG_LIST) {
      let searchFrom = 0;
      while (true) {
        const idx = text.indexOf(tag, searchFrom);
        if (idx === -1) break;
        const byteStart = encoder.encode(text.slice(0, idx)).length;
        const byteEnd   = byteStart + encoder.encode(tag).length;
        facets.push({
          index:    { byteStart, byteEnd },
          features: [{ $type: "app.bsky.richtext.facet#tag", tag: tag.slice(1) }],
        });
        searchFrom = idx + tag.length;
      }
    }
    return facets;
  }

  const theme       = "猫の日";
  const description = "日本の記念日。猫の鳴き声「ニャン（2）ニャン（2）ニャン（2）」にちなむ。";
  const text        = buildPostText(theme, description);

  // --- テキスト内容チェック ---
  const segmenter = new Intl.Segmenter();
  const graphemes = [...segmenter.segment(text)].length;
  check("テキスト生成成功",   text.length > 0,                    `${graphemes} grapheme`);
  check("300 grapheme 以内",  graphemes <= 300,                   `${graphemes}/300`);
  check("テーマ含む",         text.includes(theme));
  check("説明文含む",         text.includes(description));
  check("サイト URL 含む",    text.includes(SITE_URL));
  check("全ハッシュタグ含む", HASHTAG_LIST.every(t => text.includes(t)), HASHTAG_LIST.join(" "));

  // --- ファセットチェック ---
  const facets = buildHashtagFacets(text);
  check(`ファセット数 ${HASHTAG_LIST.length} 件`, facets.length === HASHTAG_LIST.length, `${facets.length} 件`);

  // 各ファセットのバイト位置が UTF-8 エンコード上で正確か検証
  const encoder   = new TextEncoder();
  const decoder   = new TextDecoder();
  const fullBytes = encoder.encode(text);
  let allOk = true;
  for (const facet of facets) {
    const { byteStart, byteEnd } = facet.index;
    const extracted = decoder.decode(fullBytes.slice(byteStart, byteEnd));
    const expected  = `#${facet.features[0].tag}`;
    if (extracted !== expected) {
      allOk = false;
      fail(`バイト位置ずれ: expected="${expected}" got="${extracted}"`);
    }
  }
  if (allOk) check("ファセットのバイト位置が正確（UTF-8）", true);

  // --- エッジケース: 説明文なし ---
  const textNoDesc      = buildPostText("海の日", "");
  const graphemesNoDesc = [...segmenter.segment(textNoDesc)].length;
  check("説明文なしでも生成できる",        textNoDesc.includes("海の日"));
  check("説明文なしでも 300 grapheme 以内", graphemesNoDesc <= 300, `${graphemesNoDesc}/300`);
}

// ─── Worker エンドツーエンドチェック ─────────────────────────────────────────
async function checkWorker(workerUrl, bypassToken) {
  const headers = {
    "Content-Type": "application/json",
    ...(bypassToken ? { "X-Bypass-Token": bypassToken } : {}),
  };

  console.log("\n[W1] Worker /research エンドツーエンド");
  const today = new Date().toISOString().slice(0, 10);
  const { ok: reached, res, error } = await safeFetch(`${workerUrl}/research`, {
    method: "POST",
    headers,
    body: JSON.stringify({ date: today }),
  });
  if (!check("Worker /research 到達", reached, error)) return null;

  const data = await res.json();
  check("HTTP 200",           res.status === 200, `status=${res.status} ${data.error ?? ""}`);
  check("theme あり",         !!data.theme,       data.theme ?? "(空)");
  check("description あり",   !!data.description, data.description?.slice(0, 40) ?? "(空)");
  check("sourceUrl あり",     !!data.sourceUrl,   data.sourceUrl?.slice(0, 60) ?? "(空)");
  if (data.sourceUrl) await checkSourceUrl(data.sourceUrl);

  console.log("\n[W2] Worker /generate エンドツーエンド");
  const { ok: genReached, res: genRes, error: genErr } = await safeFetch(
    `${workerUrl}/generate`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ theme: data.theme ?? "猫の日", description: "テスト" }),
    }
  );
  if (!check("Worker /generate 到達", genReached, genErr)) return;

  const genData = await genRes.json();
  check("HTTP 200",          genRes.status === 200, `status=${genRes.status} ${genData.error ?? ""}`);
  check("imageData あり",    !!genData.imageData,   `source=${genData.source ?? "?"}`);

  return data;
}

// ─── メイン ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Anniversary Cat Worker ヘルスチェック ===");
  console.log(`実行日時: ${new Date().toLocaleString("ja-JP")}\n`);

  const apiKey        = process.env.GEMINI_API_KEY;
  const workerUrl     = process.env.WORKER_URL?.replace(/\/$/, "");
  const bypass        = process.env.BYPASS_TOKEN;
  const bskyId        = process.env.BLUESKY_IDENTIFIER;
  const bskyPass      = process.env.BLUESKY_APP_PASSWORD;
  const discordUrl    = process.env.DISCORD_WEBHOOK_URL;

  if (!apiKey && !workerUrl && !bskyId && !discordUrl) {
    console.error("エラー: 環境変数が設定されていません\n");
    console.error("使い方:");
    console.error("  GEMINI_API_KEY=xxx node scripts/health-check.js");
    console.error("  WORKER_URL=https://... BYPASS_TOKEN=xxx node scripts/health-check.js");
    console.error("  BLUESKY_IDENTIFIER=xxx BLUESKY_APP_PASSWORD=xxx node scripts/health-check.js");
    console.error("  DISCORD_WEBHOOK_URL=https://... node scripts/health-check.js");
    process.exit(1);
  }

  if (apiKey) {
    const allModels = await checkGeminiReachable(apiKey);
    if (allModels) {
      await checkImageModels(apiKey, allModels);
      await checkResearch(apiKey, allModels);
    }
    await checkPollinations();
  }

  if (workerUrl) {
    await checkWorker(workerUrl, bypass);
  }

  if (bskyId && bskyPass) {
    await checkBlueskyAuth(bskyId, bskyPass);
  } else if (bskyId || bskyPass) {
    warn("BLUESKY_IDENTIFIER と BLUESKY_APP_PASSWORD の両方が必要です（スキップ）");
  }

  if (discordUrl) {
    await checkDiscordWebhook(discordUrl);
  }

  // Bot 投稿テキスト生成は常に実行（外部通信なし）
  checkBotPostText();

  console.log(`\n${"─".repeat(50)}`);
  if (failures === 0) {
    console.log("✓ すべてのチェックが通過しました");
  } else {
    console.error(`✗ ${failures} 件のチェックが失敗しました`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("予期しないエラー:", e);
  process.exit(1);
});
