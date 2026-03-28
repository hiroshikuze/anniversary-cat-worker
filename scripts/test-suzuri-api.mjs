#!/usr/bin/env node
/**
 * test-suzuri-api.mjs - SUZURI API 動作確認スクリプト
 *
 * 実行前に環境変数を設定すること:
 *   export SUZURI_API_KEY=<SUZURIのAPIキー>
 *
 * 実行:
 *   node scripts/test-suzuri-api.mjs
 *
 * 確認内容:
 *   1. GET /api/v1/items       ... 利用可能なアイテム一覧（itemIdの確認）
 *   2. POST /api/v1/materials  ... テスト画像で商品を動的生成
 *   3. 生成された商品ページURL（sampleUrl）を表示
 *
 * 注意: Step 2 を実行すると実際にSUZURIに商品が作成される。
 *       確認後はSUZURIの管理画面から手動削除すること。
 */

const SUZURI_API_BASE = "https://suzuri.jp/api/v1";
const API_KEY = process.env.SUZURI_API_KEY;

if (!API_KEY) {
  console.error("❌ SUZURI_API_KEY が設定されていません");
  console.error("   export SUZURI_API_KEY=<APIキー> を実行してから再度試してください");
  process.exit(1);
}

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Step 1: アイテム一覧取得（itemId確認）
// ---------------------------------------------------------------------------
console.log("\n[Step 1] GET /api/v1/items - 利用可能なアイテム一覧");

const itemsRes = await fetch(`${SUZURI_API_BASE}/items`, { headers });
if (!itemsRes.ok) {
  const text = await itemsRes.text();
  console.error(`❌ アイテム一覧取得失敗: ${itemsRes.status} ${text}`);
  process.exit(1);
}

const { items } = await itemsRes.json();
console.log(`✅ ${items.length}件のアイテムを取得`);

// 対象商品のitemIdを探す
const TARGET_NAMES = ["スタンダードTシャツ", "ステッカー", "缶バッジ", "アクリルキーホルダー"];
const targetItems = items.filter(item =>
  TARGET_NAMES.some(name => item.name?.includes(name))
);

console.log("\n--- 対象商品のitemId ---");
for (const item of targetItems) {
  console.log(`  itemId=${item.id}  name="${item.name}"`);
}

console.log("\n--- 全アイテム一覧 ---");
for (const item of items) {
  console.log(`  itemId=${item.id}  name="${item.name}"`);
}

// ---------------------------------------------------------------------------
// Step 2: テスト商品生成（POST /api/v1/materials）
// ---------------------------------------------------------------------------
console.log("\n[Step 2] POST /api/v1/materials - テスト商品生成");
console.log("⚠️  実際にSUZURIに商品が作成されます。確認後は手動削除してください。");

// テスト用画像（公開済みの小さな画像URL）
// 本番では R2 の公開URLを使用する予定
const TEST_IMAGE_URL = "https://hiroshikuze.github.io/anniversary-cat-worker/icon-192.png";

// Step 1 で取得したitemIdを使う（fallback: スタンダードTシャツ=1）
const tshirtItem = targetItems.find(i => i.name?.includes("スタンダードTシャツ")) ?? { id: 1 };

const materialsPayload = {
  texture: TEST_IMAGE_URL,
  products: [
    {
      itemId: tshirtItem.id,
      publishingStrategy: "anyone",
    },
  ],
};

console.log(`  itemId: ${tshirtItem.id}`);
console.log(`  texture: ${TEST_IMAGE_URL}`);

const materialsRes = await fetch(`${SUZURI_API_BASE}/materials`, {
  method: "POST",
  headers,
  body: JSON.stringify(materialsPayload),
});

const materialsData = await materialsRes.json();

if (!materialsRes.ok) {
  console.error(`❌ 商品生成失敗: ${materialsRes.status}`);
  console.error(JSON.stringify(materialsData, null, 2));
  process.exit(1);
}

console.log(`✅ 商品生成成功`);
console.log("\n--- レスポンス（抜粋） ---");
console.log(`  material.id:  ${materialsData.material?.id}`);
console.log(`  material.sampleUrl: ${materialsData.material?.sampleUrl}`);

if (materialsData.material?.products?.length > 0) {
  console.log("\n--- 生成された商品 ---");
  for (const product of materialsData.material.products) {
    console.log(`  productId=${product.id}  itemId=${product.item?.id}  url=${product.sampleUrl ?? "(なし)"}`);
  }
}

console.log("\n--- レスポンス全体 ---");
console.log(JSON.stringify(materialsData, null, 2));
