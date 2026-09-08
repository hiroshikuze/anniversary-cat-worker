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
 * @param {{ theme: string, description: string, sourceUrl: string, materialIds: number[], products: Array, createdAt: string }} meta
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
      // Bug#32: /image/:id はレート制限がなく高頻度に呼ばれうるため、KV集計（1日1,000回書き込み上限）
      // は行わずconsole.logのみに留める（architecture.mdの「CPU時間のステップ別記録」参照）
      const tCpuStart = performance.now();
      const data = uint8ArrayToBase64(new Uint8Array(buffer));
      console.log(`[cpu] getImageFromR2-base64Encode: ${(performance.now() - tCpuStart).toFixed(1)}ms`);
      return { data, mimeType };
    }
  }
  return null;
}

/**
 * 14日以上前のidプレフィックスを列挙する。
 * @param {R2Bucket} bucket
 * @param {number} maxAgeDays
 * @returns {string[]}
 */
export async function listExpiredIds(bucket, maxAgeDays = 14) {
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

/**
 * R2のメタデータを部分更新する。画像は変更せずmeta.jsonのみ上書きする。
 * products フィールドはスラッグ単位でマージ（上書きではなくupsert）する。
 * materialIds フィールドは重複排除しつつ蓄積する。
 * 複数グループ（right/center）・`/resume-hires`が別々のタイミングで更新しても
 * 全商品・全マテリアルIDが保持される。
 *
 * R2の条件付きPUT（`onlyIf: { etagMatches }`）による楽観的並行性制御+有界リトライで
 * 書き込みを排他する（Bug#34）。以前はget→JSでマージ→putの非アトミック実装だったため、
 * 複数の呼び出し元が競合すると後勝ちが先勝ちの結果を黙って上書きするロストアップデートが
 * 発生し、実際に本番でmaterialIdがmeta.jsonから消失しSUZURI商品の多重登録を招いた。
 * `onlyIf.etagMatches`にはhttpEtag（クォート付き文字列）を渡す。理由は
 * `.claude/bugs-history.md`のBug#34参照（実行検証はできておらず、公式ドキュメント＋
 * Miniflare参照実装ソースの読解による判断）。
 *
 * リトライ対象は`put()`が`null`を返すCAS競合のみ。`get()`/`put()`が例外を投げる
 * 本物のネットワークエラー等はリトライせずそのままthrowする。
 *
 * `get()`が`null`を返す（id自体が存在しない）場合は即return。このコードベースの
 * 呼び出し経路ではmeta.jsonは`/suzuri-create`到達前（`/generate`成功時のsaveToR2()）に
 * 必ず作成済みのため、この分岐は実質的に「真に存在しないid」のみを意味する
 * （＝新規作成との競合は想定しなくてよい）。
 *
 * @param {R2Bucket} bucket
 * @param {string} id
 * @param {object} updates - 既存メタに上書きするフィールド
 * @param {number} maxRetries - CAS競合時の最大リトライ回数
 */
export async function updateMetaInR2(bucket, id, updates, maxRetries = 5) {
  const key = `${id}/meta.json`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const obj = await bucket.get(key);
    if (!obj) return;
    const existing = await obj.json();
    let merged = { ...existing, ...updates };
    if (updates.products) {
      const map = new Map((existing.products ?? []).map(p => [p.slug, p]));
      for (const p of updates.products) map.set(p.slug, p);
      merged.products = [...map.values()];
    }
    if (updates.materialIds) {
      const set = new Set(existing.materialIds ?? []);
      for (const materialId of updates.materialIds) set.add(materialId);
      merged.materialIds = [...set];
    }
    const result = await bucket.put(key, JSON.stringify(merged), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: obj.httpEtag },
    });
    if (result !== null) return;
    if (attempt > 0) {
      // 初回の衝突は即リトライ（まれ・解消が速いため）。2回目以降のみ短いジッター付き待機を挟む。
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 30));
    }
    console.warn(`[updateMetaInR2] etag競合のためリトライ id=${id} attempt=${attempt + 1}`);
  }
  throw new Error(`[updateMetaInR2] ${maxRetries}回リトライしても書き込めませんでした id=${id}`);
}

/**
 * R2メタからSUZURIマテリアルIDの配列を読み出す。
 * 新スキーマ（materialIds配列）と旧スキーマ（単数materialId）の両方に対応する。
 * @param {object} meta
 * @returns {number[]}
 */
export function collectMaterialIds(meta) {
  if (Array.isArray(meta?.materialIds)) return meta.materialIds;
  if (meta?.materialId) return [meta.materialId];
  return [];
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
