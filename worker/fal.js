/**
 * worker/fal.js - fal.ai AuraSR アップスケーリング
 *
 * Gemini生成画像（~1024px）をSUZURI推奨解像度（3000×3000px以上）に引き上げる。
 * FAL_KEY 未設定時はスキップして元画像を返す（best-effort）。
 *
 * 必要なシークレット: FAL_KEY
 */

const FAL_API_URL = "https://fal.run/fal-ai/aura-sr";

/**
 * base64画像を fal.ai AuraSR で4倍アップスケールして返す。
 * FAL_KEY 未設定時はそのまま返す（best-effort）。
 *
 * @param {string} imageData - base64エンコードされた画像データ
 * @param {string} mimeType  - 例: "image/png", "image/jpeg"
 * @param {object} env       - Cloudflare Workers 環境変数（FAL_KEY を参照）
 * @returns {Promise<{imageData: string, mimeType: string}>}
 */
export async function upscaleWithFal(imageData, mimeType, env) {
  if (!env.FAL_KEY) {
    console.log("[fal] FAL_KEY 未設定 - アップスケールをスキップ");
    return { imageData, mimeType };
  }

  const dataUri = `data:${mimeType};base64,${imageData}`;

  const res = await fetch(FAL_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: dataUri }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`fal.ai AuraSR 失敗: status=${res.status} ${errText}`);
  }

  const data = await res.json();
  const cdnUrl = data?.image?.url;
  if (!cdnUrl) {
    throw new Error(`fal.ai AuraSR: CDN URLが取得できません: ${JSON.stringify(data)}`);
  }

  // CDN URL から画像を fetch して base64 変換
  const imgRes = await fetch(cdnUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) throw new Error(`fal.ai CDN fetch 失敗: status=${imgRes.status}`);

  const buffer = await imgRes.arrayBuffer();
  const upscaledBase64 = _arrayBufferToBase64(buffer);
  const upscaledMime = imgRes.headers.get("content-type")?.split(";")[0] || "image/png";

  console.log(`[fal] AuraSR 完了 bytes=${buffer.byteLength}`);
  return { imageData: upscaledBase64, mimeType: upscaledMime };
}

/**
 * ArrayBuffer を base64 文字列に変換する（Cloudflare Workers 対応）。
 * スプレッド演算子は大きな配列でスタックオーバーフローするため、チャンク処理する。
 * テスト用にエクスポート。
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
