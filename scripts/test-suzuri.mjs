#!/usr/bin/env node
/**
 * test-suzuri.mjs - worker/suzuri.js ユニットテスト
 *
 * 外部API（SUZURI）への接続は不要（globalThis.fetchをモック）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-suzuri.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import {
  createSuzuriProducts,
  deleteSuzuriMaterial,
  SUZURI_ITEM_IDS,
} from "../worker/suzuri.js";

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

async function assertThrows(label, fn) {
  try {
    await fn();
    console.error(`  ❌ ${label} (例外が投げられなかった)`);
    failed++;
  } catch {
    console.log(`  ✅ ${label}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// SUZURI_ITEM_IDS 定数
// ---------------------------------------------------------------------------
console.log("\n[SUZURI_ITEM_IDS]");
{
  assert("t-shirt が 1", SUZURI_ITEM_IDS["t-shirt"] === 1);
  assert("sticker が 11", SUZURI_ITEM_IDS["sticker"] === 11);
  assert("can-badge が 17", SUZURI_ITEM_IDS["can-badge"] === 17);
  assert("acrylic-keychain が 147", SUZURI_ITEM_IDS["acrylic-keychain"] === 147);
}

// ---------------------------------------------------------------------------
// createSuzuriProducts - 正常系
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts: 正常系]");
{
  const mockResponse = {
    material: {
      id: 12345,
      title: "テスト記念日",
    },
    products: [
      { item: { id: 1,   name: "t-shirt"          }, sampleUrl: "https://suzuri.jp/nyanmusu/12345/t-shirt/s/white",           sampleImageUrl: "https://img.suzuri.jp/1.webp",   pngSampleImageUrl: "https://img.suzuri.jp/1.png" },
      { item: { id: 11,  name: "sticker"           }, sampleUrl: "https://suzuri.jp/nyanmusu/12345/sticker/s/white",           sampleImageUrl: "https://img.suzuri.jp/2.webp",   pngSampleImageUrl: "https://img.suzuri.jp/2.png" },
      { item: { id: 17,  name: "can-badge"         }, sampleUrl: "https://suzuri.jp/nyanmusu/12345/can-badge/s/white",         sampleImageUrl: "https://img.suzuri.jp/3.webp",   pngSampleImageUrl: "https://img.suzuri.jp/3.png" },
      { item: { id: 147, name: "acrylic-keychain"  }, sampleUrl: "https://suzuri.jp/nyanmusu/12345/acrylic-keychain/s/white",  sampleImageUrl: "https://img.suzuri.jp/4.webp",   pngSampleImageUrl: "https://img.suzuri.jp/4.png" },
    ],
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert("POSTエンドポイントが正しい", url.includes("/api/v1/materials"));
    assert("Authorizationヘッダーが付いている", options.headers?.["Authorization"] === "Bearer test-key");
    const body = JSON.parse(options.body);
    assert("textureが渡される", body.texture === "https://example.com/image.png");
    assert("products が4件", body.products?.length === 4);
    assert("t-shirt(itemId=1)が含まれる", body.products.some(p => p.itemId === 1));
    assert("sticker(itemId=11)が含まれる", body.products.some(p => p.itemId === 11));
    assert("can-badge(itemId=17)が含まれる", body.products.some(p => p.itemId === 17));
    assert("acrylic-keychain(itemId=147)が含まれる", body.products.some(p => p.itemId === 147));
    return { ok: true, json: async () => mockResponse };
  };

  const result = await createSuzuriProducts(
    "https://example.com/image.png",
    "テスト記念日",
    { SUZURI_API_KEY: "test-key" }
  );

  globalThis.fetch = origFetch;

  assert("materialId が返る", result.materialId === 12345);
  assert("products が4件返る", result.products.length === 4);
  assert("t-shirt の sampleUrl が含まれる", result.products.some(p => p.slug === "t-shirt" && p.sampleUrl.includes("t-shirt")));
  assert("sticker の sampleUrl が含まれる", result.products.some(p => p.slug === "sticker"));
  assert("can-badge の sampleUrl が含まれる", result.products.some(p => p.slug === "can-badge"));
  assert("acrylic-keychain の sampleUrl が含まれる", result.products.some(p => p.slug === "acrylic-keychain"));
  assert("previewImageUrl が含まれる", result.products[0].previewImageUrl?.startsWith("https://"));
}

// ---------------------------------------------------------------------------
// createSuzuriProducts - SUZURI_API_KEY 未設定時は例外
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts: API key未設定]");
{
  await assertThrows(
    "SUZURI_API_KEY 未設定時は例外を投げる",
    () => createSuzuriProducts("https://example.com/image.png", "テスト", { SUZURI_API_KEY: "" })
  );
}

// ---------------------------------------------------------------------------
// createSuzuriProducts - APIエラー時は例外
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts: APIエラー]");
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ message: "Validation failed" }),
  });

  await assertThrows(
    "API 422エラー時は例外を投げる",
    () => createSuzuriProducts("https://example.com/image.png", "テスト", { SUZURI_API_KEY: "test-key" })
  );

  globalThis.fetch = origFetch;
}

// ---------------------------------------------------------------------------
// deleteSuzuriMaterial - 正常系
// ---------------------------------------------------------------------------
console.log("\n[deleteSuzuriMaterial: 正常系]");
{
  let calledUrl = "";
  let calledMethod = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    calledMethod = options.method;
    return { ok: true, json: async () => ({}) };
  };

  await deleteSuzuriMaterial(12345, { SUZURI_API_KEY: "test-key" });

  globalThis.fetch = origFetch;

  assert("DELETEメソッドが使われる", calledMethod === "DELETE");
  assert("URLにmaterialIdが含まれる", calledUrl.includes("/12345"));
}

// ---------------------------------------------------------------------------
// deleteSuzuriMaterial - APIエラー時は例外
// ---------------------------------------------------------------------------
console.log("\n[deleteSuzuriMaterial: APIエラー]");
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ message: "Not found" }),
  });

  await assertThrows(
    "DELETE 404エラー時は例外を投げる",
    () => deleteSuzuriMaterial(99999, { SUZURI_API_KEY: "test-key" })
  );

  globalThis.fetch = origFetch;
}

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed}件中 ${passed}件成功、${failed}件失敗`);
if (failed > 0) process.exit(1);
