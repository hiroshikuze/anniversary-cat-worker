/**
 * worker/suzuri.js - SUZURI API連携
 *
 * 画像URLを渡してSUZURI商品を動的生成し、商品ページURLを返す。
 *
 * 必要なシークレット（wrangler secret put で登録）:
 *   SUZURI_API_KEY  ... SUZURIのAPIキー（Developer Center で取得）
 */

const SUZURI_API_BASE = "https://suzuri.jp/api/v1";

function buildDescription(theme, description, r2Id, nowMs = Date.now()) {
  const toJst = ms => new Date(ms + 9 * 60 * 60 * 1000);

  const jstNow    = toJst(nowMs);
  const todayStr  = `${jstNow.getUTCMonth() + 1}月${jstNow.getUTCDate()}日`;

  const jstExpiry = toJst(nowMs + 14 * 24 * 60 * 60 * 1000);
  const expiryStr = `${jstExpiry.getUTCMonth() + 1}月${jstExpiry.getUTCDate()}日`;

  const url = r2Id
    ? `https://hiroshikuze.github.io/anniversary-cat-worker/?id=${r2Id}`
    : "https://hiroshikuze.github.io/anniversary-cat-worker/";

  const descBlock = description ? `\n\n${description}` : "";

  // "の日"を末尾から除去してテーマタグを生成（例: 大仏の日 → #大仏）
  const themeBase   = theme.endsWith("の日") ? theme.slice(0, -2) : theme;
  const themeTagRaw = themeBase.replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 30);
  const themeTag    = themeTagRaw ? ` #${themeTagRaw}` : "";

  return `${todayStr}の「${theme}」をテーマにしました。\n【期間限定！】${expiryStr}（日本時間）までの販売🐱${descBlock}\n\nにゃんバーサリー ${url}\n#AIイラスト #猫 #水彩画 #記念日 #にゃんバーサリー${themeTag}`;
}

export function _buildDescriptionForTest(theme, description, r2Id, nowMs) {
  return buildDescription(theme, description, r2Id, nowMs);
}

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
export const SUZURI_TORIBUN = Object.fromEntries(
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
 * @param {string} imageUrl      - 商品に使用する画像URL（base64 data URIまたは公開URL）
 * @param {string} theme         - 記念日テーマ（マテリアルのタイトルに使用）
 * @param {object} env           - Cloudflare Workers の環境変数（SUZURI_API_KEY を含む）
 * @param {string[]|null} slugFilter  - 登録対象スラッグの絞り込み（null = 全商品）
 * @param {string|null} backTexture   - Tシャツ背面印刷用画像（base64 data URI）。null = 背面印刷なし
 * @returns {{
 *   materialId: number,
 *   products: Array<{ slug: string, sampleUrl: string, previewImageUrl: string, available: boolean }>
 * }}
 * @throws {Error} APIキー未設定またはAPIエラー時
 */
export async function createSuzuriProducts(imageUrl, theme, env, slugFilter = null, backTexture = null, description = "", r2Id = null) {
  if (!env.SUZURI_API_KEY) {
    throw new Error("SUZURI_API_KEY が設定されていません");
  }

  // 対象スラッグを絞り込む（slugFilter 未指定時は全スラッグ）
  const targetSlugs = slugFilter
    ? Object.keys(SUZURI_ITEM_IDS).filter(s => slugFilter.includes(s))
    : Object.keys(SUZURI_ITEM_IDS);

  // 在庫チェック（fail-open: 失敗時は全アイテムを対象）
  const availableIds = await fetchAvailableItemIds(env);
  console.log(`[suzuri] fetchAvailableItemIds result=${availableIds === null ? "null(fail-open)" : `Set(${[...availableIds].join(",")})`}`);

  // 在庫ありのアイテムのみで商品作成リストを生成
  const availableSlugs = new Set(
    targetSlugs
      .filter(slug => !availableIds || availableIds.has(SUZURI_ITEM_IDS[slug]))
  );

  const productsToCreate = [...availableSlugs].map(slug => {
    const product = {
      itemId:     SUZURI_ITEM_IDS[slug],
      price:      SUZURI_TORIBUN[slug],
      published:  true,
      resizeMode: "contain",
    };
    // Tシャツのみ背面印刷を追加（backTexture が指定された場合）
    if (slug === "t-shirt" && backTexture) {
      product.sub_materials = [
        { texture: backTexture, printSide: "back", enabled: true },
      ];
    }
    return product;
  });

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
      texture:     imageUrl,
      title:       `${theme}と水彩画にゃんこ`,
      description: buildDescription(theme, description, r2Id),
      products:    productsToCreate,
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

  // 対象商品をavailableフラグ付きで返す（在庫切れはavailable: false）
  const allProducts = targetSlugs.map(slug => {
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
