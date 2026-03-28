/**
 * worker/suzuri.js - SUZURI API連携
 *
 * 画像URLを渡してSUZURI商品を動的生成し、商品ページURLを返す。
 *
 * 必要なシークレット（wrangler secret put で登録）:
 *   SUZURI_API_KEY  ... SUZURIのAPIキー（Developer Center で取得）
 */

const SUZURI_API_BASE = "https://suzuri.jp/api/v1";

/**
 * 対象商品のitemId一覧（2026-03 GET /api/v1/items で確認済み）
 * name はAPIが返す英語スラッグ
 */
export const SUZURI_ITEM_IDS = {
  "t-shirt":         1,
  "sticker":         11,
  "can-badge":       17,
  "acrylic-keychain": 147,
};

/**
 * SUZURI商品を動的生成する。
 * 4商品（Tシャツ・ステッカー・缶バッジ・アクリルキーホルダー）を一括生成する。
 *
 * @param {string} imageUrl - 商品に使用する画像のURL（R2の公開URL）
 * @param {string} theme    - 記念日テーマ（マテリアルのタイトルに使用）
 * @param {object} env      - Cloudflare Workers の環境変数（SUZURI_API_KEY を含む）
 * @returns {{ materialId: number, products: Array<{ slug: string, sampleUrl: string, previewImageUrl: string }> }}
 * @throws {Error} APIキー未設定またはAPIエラー時
 */
export async function createSuzuriProducts(imageUrl, theme, env) {
  if (!env.SUZURI_API_KEY) {
    throw new Error("SUZURI_API_KEY が設定されていません");
  }

  const products = Object.entries(SUZURI_ITEM_IDS).map(([, itemId]) => ({
    itemId,
    published: true,
  }));

  const res = await fetch(`${SUZURI_API_BASE}/materials`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUZURI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      texture: imageUrl,
      title: theme,
      products,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`SUZURI商品生成失敗: status=${res.status} message=${data.message ?? JSON.stringify(data)}`);
  }

  return {
    materialId: data.material.id,
    products: (data.products ?? []).map(p => ({
      slug:            p.item?.name ?? "",
      sampleUrl:       p.sampleUrl ?? "",
      previewImageUrl: p.pngSampleImageUrl ?? p.sampleImageUrl ?? "",
    })),
  };
}

/**
 * SUZURIマテリアルを削除する。
 * 7日経過した古い商品のクリーンアップや、テスト後の削除に使用する。
 *
 * @param {number} materialId - 削除するマテリアルID
 * @param {object} env        - Cloudflare Workers の環境変数（SUZURI_API_KEY を含む）
 * @throws {Error} APIエラー時
 */
export async function deleteSuzuriMaterial(materialId, env) {
  const res = await fetch(`${SUZURI_API_BASE}/materials/${materialId}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${env.SUZURI_API_KEY}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`SUZURIマテリアル削除失敗: status=${res.status} id=${materialId} message=${data.message ?? ""}`);
  }
}
