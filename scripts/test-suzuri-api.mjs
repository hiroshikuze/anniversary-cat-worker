#!/usr/bin/env node
/**
 * test-suzuri-api.mjs - SUZURI API 動作確認スクリプト
 *
 * 実行前に環境変数を設定すること:
 *   export SUZURI_API_KEY=<SUZURIのAPIキー>
 *
 * アイテム一覧のみ確認（商品は作成しない）:
 *   node scripts/test-suzuri-api.mjs
 *
 * 実際に商品を作成して構造を確認:
 *   node scripts/test-suzuri-api.mjs --create
 *
 * 注意: --create オプションを付けると実際にSUZURIに商品が作成される。
 *       確認後はSUZURIの管理画面から手動削除すること。
 */

const SUZURI_API_BASE = "https://suzuri.jp/api/v1";
const API_KEY = process.env.SUZURI_API_KEY;
const DO_CREATE = process.argv.includes("--create");

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
// Step 1: アイテム一覧取得（available フィールドの実態を確認）
// ---------------------------------------------------------------------------
console.log("\n[Step 1] GET /api/v1/items - 利用可能なアイテム一覧");

const itemsRes = await fetch(`${SUZURI_API_BASE}/items`, { headers });
if (!itemsRes.ok) {
  const text = await itemsRes.text();
  console.error(`❌ アイテム一覧取得失敗: ${itemsRes.status} ${text}`);
  process.exit(1);
}

const itemsData = await itemsRes.json();

// レスポンス構造を防御的に扱う（配列直接返しと {items:[...]} 形式の両方に対応）
const items = Array.isArray(itemsData) ? itemsData : (itemsData.items ?? []);
if (items.length === 0) {
  console.error("❌ アイテム一覧が空または予期しない形式です");
  console.error("レスポンス先頭:", JSON.stringify(itemsData).slice(0, 500));
  process.exit(1);
}

console.log(`✅ ${items.length}件のアイテムを取得`);

// suzuri.js が参照している SUZURI_ITEM_IDS と同じ定義
const SUZURI_ITEM_IDS = {
  "t-shirt":          1,
  "sticker":          11,
  "can-badge":        17,
  "acrylic-keychain": 147,
};

console.log("\n--- 対象itemIdのアイテム情報（suzuri.jsが参照する4種） ---");
for (const [slug, targetId] of Object.entries(SUZURI_ITEM_IDS)) {
  // idは整数比較・文字列比較の両方で探す
  const found = items.find(i => i.id === targetId || String(i.id) === String(targetId));
  if (found) {
    console.log(`  slug="${slug}" id=${found.id} (型:${typeof found.id}) name="${found.name}" available=${found.available} (型:${typeof found.available})`);
  } else {
    console.warn(`  ⚠️  slug="${slug}" targetId=${targetId} → APIレスポンスに見つからない`);
  }
}

console.log("\n--- 全アイテムのidとname（先頭20件） ---");
for (const item of items.slice(0, 20)) {
  console.log(`  id=${item.id} (型:${typeof item.id})  name="${item.name}"  available=${item.available}`);
}
if (items.length > 20) {
  console.log(`  ... 他 ${items.length - 20} 件`);
}

// ---------------------------------------------------------------------------
// Step 2: テスト商品生成（POST /api/v1/materials）
// --create フラグがない場合はここで終了
// ---------------------------------------------------------------------------
if (!DO_CREATE) {
  console.log("\n💡 商品を実際に作成して構造を確認するには --create オプションを付けて実行してください:");
  console.log("   node scripts/test-suzuri-api.mjs --create");
  process.exit(0);
}

console.log("\n[Step 2] POST /api/v1/materials - テスト商品生成");
console.log("⚠️  実際にSUZURIに商品が作成されます。確認後は手動削除してください。");

// テスト用画像（公開済みの画像URL）
const TEST_IMAGE_URL = "https://hiroshikuze.github.io/anniversary-cat-worker/icon-192.png";
const TEST_TITLE = "テスト商品（削除してください）";

// t-shirt (itemId=1) でテスト
const materialsPayload = {
  texture:  TEST_IMAGE_URL,
  title:    TEST_TITLE,  // 必須フィールド
  products: [
    { itemId: 1, published: false },  // 非公開で作成（公開しないよう注意）
  ],
};

console.log("  payload:", JSON.stringify(materialsPayload, null, 2));

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

console.log("✅ 商品生成成功");

// レスポンス構造を詳細に確認
console.log("\n--- レスポンス構造の診断 ---");
console.log(`  response.material:          ${JSON.stringify(materialsData.material)?.slice(0, 100)}`);
console.log(`  response.products:          ${JSON.stringify(materialsData.products)?.slice(0, 200)}`);
console.log(`  response.material.products: ${JSON.stringify(materialsData.material?.products)?.slice(0, 200)}`);

if (Array.isArray(materialsData.products)) {
  console.log("\n✅ products はトップレベル（suzuri.js の data.products で正しくアクセスできる）");
  for (const p of materialsData.products) {
    console.log(`  item.id=${p.item?.id} (型:${typeof p.item?.id})  item.name="${p.item?.name}"  sampleUrl=${p.sampleUrl}`);
  }
} else if (Array.isArray(materialsData.material?.products)) {
  console.log("\n⚠️  products は material の下にネストされている（suzuri.js のアクセスパスが間違っている）");
  for (const p of materialsData.material.products) {
    console.log(`  item.id=${p.item?.id} (型:${typeof p.item?.id})  item.name="${p.item?.name}"  sampleUrl=${p.sampleUrl}`);
  }
} else {
  console.warn("\n❌ products がどこにも見当たらない");
}

console.log("\n--- レスポンス全体 ---");
console.log(JSON.stringify(materialsData, null, 2));
