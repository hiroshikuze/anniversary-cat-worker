/**
 * worker/bluesky-bot.js - Bluesky 営業 Bot
 * @updated 2026-03-24
 *
 * Cloudflare Workers の Cron Trigger（月〜金 10:00 UTC = 19:00 JST）で起動。
 * worker/index.js の scheduled ハンドラから runBot(env) を呼び出す。
 *
 * 必要なシークレット（wrangler secret put で登録）:
 *   BLUESKY_IDENTIFIER    ... nyanmusu.bsky.social
 *   BLUESKY_APP_PASSWORD  ... Bluesky の App Password
 *   DISCORD_WEBHOOK_URL   ... エラー通知用 Discord Webhook URL
 *   BYPASS_TOKEN          ... /research・/generate のレート制限スキップトークン
 */

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

const HASHTAG_LIST = ["#AIart", "#cat", "#kitten", "#ほのぼの", "#猫"];
const HASHTAGS     = HASHTAG_LIST.join(" ");

// ---------------------------------------------------------------------------
// 投稿テキスト生成
// ---------------------------------------------------------------------------

/**
 * Bluesky 投稿テキストを生成する。
 * Bluesky の上限は 300 grapheme。この形式では最大 ~220 grapheme 程度に収まる。
 */
export function buildPostText(theme, description) {
  const header = `今日は「${theme}」の日！🐱`;
  const body   = description ? `\n${description}` : "";
  const cta    = `\n\nあなたも今日のにゃんバーサリーを作ってみませんか？\n${SITE_URL}`;
  const tags   = `\n\n${HASHTAGS}`;
  return header + body + cta + tags;
}

/**
 * テキスト中のハッシュタグを AT Protocol の facets 形式（UTF-8 バイト位置）に変換する。
 * JavaScript 文字列は UTF-16 のため、バイト位置計算に TextEncoder を使う。
 */
export function buildHashtagFacets(text) {
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
async function createPost(accessJwt, did, text, blobRef, mimeType, altText) {
  const record = {
    $type:     "app.bsky.feed.post",
    text,
    facets:    buildHashtagFacets(text),
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

/** Discord Webhook にエラーメッセージを送信する */
export async function notifyDiscord(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ content: `❌ にゃんバーサリーBot\n${message}` }),
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
  const jst     = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dateStr = `${jst.getFullYear()}年${jst.getMonth() + 1}月${jst.getDate()}日`;
  const prefix  = `[bot] ${dateStr}`;

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
      { theme: research.theme, description: research.description },
      apiKey
    );
    console.log(`${prefix} generate 完了 source=${generated.source}`);

    // ── 3. Bluesky に投稿 ──────────────────────────────────────────────────
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

    const text    = buildPostText(research.theme, research.description ?? "");
    const altText = `にゃんバーサリー - 「${research.theme}」をテーマにAIが生成した水彩画風の猫イラスト`;
    const postResult = await createPost(accessJwt, did, text, blobRef, mimeType, altText);

    console.log(`${prefix} Bluesky 投稿 完了 uri=${postResult.uri ?? "(不明)"} identifier=${env.BLUESKY_IDENTIFIER}`);

  } catch (err) {
    const msg = `${prefix} エラー: ${err.message}`;
    console.error(msg);
    await notifyDiscord(env.DISCORD_WEBHOOK_URL, msg);
  }
}
