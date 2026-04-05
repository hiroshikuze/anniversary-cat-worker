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
 * base64画像を fal.ai AuraSR で4倍アップスケールする。
 * CDN URL をそのまま返す（base64ダウンロードは行わない）。
 * Cloudflare Workers の CPU 時間制限対策：大きな画像の base64 変換は避ける。
 * FAL_KEY 未設定時は cdnUrl=null を返す（呼び出し元が元画像で代替する）。
 *
 * @param {string} imageData - base64エンコードされた画像データ（fal.aiへの入力）
 * @param {string} mimeType  - 例: "image/png", "image/jpeg"
 * @param {object} env       - Cloudflare Workers 環境変数（FAL_KEY を参照）
 * @returns {Promise<{cdnUrl: string|null, mimeType: string}>}
 *   cdnUrl: アップスケール後のCDN URL。FAL_KEY未設定またはスキップ時はnull。
 */
export async function upscaleWithFal(imageData, mimeType, env) {
  if (!env.FAL_KEY) {
    console.log("[fal] FAL_KEY 未設定 - アップスケールをスキップ");
    return { cdnUrl: null, mimeType };
  }

  const dataUri = `data:${mimeType};base64,${imageData}`;

  const res = await fetch(FAL_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: dataUri }),
    signal: AbortSignal.timeout(22_000),
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

  console.log(`[fal] AuraSR 完了 cdnUrl=${cdnUrl}`);
  return { cdnUrl, mimeType: "image/png" };
}
