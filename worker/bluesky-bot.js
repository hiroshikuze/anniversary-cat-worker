/**
 * worker/bluesky-bot.js - Bluesky 営業 Bot
 * @updated 2026-03-23
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

const BLUESKY_API = "https://bsky.social/xrpc";
const SITE_URL    = "https://hiroshikuze.github.io/anniversary-cat-worker/";

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

/** base64 文字列を Uint8Array に変換（Cloudflare Workers の atob を使用） */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

    const imageBytes = base64ToBytes(generated.imageData);
    const mimeType   = generated.mimeType || "image/png";
    const blobRef    = await uploadBlob(accessJwt, imageBytes, mimeType);

    const text    = buildPostText(research.theme, research.description ?? "");
    const altText = `にゃんバーサリー - 「${research.theme}」をテーマにAIが生成した水彩画風の猫イラスト`;
    await createPost(accessJwt, did, text, blobRef, mimeType, altText);

    console.log(`${prefix} Bluesky 投稿 完了`);

  } catch (err) {
    const msg = `${prefix} エラー: ${err.message}`;
    console.error(msg);
    await notifyDiscord(env.DISCORD_WEBHOOK_URL, msg);
  }
}
