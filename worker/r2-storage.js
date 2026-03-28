/**
 * worker/r2-storage.js - Cloudflare R2ストレージ操作
 *
 * 画像ファイルとメタデータJSONをR2に保存・取得・削除する。
 * バインディング名: IMAGE_BUCKET（wrangler.tomlで定義）
 *
 * キー構造:
 *   bot/{YYYY-MM-DD}/web.png   - Bot生成画像（Web表示・SUZURI兼用）
 *   bot/{YYYY-MM-DD}/meta.json - メタデータ
 *   user/{uuid}/web.png        - ユーザー生成画像
 *   user/{uuid}/meta.json      - メタデータ
 */

/**
 * 画像とメタデータをR2に保存する。
 * @param {R2Bucket} bucket
 * @param {string} id - キープレフィックス（例: "bot/2026-03-28"）
 * @param {{ data: string, mimeType: string }} webImage - base64画像
 * @param {{ theme: string, description: string, sourceUrl: string, materialId: number|null, products: Array, createdAt: string }} meta
 */
export async function saveToR2(bucket, id, webImage, meta) {
  const imageBytes = base64ToUint8Array(webImage.data);
  const ext = webImage.mimeType === "image/jpeg" ? "jpg" : "png";

  await Promise.all([
    bucket.put(`${id}/web.${ext}`, imageBytes, {
      httpMetadata: { contentType: webImage.mimeType },
    }),
    bucket.put(`${id}/meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    }),
  ]);
}

/**
 * R2からメタデータを取得する。
 * @param {R2Bucket} bucket
 * @param {string} id
 * @returns {object|null}
 */
export async function getMetaFromR2(bucket, id) {
  const obj = await bucket.get(`${id}/meta.json`);
  if (!obj) return null;
  return obj.json();
}

/**
 * R2から画像をbase64で取得する。
 * @param {R2Bucket} bucket
 * @param {string} id
 * @returns {{ data: string, mimeType: string }|null}
 */
export async function getImageFromR2(bucket, id) {
  for (const ext of ["png", "jpg"]) {
    const obj = await bucket.get(`${id}/web.${ext}`);
    if (obj) {
      const buffer = await obj.arrayBuffer();
      const mimeType = obj.httpMetadata?.contentType ?? (ext === "jpg" ? "image/jpeg" : "image/png");
      return { data: uint8ArrayToBase64(new Uint8Array(buffer)), mimeType };
    }
  }
  return null;
}

/**
 * 7日以上前のidプレフィックスを列挙する。
 * @param {R2Bucket} bucket
 * @param {number} maxAgeDays
 * @returns {string[]}
 */
export async function listExpiredIds(bucket, maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expired = [];
  const seen = new Set();

  let cursor;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      // "bot/2026-03-28/meta.json" → "bot/2026-03-28"
      const parts = obj.key.split("/");
      if (parts.length < 2) continue;
      const id = `${parts[0]}/${parts[1]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (obj.uploaded.getTime() < cutoff) {
        expired.push(id);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return expired;
}

/**
 * R2から指定idのすべてのオブジェクトを削除する。
 * @param {R2Bucket} bucket
 * @param {string} id
 */
export async function deleteFromR2(bucket, id) {
  const listed = await bucket.list({ prefix: `${id}/` });
  const keys = listed.objects.map(o => o.key);
  if (keys.length > 0) {
    await bucket.delete(keys);
  }
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
