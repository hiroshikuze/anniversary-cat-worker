/**
 * worker/fal.js - fal.ai AuraSR アップスケーリング（Queue API方式）
 *
 * Queue APIでジョブを非同期投入し、request_idで結果を取得する。
 * fal.run（同期）と異なり、接続が切れても後からrequest_idで結果を参照できる。
 * FAL_KEY 未設定時はスキップして null を返す（best-effort）。
 *
 * 必要なシークレット: FAL_KEY
 */

const FAL_QUEUE_BASE = "https://queue.fal.run/fal-ai/aura-sr";

/**
 * fal.ai Queue にアップスケールジョブを投入する。
 * 投入は即座に完了（数秒以内）し、request_id を返す。
 * FAL_KEY 未設定時は requestId=null を返す（呼び出し元が base64 で代替する）。
 *
 * @param {string} imageData - base64 エンコードされた画像データ
 * @param {string} mimeType  - 例: "image/png", "image/jpeg"
 * @param {object} env       - Cloudflare Workers 環境変数（FAL_KEY を参照）
 * @returns {Promise<{requestId: string|null}>}
 */
export async function submitFalJob(imageData, mimeType, env) {
  if (!env.FAL_KEY) {
    console.log("[fal] FAL_KEY 未設定 - アップスケールをスキップ");
    return { requestId: null };
  }

  const dataUri = `data:${mimeType};base64,${imageData}`;
  const res = await fetch(FAL_QUEUE_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: dataUri }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`fal.ai queue投入失敗: status=${res.status} ${errText}`);
  }

  const data = await res.json();
  const requestId = data.request_id;
  if (!requestId) {
    throw new Error(`fal.ai queue: request_idが取得できません: ${JSON.stringify(data)}`);
  }

  console.log(`[fal] queue投入完了 requestId=${requestId}`);
  return { requestId };
}

/**
 * fal.ai Queue のジョブ状態を確認し、完了していれば CDN URL を返す。
 *
 * @param {string} requestId - submitFalJob で取得した request_id
 * @param {object} env       - Cloudflare Workers 環境変数（FAL_KEY を参照）
 * @returns {Promise<{status: string, cdnUrl?: string, mimeType?: string}>}
 *   status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "error"
 *   COMPLETED 時のみ cdnUrl と mimeType が付く
 */
export async function getFalResult(requestId, env) {
  const statusRes = await fetch(`${FAL_QUEUE_BASE}/requests/${requestId}/status`, {
    headers: { "Authorization": `Key ${env.FAL_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!statusRes.ok) {
    console.warn(`[fal] status check 失敗 status=${statusRes.status}`);
    return { status: "error" };
  }

  const { status } = await statusRes.json();
  console.log(`[fal] queue status=${status} requestId=${requestId}`);

  if (status !== "COMPLETED") return { status };

  const resultRes = await fetch(`${FAL_QUEUE_BASE}/requests/${requestId}`, {
    headers: { "Authorization": `Key ${env.FAL_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resultRes.ok) {
    console.warn(`[fal] result fetch 失敗 status=${resultRes.status}`);
    return { status: "error" };
  }

  const result = await resultRes.json();
  const cdnUrl = result?.image?.url;
  if (!cdnUrl) {
    console.warn(`[fal] result: CDN URL が取得できません`);
    return { status: "error" };
  }

  console.log(`[fal] queue result取得 cdnUrl=${cdnUrl}`);
  return { status: "COMPLETED", cdnUrl, mimeType: "image/png" };
}
