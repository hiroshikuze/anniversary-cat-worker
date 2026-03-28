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
 * クリエイター取り分（トリブン）= ベース価格 × 30%（切り捨て）
 * ベース価格は GET /api/v1/items の price フィールドより（2026-03確認済み）
 */
const PRICE_MARGIN_RATE = 0.30;
const SUZURI_BASE_PRICES = {
  "t-shirt":         1980,
  "sticker":         385,
  "can-badge":       385,
  "acrylic-keychain": 495,
};
const SUZURI_TORIBUN = Object.fromEntries(
  Object.entries(SUZURI_BASE_PRICES).map(([slug, base]) => [
    slug,
    Math.floor(base * PRICE_MARGIN_RATE),
  ])
);

/**
 * SUZURI APIから在庫のあるアイテムIDのセットを取得する。
 * fail-open: API失敗時は null を返し、呼び出し側は全アイテムを有効とみなす。
 */
async function fetchAvailableItemIds(env) {
  try {
    const res = await fetch(`${SUZURI_API_BASE}/items`, {
      headers: { "Authorization": `Bearer ${env.SUZURI_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items ?? [];
    // available フィールドが明示的に false のアイテムを除外（ない場合は有効とみなす）
    return new Set(items.filter(i => i.available !== false).map(i => i.id));
  } catch {
    return null; // fail-open
  }
}

/**
 * SUZURI商品を動的生成する。
 * 在庫確認後に有効な商品のみを作成し、在庫切れ商品は available: false で返す。
 *
 * @param {string} imageUrl - 商品に使用する画像URL（base64 data URIまたは公開URL）
 * @param {string} theme    - 記念日テーマ（マテリアルのタイトルに使用）
 * @param {object} env      - Cloudflare Workers の環境変数（SUZURI_API_KEY を含む）
 * @returns {{
 *   materialId: number,
 *   products: Array<{ slug: string, sampleUrl: string, previewImageUrl: string, available: boolean }>
 * }}
 * @throws {Error} APIキー未設定またはAPIエラー時
 */
export async function createSuzuriProducts(imageUrl, theme, env) {
  if (!env.SUZURI_API_KEY) {
    throw new Error("SUZURI_API_KEY が設定されていません");
  }

  // 在庫チェック（fail-open: 失敗時は全アイテムを対象）
  const availableIds = await fetchAvailableItemIds(env);
  console.log(`[suzuri] fetchAvailableItemIds result=${availableIds === null ? "null(fail-open)" : `Set(${[...availableIds].join(",")})`}`);

  // 在庫ありのアイテムのみで商品作成リストを生成
  const availableSlugs = new Set(
    Object.entries(SUZURI_ITEM_IDS)
      .filter(([, itemId]) => !availableIds || availableIds.has(itemId))
      .map(([slug]) => slug)
  );

  const productsToCreate = [...availableSlugs].map(slug => ({
    itemId:    SUZURI_ITEM_IDS[slug],
    price:     SUZURI_TORIBUN[slug],
    published: true,
  }));

  if (productsToCreate.length === 0) {
    throw new Error("SUZURI: 在庫のある商品がありません");
  }

  const res = await fetch(`${SUZURI_API_BASE}/materials`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SUZURI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      texture: imageUrl,
      title:   theme,
      products: productsToCreate,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`SUZURI商品生成失敗: status=${res.status} message=${data.message ?? JSON.stringify(data)}`);
  }

  // 作成された商品をitemIdでマップ化（name文字列は表記ゆれがあるためIDで照合）
  const createdMap = new Map(
    (data.products ?? []).map(p => [p.item?.id, p])
  );
  console.log(`[suzuri] POST /materials 完了 materialId=${data.material.id} products=[${[...createdMap.keys()].join(",")}]`);

  // 全4商品をavailableフラグ付きで返す（在庫切れはavailable: false）
  const allProducts = Object.keys(SUZURI_ITEM_IDS).map(slug => {
    const p = createdMap.get(SUZURI_ITEM_IDS[slug]);
    if (p) {
      return {
        slug,
        sampleUrl:       p.sampleUrl        ?? "",
        previewImageUrl: p.pngSampleImageUrl ?? p.sampleImageUrl ?? "",
        available:       true,
      };
    }
    // 在庫切れ等でスキップされたアイテム
    return { slug, sampleUrl: "", previewImageUrl: "", available: false };
  });

  return {
    materialId: data.material.id,
    products:   allProducts,
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
