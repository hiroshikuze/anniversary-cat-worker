#!/usr/bin/env node
/**
 * test-bot.mjs - bluesky-bot.js ユニットテスト
 *
 * 外部API（Bluesky・Gemini・Discord）への接続は不要。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-bot.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import { updateMetaInR2 } from "../worker/r2-storage.js";
import { createSuzuriProducts, SUZURI_ITEM_IDS } from "../worker/suzuri.js";

import {
  buildPostText, buildHashtagFacets, buildUrlFacets, notifyDiscord, runBot,
  shrinkImageIfNeeded, _setPhotonForTest, BLUESKY_MAX_IMAGE_BYTES,
} from "../worker/bluesky-bot.js";

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

// ---------------------------------------------------------------------------
// buildPostText
// ---------------------------------------------------------------------------
console.log("\n[buildPostText]");
{
  const text = buildPostText("ねこの日", "猫を愛でる記念日です");

  assert("theme が含まれる", text.includes("ねこの日"));
  assert("description が含まれる", text.includes("猫を愛でる記念日です"));
  assert("サイトURLが含まれる", text.includes("hiroshikuze.github.io/anniversary-cat-worker/"));
  assert("ハッシュタグ #cat が含まれる", text.includes("#cat"));
  assert("ハッシュタグ #猫 が含まれる", text.includes("#猫"));

  // Bluesky の上限は 300 grapheme
  const graphemes = [...new Intl.Segmenter().segment(text)];
  assert(`300 grapheme以内 (実測: ${graphemes.length})`, graphemes.length <= 300);
}

// description が空のケース
{
  const text = buildPostText("記念日テスト", "");
  assert("description 空でもクラッシュしない", typeof text === "string" && text.length > 0);
  assert("description 空でもサイトURLが含まれる", text.includes("hiroshikuze.github.io"));
}

// ---------------------------------------------------------------------------
// buildHashtagFacets
// ---------------------------------------------------------------------------
console.log("\n[buildHashtagFacets]");
{
  const text = buildPostText("テスト", "説明文");
  const facets = buildHashtagFacets(text);
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  assert("facets の件数が5件（#AIart #cat #kitten #ほのぼの #猫）", facets.length === 5);

  for (const facet of facets) {
    const { byteStart, byteEnd } = facet.index;
    const tag = "#" + facet.features[0].tag;
    const extracted = new TextDecoder().decode(textBytes.slice(byteStart, byteEnd));
    assert(`"${tag}" のバイト位置が正確`, extracted === tag);
  }

  // facets の $type が正しいか
  for (const facet of facets) {
    assert(
      `"#${facet.features[0].tag}" の $type が正しい`,
      facet.features[0].$type === "app.bsky.richtext.facet#tag"
    );
  }
}

// ---------------------------------------------------------------------------
// buildUrlFacets
// ---------------------------------------------------------------------------
console.log("\n[buildUrlFacets]");
{
  const text = buildPostText("テスト", "説明文");
  const facets = buildUrlFacets(text);
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  assert("facets の件数が1件（SITE_URL）", facets.length === 1);

  const { byteStart, byteEnd } = facets[0].index;
  const extracted = new TextDecoder().decode(textBytes.slice(byteStart, byteEnd));
  assert("SITE_URL のバイト位置が正確", extracted === "https://hiroshikuze.github.io/anniversary-cat-worker/");
  assert("$type が app.bsky.richtext.facet#link", facets[0].features[0].$type === "app.bsky.richtext.facet#link");
  assert("uri が SITE_URL と一致", facets[0].features[0].uri === "https://hiroshikuze.github.io/anniversary-cat-worker/");
}

// ---------------------------------------------------------------------------
// buildPostText - カスタム pageUrl
// ---------------------------------------------------------------------------
console.log("\n[buildPostText: カスタムpageUrl]");
{
  const customUrl = "https://hiroshikuze.github.io/anniversary-cat-worker/?id=bot/2026-03-28";
  const text = buildPostText("ねこの日", "猫を愛でる記念日です", customUrl);
  assert("カスタムURLが含まれる", text.includes(customUrl));
  assert("デフォルトSITE_URLは含まれない", !text.includes("hiroshikuze.github.io/anniversary-cat-worker/\n"));

  const graphemes = [...new Intl.Segmenter().segment(text)];
  assert(`300 grapheme以内（カスタムURL、実測: ${graphemes.length}）`, graphemes.length <= 300);
}

// ---------------------------------------------------------------------------
// buildUrlFacets - カスタム url
// ---------------------------------------------------------------------------
console.log("\n[buildUrlFacets: カスタムurl]");
{
  const customUrl = "https://hiroshikuze.github.io/anniversary-cat-worker/?id=bot/2026-03-28";
  const text = buildPostText("テスト", "説明文", customUrl);
  const facets = buildUrlFacets(text, customUrl);
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  assert("facets の件数が1件（カスタムURL）", facets.length === 1);
  const { byteStart, byteEnd } = facets[0].index;
  const extracted = new TextDecoder().decode(textBytes.slice(byteStart, byteEnd));
  assert("カスタムURLのバイト位置が正確", extracted === customUrl);
  assert("uri がカスタムURLと一致", facets[0].features[0].uri === customUrl);
  assert("$type が app.bsky.richtext.facet#link", facets[0].features[0].$type === "app.bsky.richtext.facet#link");
}

// ---------------------------------------------------------------------------
// runBot - GEMINI_API_KEY 未設定時は早期終了（handleResearch を呼ばない）
// ---------------------------------------------------------------------------
console.log("\n[runBot: GEMINI_API_KEY 未設定]");
{
  let researchCalled = false;
  const mockResearch = async () => { researchCalled = true; };
  const mockGenerate = async () => {};

  await runBot({ GEMINI_API_KEY: "", DISCORD_WEBHOOK_URL: "" }, mockResearch, mockGenerate);

  assert("GEMINI_API_KEY 未設定時は handleResearch を呼ばない", !researchCalled);
}

// ---------------------------------------------------------------------------
// runBot - handleResearch / handleGenerate が正しい引数で呼ばれるか
// ---------------------------------------------------------------------------
console.log("\n[runBot: 正常フロー（Bluesky認証は失敗してよい）]");
{
  let researchBody;
  let researchApiKey;
  let generateBody;
  let generateApiKey;

  const mockResearch = async (body, apiKey) => {
    researchBody   = body;
    researchApiKey = apiKey;
    return { theme: "テスト記念日", description: "テスト説明文", sourceUrl: "https://example.com" };
  };

  const mockGenerate = async (body, apiKey) => {
    generateBody   = body;
    generateApiKey = apiKey;
    return { imageData: btoa("fake-image-data"), mimeType: "image/png", source: "gemini" };
  };

  const env = {
    GEMINI_API_KEY:       "test-gemini-key",
    BLUESKY_IDENTIFIER:   "",   // 意図的に空（Bluesky認証はエラーになるが runBot が握りつぶす）
    BLUESKY_APP_PASSWORD: "",
    DISCORD_WEBHOOK_URL:  "",
  };

  await runBot(env, mockResearch, mockGenerate);

  assert("handleResearch に date が渡される", researchBody?.date !== undefined);
  assert("handleResearch の date が日本語形式（年月日）", /\d{4}年\d{1,2}月\d{1,2}日/.test(researchBody?.date ?? ""));
  assert("handleResearch に GEMINI_API_KEY が渡される", researchApiKey === "test-gemini-key");
  assert("handleGenerate に research.theme が渡される", generateBody?.theme === "テスト記念日");
  assert("handleGenerate に research.description が渡される", generateBody?.description === "テスト説明文");
  assert("handleGenerate に GEMINI_API_KEY が渡される", generateApiKey === "test-gemini-key");
}

// ---------------------------------------------------------------------------
// runBot - handleResearch 失敗時は handleGenerate を呼ばない
// ---------------------------------------------------------------------------
console.log("\n[runBot: research 失敗時]");
{
  let generateCalled = false;

  const mockResearch = async () => {
    throw new Error("research 失敗テスト");
  };
  const mockGenerate = async () => { generateCalled = true; };

  await runBot(
    { GEMINI_API_KEY: "test-key", DISCORD_WEBHOOK_URL: "" },
    mockResearch,
    mockGenerate
  );

  assert("handleResearch 失敗時は handleGenerate を呼ばない", !generateCalled);
}

// ---------------------------------------------------------------------------
// notifyDiscord - DISCORD_WEBHOOK_URL が空でもクラッシュしない
// ---------------------------------------------------------------------------
console.log("\n[notifyDiscord]");
{
  let threw = false;
  try {
    await notifyDiscord("", "テストメッセージ");
  } catch {
    threw = true;
  }
  assert("DISCORD_WEBHOOK_URL 空でもクラッシュしない", !threw);
}

// ---------------------------------------------------------------------------
// shrinkImageIfNeeded
// ---------------------------------------------------------------------------
console.log("\n[shrinkImageIfNeeded]");

/**
 * テスト用: base64文字列をデコードしたときにbyteCountバイトになるbase64を生成。
 * Node.js の Buffer を使用（テスト環境専用）。
 */
function makeBase64(byteCount) {
  return Buffer.alloc(byteCount).toString("base64");
}

/**
 * テスト用: fetchのモック。pollinationsへのリクエストに対して
 * fakeBytes の ArrayBuffer を返す偽レスポンスを返す。
 */
function mockFetch(fakeBytes) {
  return async (url) => {
    if (!url.includes("pollinations.ai")) throw new Error(`想定外のfetch: ${url}`);
    return {
      ok:           true,
      arrayBuffer:  async () => fakeBytes.buffer,
      headers:      { get: (h) => h === "Content-Type" ? "image/jpeg" : null },
    };
  };
}

/**
 * テスト用: PhotonImageのモック。
 * quality=70 → jpeg70Bytes、quality=40 → jpeg40Bytes を返すインスタンスを生成する。
 */
function mockPhotonImage(jpeg70Bytes, jpeg40Bytes) {
  return {
    new_from_byteslice: () => ({
      get_bytes_jpeg: (quality) => quality === 70 ? jpeg70Bytes : jpeg40Bytes,
      free:           () => {},
    }),
  };
}

{
  // ── サイズ内の画像はそのまま返る ──────────────────────────────────────
  _setPhotonForTest(null); // Photonを未初期化状態に戻す
  const imageData = makeBase64(100); // 100バイト（上限976KBよりはるかに小）
  const result    = await shrinkImageIfNeeded(imageData, "image/png", "テーマ", "説明");
  assert("上限内の画像: imageDataが変わらない",   result.imageData === imageData);
  assert("上限内の画像: mimeTypeが変わらない",    result.mimeType  === "image/png");
}

{
  // ── Photon quality=70 で圧縮成功 ─────────────────────────────────────
  const jpeg70 = new Uint8Array(100_000); // 100KB（上限内）
  _setPhotonForTest(mockPhotonImage(jpeg70, null));
  const result = await shrinkImageIfNeeded(
    makeBase64(BLUESKY_MAX_IMAGE_BYTES + 1), "image/png", "テーマ", "説明"
  );
  assert("quality=70成功: mimeTypeがimage/jpeg", result.mimeType === "image/jpeg");
  assert("quality=70成功: 上限以内のサイズ",
    Buffer.from(result.imageData, "base64").length <= BLUESKY_MAX_IMAGE_BYTES);
}

{
  // ── quality=70が大きすぎて quality=40 で成功 ──────────────────────────
  const jpeg70 = new Uint8Array(BLUESKY_MAX_IMAGE_BYTES + 1); // 上限超過
  const jpeg40 = new Uint8Array(100_000);                      // 100KB（上限内）
  _setPhotonForTest(mockPhotonImage(jpeg70, jpeg40));
  const result = await shrinkImageIfNeeded(
    makeBase64(BLUESKY_MAX_IMAGE_BYTES + 1), "image/png", "テーマ", "説明"
  );
  assert("quality=40成功: mimeTypeがimage/jpeg", result.mimeType === "image/jpeg");
  assert("quality=40成功: 上限以内のサイズ",
    Buffer.from(result.imageData, "base64").length <= BLUESKY_MAX_IMAGE_BYTES);
}

{
  // ── quality=40も超過 → Pollinationsフォールバック ─────────────────────
  const tooBig  = new Uint8Array(BLUESKY_MAX_IMAGE_BYTES + 1); // 両qualityとも超過
  const pollImg = new Uint8Array([0xff, 0xd8, 0xff]); // 3バイトの偽jpeg
  _setPhotonForTest(mockPhotonImage(tooBig, tooBig));
  const origFetch    = globalThis.fetch;
  globalThis.fetch   = mockFetch(pollImg);
  const result       = await shrinkImageIfNeeded(
    makeBase64(BLUESKY_MAX_IMAGE_BYTES + 1), "image/png", "テーマ", "説明"
  );
  globalThis.fetch   = origFetch;
  _setPhotonForTest(null);
  assert("quality=40超過: Pollinationsフォールバックが呼ばれる", result.mimeType === "image/jpeg");
  assert("quality=40超過: Pollinationsの画像データが返る",
    Buffer.from(result.imageData, "base64").length === pollImg.length);
}

{
  // ── Photon例外 → Pollinationsフォールバック ───────────────────────────
  const throwingPhoton = {
    new_from_byteslice: () => { throw new Error("WASMクラッシュ"); },
  };
  const pollImg = new Uint8Array([0xff, 0xd8, 0xff]);
  _setPhotonForTest(throwingPhoton);
  const origFetch    = globalThis.fetch;
  globalThis.fetch   = mockFetch(pollImg);
  const result       = await shrinkImageIfNeeded(
    makeBase64(BLUESKY_MAX_IMAGE_BYTES + 1), "image/png", "テーマ", "説明"
  );
  globalThis.fetch   = origFetch;
  _setPhotonForTest(null);
  assert("Photon例外: Pollinationsフォールバックが呼ばれる", result.mimeType === "image/jpeg");
  assert("Photon例外: Pollinationsの画像データが返る",
    Buffer.from(result.imageData, "base64").length === pollImg.length);
}

// ---------------------------------------------------------------------------
// createSuzuriProducts
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts]");

const _origFetch = globalThis.fetch;

function makeSuzuriFetch(itemsBody, materialsBody, { itemsOk = true, materialsOk = true } = {}) {
  return async (url, opts) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/items") && method === "GET") {
      return { ok: itemsOk, status: itemsOk ? 200 : 503, json: async () => itemsBody };
    }
    if (url.includes("/materials") && method === "POST") {
      return { ok: materialsOk, status: materialsOk ? 200 : 400, json: async () => materialsBody };
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
}

const MOCK_ITEMS_ALL_OK = {
  items: Object.values(SUZURI_ITEM_IDS).map(id => ({ id, available: true })),
};

function makeMaterialsRes(overrideNames = {}) {
  // overrideNames: { slug: "APIが返すname文字列" } でname表記ゆれを再現
  const defaultNames = {
    "t-shirt": "t-shirt", "sticker": "sticker",
    "can-badge": "can-badge", "acrylic-keychain": "acrylic-keychain",
  };
  const names = { ...defaultNames, ...overrideNames };
  return {
    material: { id: 999 },
    products: Object.entries(SUZURI_ITEM_IDS).map(([slug, id]) => ({
      item:              { id, name: names[slug] ?? slug },
      sampleUrl:         `https://suzuri.jp/${slug}`,
      pngSampleImageUrl: `https://example.com/${slug}.png`,
    })),
  };
}

const ENV = { SUZURI_API_KEY: "test-key" };

{
  // 正常系: 全4商品がavailable:trueで返る
  globalThis.fetch = makeSuzuriFetch(MOCK_ITEMS_ALL_OK, makeMaterialsRes());
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV);
  globalThis.fetch = _origFetch;
  assert("正常系: materialIdが返る", result.materialId === 999);
  assert("正常系: 全4商品が返る", result.products.length === 4);
  assert("正常系: 全商品がavailable:true",
    result.products.every(p => p.available === true));
  assert("正常系: t-shirtのsampleUrlが設定される",
    result.products.find(p => p.slug === "t-shirt")?.sampleUrl === "https://suzuri.jp/t-shirt");
}

{
  // 【回帰テスト】item.nameが予期しない表記でもitemIdで正しくマッチする
  // 旧コード（name文字列照合）ではすべてavailable:falseになっていたバグの再発防止
  const nonStandardNames = {
    "t-shirt":          "StandardTshirt",   // ハイフンなし・CamelCase
    "sticker":          "Sticker",          // 先頭大文字
    "can-badge":        "CanBadge",         // ハイフンなし
    "acrylic-keychain": "AcrylicKeychain",  // ハイフンなし
  };
  globalThis.fetch = makeSuzuriFetch(MOCK_ITEMS_ALL_OK, makeMaterialsRes(nonStandardNames));
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV);
  globalThis.fetch = _origFetch;
  const allAvailable = result.products.every(p => p.available === true);
  assert("【回帰】item.name表記ゆれ時も全商品available:true（itemIdで照合）", allAvailable);
  assert("【回帰】item.name='StandardTshirt'でt-shirtが正しくマッチ",
    result.products.find(p => p.slug === "t-shirt")?.available === true);
}

{
  // fail-open: GET /api/v1/items が503でも POST /materials が実行される
  globalThis.fetch = makeSuzuriFetch({}, makeMaterialsRes(), { itemsOk: false });
  let threw = false;
  let result;
  try {
    result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV);
  } catch {
    threw = true;
  }
  globalThis.fetch = _origFetch;
  assert("fail-open: /items失敗でもcreateSuzuriProductsが成功する", !threw);
  assert("fail-open: /items失敗時も全商品available:true（全件対象でmaterials呼び出し）",
    result?.products.every(p => p.available === true));
}

{
  // materialsレスポンスに含まれないslugはavailable:false
  const partialMaterialsRes = {
    material: { id: 777 },
    products: [
      // t-shirtのみ返す（他3つは在庫切れ等でSUZURI側が省略した想定）
      { item: { id: 1, name: "t-shirt" }, sampleUrl: "https://suzuri.jp/t-shirt", pngSampleImageUrl: "" },
    ],
  };
  globalThis.fetch = makeSuzuriFetch(MOCK_ITEMS_ALL_OK, partialMaterialsRes);
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV);
  globalThis.fetch = _origFetch;
  assert("部分レスポンス: t-shirtのみavailable:true",
    result.products.find(p => p.slug === "t-shirt")?.available === true);
  assert("部分レスポンス: stickerはavailable:false",
    result.products.find(p => p.slug === "sticker")?.available === false);
  assert("部分レスポンス: 4件すべて返る", result.products.length === 4);
}

// ---------------------------------------------------------------------------
// updateMetaInR2
// ---------------------------------------------------------------------------
console.log("\n[updateMetaInR2]");

function makeMockBucket(initialMeta) {
  const store = {};
  if (initialMeta !== undefined) {
    store["test-id/meta.json"] = JSON.stringify(initialMeta);
  }
  return {
    async get(key) {
      if (!(key in store)) return null;
      const val = store[key];
      return { json: async () => JSON.parse(val) };
    },
    async put(key, value) { store[key] = value; },
    _read(key) { return store[key] ? JSON.parse(store[key]) : undefined; },
  };
}

{
  // 正常系: 指定フィールドが上書きされ、他のフィールドは保持される
  const bucket = makeMockBucket({ theme: "テスト記念日", materialId: null, products: [] });
  await updateMetaInR2(bucket, "test-id", { materialId: 42, products: [{ slug: "sticker" }] });
  const result = bucket._read("test-id/meta.json");
  assert("updateMetaInR2: materialId が更新される", result.materialId === 42);
  assert("updateMetaInR2: products が更新される", result.products[0].slug === "sticker");
  assert("updateMetaInR2: 既存フィールド theme が保持される", result.theme === "テスト記念日");
}

{
  // idが存在しない場合: エラーなく終了し何もしない
  const bucket = makeMockBucket(); // meta なし
  let threw = false;
  try {
    await updateMetaInR2(bucket, "nonexistent-id", { materialId: 1 });
  } catch {
    threw = true;
  }
  assert("updateMetaInR2: 存在しないidでもエラーをthrowしない", !threw);
  assert("updateMetaInR2: 存在しないidでは何も書き込まれない",
    bucket._read("nonexistent-id/meta.json") === undefined);
}

{
  // updatesで渡した以外のフィールドが消えないこと
  const bucket = makeMockBucket({
    theme: "記念日A", description: "説明A", sourceUrl: "https://example.com",
    materialId: null, products: [], createdAt: "2026-03-28T00:00:00.000Z",
  });
  await updateMetaInR2(bucket, "test-id", { materialId: 99 });
  const result = bucket._read("test-id/meta.json");
  assert("updateMetaInR2: description が消えない", result.description === "説明A");
  assert("updateMetaInR2: sourceUrl が消えない", result.sourceUrl === "https://example.com");
  assert("updateMetaInR2: createdAt が消えない", result.createdAt === "2026-03-28T00:00:00.000Z");
}

// ---------------------------------------------------------------------------
// _calcWatermarkLayout（frontend/index.html の applyWatermark 座標計算ロジック）
// ※ ブラウザCanvasなしで検証するため、同じ純粋関数をここで定義してテストする
// ---------------------------------------------------------------------------
console.log("\n[_calcWatermarkLayout]");

function calcWatermarkLayout(imgWidth, imgHeight, textWidth) {
  const fontSize = Math.max(12, Math.round(imgWidth * 0.013));
  const padX = 8, padY = 5, margin = 12;
  const bgW  = textWidth + padX * 2;
  const bgH  = fontSize  + padY * 2;
  const bgX  = imgWidth  - bgW - margin;
  const bgY  = imgHeight - bgH - margin;
  return { bgX, bgY, bgW, bgH, fontSize, textX: bgX + padX, textY: bgY + bgH / 2 };
}

{
  // 標準サイズ 1024×1024
  const layout = calcWatermarkLayout(1024, 1024, 80);
  assert("1024px: fontSize = max(12, round(1024×0.013)) = 13", layout.fontSize === 13);
  assert("1024px: bgW = textWidth + 16",  layout.bgW === 80 + 16);
  assert("1024px: bgH = fontSize + 10",   layout.bgH === 13 + 10);
  assert("1024px: 右端から margin だけ内側（bgX + bgW + margin = imgWidth）",
    layout.bgX + layout.bgW + 12 === 1024);
  assert("1024px: 下端から margin だけ内側（bgY + bgH + margin = imgHeight）",
    layout.bgY + layout.bgH + 12 === 1024);
  assert("1024px: textX = bgX + padX",    layout.textX === layout.bgX + 8);
  assert("1024px: textY = 背景の垂直中央", layout.textY === layout.bgY + layout.bgH / 2);
}

{
  // 極小サイズ: fontSize が最小値 12 にクランプされる
  const layout = calcWatermarkLayout(100, 100, 60);
  assert("100px: fontSize が min 12 にクランプ", layout.fontSize === 12);
}

{
  // テキスト幅が変わると bgW が変わる
  const a = calcWatermarkLayout(512, 512, 50);
  const b = calcWatermarkLayout(512, 512, 100);
  assert("textWidth増加でbgWが増加する", b.bgW > a.bgW);
  assert("textWidth増加でbgXが左にずれる（右端は固定）", b.bgX < a.bgX);
}

{
  // 最小想定サイズ 512×512 でも範囲内に収まること（Pollinationsフォールバック画像サイズ）
  const layout = calcWatermarkLayout(512, 512, 80);
  assert("512px: bgX が 0 以上", layout.bgX >= 0);
  assert("512px: bgY が 0 以上", layout.bgY >= 0);
  assert("512px: bgX + bgW が imgWidth 以内", layout.bgX + layout.bgW <= 512);
  assert("512px: bgY + bgH が imgHeight 以内", layout.bgY + layout.bgH <= 512);
}

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed}件中 ${passed}件成功、${failed}件失敗`);
if (failed > 0) process.exit(1);
