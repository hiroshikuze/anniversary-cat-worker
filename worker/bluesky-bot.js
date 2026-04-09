/**
 * worker/bluesky-bot.js - Bluesky 営業 Bot
 * @updated 2026-03-28
 *
 * Cloudflare Workers の Cron Trigger（月〜金 10:00 UTC = 19:00 JST）で起動。
 * worker/index.js の scheduled ハンドラから runBot(env) を呼び出す。
 *
 * 必要なシークレット（wrangler secret put で登録）:
 *   BLUESKY_IDENTIFIER    ... nyanmusu.bsky.social
 *   BLUESKY_APP_PASSWORD  ... Bluesky の App Password
 *   DISCORD_WEBHOOK_URL   ... エラー通知用 Discord Webhook URL
 *   BYPASS_TOKEN          ... /research・/generate のレート制限スキップトークン
 *   SUZURI_API_KEY        ... SUZURI API キー（商品生成用）
 */

import { saveToR2 } from "./r2-storage.js";
import { createSuzuriProducts } from "./suzuri.js";

// Photonは動的importで遅延ロード（Node.jsテスト環境での.wasmロード失敗を回避）
let _photonReady = false;
let _PhotonImage  = null;

async function ensurePhoton() {
  if (_photonReady) return;
  const { PhotonImage, initSync } = await import("@silvia-odwyer/photon");
  const { default: photonWasm }   = await import("@silvia-odwyer/photon/photon_rs_bg.wasm");
  initSync({ module: photonWasm });
  _PhotonImage  = PhotonImage;
  _photonReady  = true;
}

const BLUESKY_API            = "https://bsky.social/xrpc";
const SITE_URL               = "https://hiroshikuze.github.io/anniversary-cat-worker/";
export const BLUESKY_MAX_IMAGE_BYTES = 976_000; // Bluesky上限 1,000,000 bytes に余裕を持たせた値

const HASHTAG_LIST = ["#AIart", "#cat", "#kitten", "#ほのぼの", "#猫", "#にゃんバーサリー"];
const HASHTAGS     = HASHTAG_LIST.join(" ");

// ---------------------------------------------------------------------------
// 投稿テキスト生成
// ---------------------------------------------------------------------------

/**
 * テーマ文字列をBlueskyハッシュタグ文字列（#付き）に変換する。
 * Unicode文字・数字・アンダースコア以外（空白・記号等）を除去し、最大30文字でトリム。
 * 空文字になる場合は null を返す。
 * @param {string|null} theme
 * @returns {string|null}
 */
export function buildThemeTag(theme) {
  if (!theme) return null;
  const normalized = theme.replace(/[^\p{L}\p{N}_]/gu, "");
  if (!normalized) return null;
  return `#${normalized.slice(0, 30)}`;
}

/**
 * Bluesky 投稿テキストを生成する。
 * Bluesky の上限は 300 grapheme。この形式では最大 ~210 grapheme 程度に収まる。
 * @param {string} theme
 * @param {string} description
 * @param {string} [pageUrl] - CTA に使う URL（デフォルト: SITE_URL）
 */
export function buildPostText(theme, description, pageUrl = SITE_URL) {
  const header   = `今日は「${theme}」の日！🐱`;
  const body     = description ? `\n${description}` : "";
  const cta      = `\n\nあなたも今日の #にゃんバーサリー を作ってみませんか？\n${pageUrl}`;
  const themeTag = buildThemeTag(theme);
  const allTags  = themeTag ? `${HASHTAGS} ${themeTag}` : HASHTAGS;
  const tags     = `\n\n${allTags}`;
  return header + body + cta + tags;
}

/**
 * テキスト中のハッシュタグを AT Protocol の facets 形式（UTF-8 バイト位置）に変換する。
 * JavaScript 文字列は UTF-16 のため、バイト位置計算に TextEncoder を使う。
 * @param {string} text
 * @param {string[]} [additionalTags] - 固定リスト以外に検索するタグ（例: テーマタグ）
 */
export function buildHashtagFacets(text, additionalTags = []) {
  const encoder = new TextEncoder();
  const facets  = [];
  const allTags = [...HASHTAG_LIST, ...additionalTags];

  for (const tag of allTags) {
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

/**
 * テキスト中の URL を AT Protocol の facets 形式（link タイプ）に変換する。
 * iOSなど一部クライアントではURLをfacetで明示しないとリンクにならないため必要。
 * @param {string} text
 * @param {string} [url] - 検索・リンク先 URL（デフォルト: SITE_URL）
 */
export function buildUrlFacets(text, url = SITE_URL) {
  const encoder = new TextEncoder();
  const facets  = [];
  let searchFrom = 0;

  while (true) {
    const idx = text.indexOf(url, searchFrom);
    if (idx === -1) break;
    const byteStart = encoder.encode(text.slice(0, idx)).length;
    const byteEnd   = byteStart + encoder.encode(url).length;
    facets.push({
      index:    { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
    searchFrom = idx + url.length;
  }

  return facets;
}

// ---------------------------------------------------------------------------
// Bluesky AT Protocol ヘルパー
// ---------------------------------------------------------------------------

/** App Password でセッションを作成し accessJwt と did を返す */
async function createBlueskySession(identifier, password) {
  const res = await fetch(`${BLUESKY_API}/com.atproto.server.createSession`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ identifier, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Bluesky 認証失敗: ${data.error ?? res.status} ${data.message ?? ""}`);
  }
  return { accessJwt: data.accessJwt, did: data.did };
}

/** ArrayBuffer を base64 文字列に変換 */
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 文字列を Uint8Array に変換（Cloudflare Workers の atob を使用） */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Uint8Array を base64 文字列に変換 */
function uint8ArrayToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Pollinationsから512×512の小サイズ画像を再取得する（最終フォールバック）。
 */
async function shrinkByPollinations(theme, description) {
  const toAscii = (s) => (s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const subject = toAscii(theme) || toAscii(description) || "anniversary";
  const prompt  = `kawaii watercolor cat, ${subject}, pastel colors, white background`;
  const seed    = Math.floor(Math.random() * 1_000_000);
  const url     = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
                  `?model=flux&width=512&height=512&seed=${seed}&nologo=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`画像縮小取得失敗: Pollinations status=${res.status}`);

  const buffer  = await res.arrayBuffer();
  const newMime = res.headers.get("Content-Type") || "image/jpeg";
  console.log(`[bot] Pollinations縮小画像取得完了 (${buffer.byteLength} bytes)`);
  return { imageData: arrayBufferToBase64(buffer), mimeType: newMime };
}

/**
 * Bluesky上限（~976KB）を超える画像をPhotonでJPEG圧縮する。
 * Photon失敗時またはJPEG圧縮後もサイズ超過の場合はPollinationsで再取得する。
 */
async function shrinkImageIfNeeded(imageData, mimeType, theme, description) {
  const bytes = base64ToBytes(imageData);
  if (bytes.length <= BLUESKY_MAX_IMAGE_BYTES) {
    return { imageData, mimeType };
  }
  console.log(`[bot] 画像サイズ超過 (${bytes.length} bytes > ${BLUESKY_MAX_IMAGE_BYTES})、Photon JPEG圧縮を試みます`);

  try {
    await ensurePhoton();

    // quality 70 で圧縮
    const img1      = _PhotonImage.new_from_byteslice(bytes);
    const jpeg70    = img1.get_bytes_jpeg(70);
    img1.free();
    if (jpeg70.length <= BLUESKY_MAX_IMAGE_BYTES) {
      console.log(`[bot] Photon圧縮完了 quality=70 (${jpeg70.length} bytes)`);
      return { imageData: uint8ArrayToBase64(jpeg70), mimeType: "image/jpeg" };
    }

    // quality 40 で再試行
    const img2      = _PhotonImage.new_from_byteslice(bytes);
    const jpeg40    = img2.get_bytes_jpeg(40);
    img2.free();
    if (jpeg40.length <= BLUESKY_MAX_IMAGE_BYTES) {
      console.log(`[bot] Photon圧縮完了 quality=40 (${jpeg40.length} bytes)`);
      return { imageData: uint8ArrayToBase64(jpeg40), mimeType: "image/jpeg" };
    }

    console.log(`[bot] Photon圧縮後もサイズ超過 (${jpeg40.length} bytes)、Pollinationsフォールバック`);
  } catch (err) {
    console.log(`[bot] Photon圧縮失敗 (${err.message})、Pollinationsフォールバック`);
  }

  return shrinkByPollinations(theme, description);
}

export { shrinkImageIfNeeded };

/**
 * テスト用: PhotonImageのモックを注入する。
 * Node.jsテスト環境ではWASMが使えないため、この関数でモックに差し替える。
 * @param {object|null} mockPhotoImage - モックするPhotoImageオブジェクト。nullでリセット。
 */
export function _setPhotonForTest(mockPhotoImage) {
  _PhotonImage = mockPhotoImage;
  _photonReady = mockPhotoImage !== null;
}

/** 画像データを Bluesky にアップロードして blob 参照を返す */
async function uploadBlob(accessJwt, imageBytes, mimeType) {
  const res = await fetch(`${BLUESKY_API}/com.atproto.repo.uploadBlob`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${accessJwt}`,
      "Content-Type":  mimeType,
    },
    body: imageBytes,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`画像アップロード失敗: ${data.error ?? res.status} ${data.message ?? ""}`);
  }
  return data.blob;
}

/** テキスト・画像・ファセットを含む投稿レコードを作成する */
async function createPost(accessJwt, did, text, blobRef, mimeType, altText, pageUrl = SITE_URL, themeTag = null) {
  const record = {
    $type:     "app.bsky.feed.post",
    text,
    facets:    [...buildHashtagFacets(text, themeTag ? [themeTag] : []), ...buildUrlFacets(text, pageUrl)],
    embed:     {
      $type:  "app.bsky.embed.images",
      images: [{
        image: blobRef,
        alt:   altText,
      }],
    },
    createdAt: new Date().toISOString(),
  };

  const res = await fetch(`${BLUESKY_API}/com.atproto.repo.createRecord`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${accessJwt}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`投稿作成失敗: ${data.error ?? res.status} ${data.message ?? ""}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Discord 通知
// ---------------------------------------------------------------------------

/** Discord Webhook にメッセージを送信する。emoji省略時は❌（エラー用） */
export async function notifyDiscord(webhookUrl, message, emoji = "❌") {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ content: `${emoji} にゃんバーサリーBot\n${message}` }),
    });
  } catch (e) {
    // Discord 通知失敗はログのみ（二重エラーを避ける）
    console.error("[bot] Discord 通知失敗:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Bot メイン処理
// ---------------------------------------------------------------------------

/**
 * Cron Trigger から呼び出されるエントリポイント。
 * 失敗時はログ記録と Discord 通知を行い、リトライはしない。
 * （/generate 内部に Pollinations フォールバックがあるため外側リトライは二重投稿の恐れあり）
 *
 * @param {object} env - Cloudflare Workers の環境変数
 * @param {Function} handleResearch - index.js の handleResearch 関数
 * @param {Function} handleGenerate - index.js の handleGenerate 関数
 */
export async function runBot(env, handleResearch, handleGenerate) {
  // JST で日付文字列を生成（UTC+9）
  const jst        = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dateStr    = `${jst.getFullYear()}年${jst.getMonth() + 1}月${jst.getDate()}日`;
  const jstDateISO = `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, "0")}-${String(jst.getDate()).padStart(2, "0")}`;
  const r2Id       = `bot/${jstDateISO}`;
  const prefix     = `[bot] ${dateStr}`;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    const msg = `${prefix} エラー: GEMINI_API_KEY が設定されていません`;
    console.error(msg);
    await notifyDiscord(env.DISCORD_WEBHOOK_URL, msg);
    return;
  }

  try {
    // ── 1. 記念日リサーチ ──────────────────────────────────────────────────
    console.log(`${prefix} research 開始`);
    const research = await handleResearch({ date: dateStr }, apiKey);
    console.log(`${prefix} research 完了 theme="${research.theme}"`);

    // ── 2. 画像生成 ────────────────────────────────────────────────────────
    console.log(`${prefix} generate 開始`);
    const generated = await handleGenerate(
      { theme: research.theme, description: research.description, visualHint: research.visualHint ?? null },
      apiKey
    );
    console.log(`${prefix} generate 完了 source=${generated.source}`);

    // ── 3. SUZURI 商品生成（best-effort） ─────────────────────────────────
    let pageUrl        = SITE_URL;
    let materialId     = null;
    let suzuriProducts = [];

    if (env.SUZURI_API_KEY) {
      try {
        const imgMime = generated.mimeType || "image/png";

        // TODO(fal.ai): 非同期アーキテクチャ実装後に有効化する
        // ctx.waitUntil() + ポーリング方式で t-shirt+sticker グループのみ高解像度化する計画あり
        // 詳細: .claude/rules/architecture.md「fal.ai AuraSRアップスケーリング」参照
        const suzuriTexture = `data:${imgMime};base64,${generated.imageData}`;

        const suzuriResult = await createSuzuriProducts(suzuriTexture, research.theme, env);
        materialId     = suzuriResult.materialId;
        suzuriProducts = suzuriResult.products;
        console.log(`${prefix} SUZURI商品生成完了 materialId=${materialId}`);
      } catch (err) {
        console.warn(`${prefix} SUZURI商品生成失敗（投稿は継続）: ${err.message}`);
      }
    }

    // ── 4. R2 保存（best-effort） ─────────────────────────────────────────
    if (env.IMAGE_BUCKET) {
      try {
        const meta = {
          theme:       research.theme,
          description: research.description ?? "",
          sourceUrl:   research.sourceUrl   ?? "",
          materialId,
          products:    suzuriProducts,
          createdAt:   new Date().toISOString(),
        };
        await saveToR2(
          env.IMAGE_BUCKET,
          r2Id,
          { data: generated.imageData, mimeType: generated.mimeType || "image/png" },
          meta
        );
        pageUrl = `${SITE_URL}?id=${r2Id}`;
        console.log(`${prefix} R2保存完了 id=${r2Id}`);
      } catch (err) {
        console.warn(`${prefix} R2保存失敗（投稿は継続）: ${err.message}`);
      }
    }

    // ── 5. Bluesky に投稿 ──────────────────────────────────────────────────
    console.log(`${prefix} Bluesky 投稿 開始`);
    const { accessJwt, did } = await createBlueskySession(
      env.BLUESKY_IDENTIFIER,
      env.BLUESKY_APP_PASSWORD
    );

    const shrunk     = await shrinkImageIfNeeded(
      generated.imageData, generated.mimeType || "image/png",
      research.theme, research.description ?? ""
    );
    const imageBytes = base64ToBytes(shrunk.imageData);
    const mimeType   = shrunk.mimeType;
    const blobRef    = await uploadBlob(accessJwt, imageBytes, mimeType);

    const themeTag = buildThemeTag(research.theme);
    const text     = buildPostText(research.theme, research.description ?? "", pageUrl);
    const desc     = research.description ?? "";
    const altText  = desc
      ? `にゃんバーサリー - 「${research.theme}」の日！${desc}（AIが生成した水彩画風の猫イラスト）`
      : `にゃんバーサリー - 「${research.theme}」をテーマにAIが生成した水彩画風の猫イラスト`;
    const postResult = await createPost(accessJwt, did, text, blobRef, mimeType, altText, pageUrl, themeTag);

    console.log(`${prefix} Bluesky 投稿 完了 uri=${postResult.uri ?? "(不明)"} identifier=${env.BLUESKY_IDENTIFIER}`);

    // ── 6. 生成内容を Discord に通知（プロンプト確認用） ────────────────────
    try {
      const lines = [
        `✅ Bluesky投稿完了 ${dateStr}`,
        `📅 テーマ: ${research.theme}`,
        research.description ? `📝 説明: ${research.description}` : null,
        research.visualHint  ? `🎨 視覚ヒント: ${research.visualHint}` : null,
        generated.persona    ? `🐱 毛柄: ${generated.persona}`    : null,
        generated.personality ? `😺 性格: ${generated.personality}` : null,
        `🖼 ソース: ${generated.source}`,
        generated.prompt     ? `\n📋 プロンプト:\n${generated.prompt}` : null,
        `\n📣 投稿テキスト（Mastodon・X・Instagram等に転載用）:\n${text}`,
      ].filter(Boolean).join("\n");
      await notifyDiscord(env.DISCORD_WEBHOOK_URL, lines, "✅");
    } catch (_) { /* 通知失敗は無視 */ }

  } catch (err) {
    const msg = `${prefix} エラー: ${err.message}`;
    console.error(msg);
    await notifyDiscord(env.DISCORD_WEBHOOK_URL, msg);
  }
}
