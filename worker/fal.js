/**
 * worker/fal.js - fal.ai ESRGAN アップスケーリング（Queue API方式）
 *
 * Queue APIでジョブを非同期投入し、request_idで結果を取得する。
 * fal.run（同期）と異なり、接続が切れても後からrequest_idで結果を参照できる。
 * FAL_KEY 未設定時はスキップして null を返す（best-effort）。
 *
 * モデル選定理由:
 *   AuraSR 4x: 1024px入力 → 4096px PNG ≈ 24MB → SUZURI 20MB上限超過で毎回フォールバック
 *   ESRGAN 2x: 1024px入力 → 2048px PNG ≈ 6MB → SUZURI上限内で安定登録 ✅
 *   目標は「4x厳密」ではなく「Tシャツ印刷品質の向上」のためESRGANで十分
 *
 * 必要なシークレット: FAL_KEY
 */

const FAL_QUEUE_BASE = "https://queue.fal.run/fal-ai/esrgan";

/** fal.ai 関連の Discord 通知ヘルパー（env.DISCORD_WEBHOOK_URL を使用） */
async function notifyFalDiscord(env, message) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⚠️ にゃんバーサリーBot（fal.ai）\n${message}` }),
    });
  } catch (e) {
    console.error("[fal] Discord通知失敗:", e.message);
  }
}

/**
 * fal.ai Queue にアップスケールジョブを投入する。
 * 投入は即座に完了（数秒以内）し、request_id を返す。
 * FAL_KEY 未設定時は requestId=null を返す（呼び出し元が base64 で代替する）。
 * 残高不足（403）の場合はDiscordに通知してthrowする。
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
    if (res.status === 403) {
      // 残高不足の可能性が高い
      await notifyFalDiscord(env, `fal.aiクレジット残高不足の可能性\nstatus=403 ${errText}\nhttps://fal.ai/dashboard/billing でチャージしてください`);
    }
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
 * ジョブが FAILED の場合は Discord に通知する。
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

  if (status === "FAILED") {
    await notifyFalDiscord(env, `fal.ai ジョブ失敗\nrequestId=${requestId}\nhttps://fal.ai/dashboard で確認してください`);
    return { status: "FAILED" };
  }

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
  // モデルによりレスポンス構造が異なるため複数パスを確認
  const cdnUrl =
    result?.image?.url ??
    result?.images?.[0]?.url ??
    result?.output?.image?.url ??
    result?.output?.[0]?.url ??
    result?.output?.url ??
    result?.url ??
    null;
  if (!cdnUrl) {
    console.warn(`[fal] result: CDN URL が取得できません result=${JSON.stringify(result).slice(0, 200)}`);
    return { status: "error" };
  }

  console.log(`[fal] queue result取得 cdnUrl=${cdnUrl}`);
  return { status: "COMPLETED", cdnUrl, mimeType: "image/png" };
}
