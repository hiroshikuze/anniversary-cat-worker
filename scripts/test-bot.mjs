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
import { createSuzuriProducts, SUZURI_ITEM_IDS, SUZURI_TORIBUN } from "../worker/suzuri.js";

import {
  buildPostText, buildHashtagFacets, buildUrlFacets, buildThemeTag, notifyDiscord, runBot,
  shrinkImageIfNeeded, _setPhotonForTest, BLUESKY_MAX_IMAGE_BYTES,
} from "../worker/bluesky-bot.js";

import { pickPersona, pickPersonality } from "../worker/index.js";
import { submitFalJob, getFalResult } from "../worker/fal.js";

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
  assert("CTA に #にゃんバーサリー が含まれる", text.includes("#にゃんバーサリー"));

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
// buildThemeTag
// ---------------------------------------------------------------------------
console.log("\n[buildThemeTag]");
{
  // 正常系: 日本語テーマ
  assert("日本語テーマ: #を先頭に付与する",         buildThemeTag("世界猫の日") === "#世界猫の日");
  assert("英数字テーマ: そのままタグ化する",         buildThemeTag("CatDay") === "#CatDay");

  // 正規化: 空白・記号を除去
  assert("スペース除去: 「ねこ の 日」→「#ねこの日」", buildThemeTag("ねこ の 日") === "#ねこの日");
  assert("中黒除去: 「ロールプレイング・ゲームの日」→記号除去", buildThemeTag("ロールプレイング・ゲームの日") === "#ロールプレイングゲームの日");
  assert("全角スペース除去",                        buildThemeTag("ね\u3000こ") === "#ねこ");

  // 境界値: 空・記号のみ
  assert("空文字はnullを返す",    buildThemeTag("") === null);
  assert("nullはnullを返す",      buildThemeTag(null) === null);
  assert("記号のみはnullを返す",  buildThemeTag("！？・。") === null);

  // 境界値: 30文字超はトリム
  const longTheme = "あ".repeat(35);
  const tag = buildThemeTag(longTheme);
  assert("31文字以上は#込みで31文字にトリム（30文字＋#）", tag !== null && tag.length === 31);
}

// ---------------------------------------------------------------------------
// buildPostText: テーマタグ追加
// ---------------------------------------------------------------------------
console.log("\n[buildPostText: テーマタグ]");
{
  const text = buildPostText("ねこの日", "猫を愛でる記念日です");
  assert("テーマタグ #ねこの日 が含まれる", text.includes("#ねこの日"));

  // 300 grapheme以内に収まること（テーマタグ追加後）
  const graphemes = [...new Intl.Segmenter().segment(text)];
  assert(`テーマタグ追加後も300 grapheme以内 (実測: ${graphemes.length})`, graphemes.length <= 300);
}

{
  // テーマが記号のみの場合はタグ行に追加されない
  const text = buildPostText("！？", "説明文");
  assert("テーマが記号のみの場合: #は追加されない",
    !/#！/.test(text) && text.includes("#猫"));
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

  // #にゃんバーサリー が CTA(1回) + タグ末尾(1回) = 2回出現するため固定facetは7件
  assert("facets の件数が7件（固定タグのみ、additionalTags未指定）", facets.length === 7);

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
// buildHashtagFacets: additionalTags（テーマタグ）
// ---------------------------------------------------------------------------
console.log("\n[buildHashtagFacets: additionalTags]");
{
  const themeTag = buildThemeTag("ねこの日");
  const text     = buildPostText("ねこの日", "説明文");
  const facets   = buildHashtagFacets(text, [themeTag]);
  const encoder  = new TextEncoder();
  const textBytes = encoder.encode(text);

  assert("テーマタグ込みで8件になる（固定7＋テーマタグ1）", facets.length === 8);

  // テーマタグのバイト位置が正確か
  const themeFacet = facets.find(f => f.features[0].tag === "ねこの日");
  assert("テーマタグのfacetが存在する", themeFacet !== undefined);
  if (themeFacet) {
    const { byteStart, byteEnd } = themeFacet.index;
    const extracted = new TextDecoder().decode(textBytes.slice(byteStart, byteEnd));
    assert(`"#ねこの日" のバイト位置が正確（extracted="${extracted}"）`, extracted === "#ねこの日");
    assert("$type が app.bsky.richtext.facet#tag", themeFacet.features[0].$type === "app.bsky.richtext.facet#tag");
  }
}

{
  // additionalTags=[] の場合は固定7件のまま
  const text   = buildPostText("テスト", "説明文");
  const facets = buildHashtagFacets(text, []);
  assert("additionalTags=[] は固定7件のまま", facets.length === 7);
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
// createSuzuriProducts: slugFilter
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts: slugFilter]");

{
  // slugFilter 指定時は指定スラッグのみ POST /materials に送る
  let capturedSlugs;
  const captureFetch2 = async (url, opts) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/items") && method === "GET") {
      return { ok: true, status: 200, json: async () => MOCK_ITEMS_ALL_OK };
    }
    if (url.includes("/materials") && method === "POST") {
      const body = JSON.parse(opts.body);
      capturedSlugs = body.products.map(p => p.itemId);
      const filteredProducts = makeMaterialsRes().products.filter(p =>
        body.products.some(pp => pp.itemId === p.item.id)
      );
      return { ok: true, status: 200, json: async () => ({ material: { id: 111 }, products: filteredProducts }) };
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  globalThis.fetch = captureFetch2;
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV, ["t-shirt", "sticker"]);
  globalThis.fetch = _origFetch;

  assert("slugFilter: POST /materials に t-shirt(1) と sticker(11) のみ送る",
    capturedSlugs?.length === 2 &&
    capturedSlugs.includes(SUZURI_ITEM_IDS["t-shirt"]) &&
    capturedSlugs.includes(SUZURI_ITEM_IDS["sticker"]));
  assert("slugFilter: can-badge は POST に含まれない",
    !capturedSlugs?.includes(SUZURI_ITEM_IDS["can-badge"]));
  assert("slugFilter: 結果は指定した2商品のみ返る", result.products.length === 2);
  assert("slugFilter: t-shirt が available:true", result.products.find(p => p.slug === "t-shirt")?.available === true);
  assert("slugFilter: sticker が available:true", result.products.find(p => p.slug === "sticker")?.available === true);
}

{
  // slugFilter=null（未指定）時は従来通り全4商品
  globalThis.fetch = makeSuzuriFetch(MOCK_ITEMS_ALL_OK, makeMaterialsRes());
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV, null);
  globalThis.fetch = _origFetch;
  assert("slugFilter=null: 全4商品が返る", result.products.length === 4);
}

{
  // center グループ（can-badge, acrylic-keychain）のみ
  let capturedIds;
  const captureFetch3 = async (url, opts) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/items") && method === "GET") {
      return { ok: true, status: 200, json: async () => MOCK_ITEMS_ALL_OK };
    }
    if (url.includes("/materials") && method === "POST") {
      const body = JSON.parse(opts.body);
      capturedIds = body.products.map(p => p.itemId);
      const filteredProducts = makeMaterialsRes().products.filter(p =>
        body.products.some(pp => pp.itemId === p.item.id)
      );
      return { ok: true, status: 200, json: async () => ({ material: { id: 222 }, products: filteredProducts }) };
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  globalThis.fetch = captureFetch3;
  const result = await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV, ["can-badge", "acrylic-keychain"]);
  globalThis.fetch = _origFetch;

  assert("centerグループ: POST に can-badge(17) と acrylic-keychain(147) のみ含む",
    capturedIds?.length === 2 &&
    capturedIds.includes(SUZURI_ITEM_IDS["can-badge"]) &&
    capturedIds.includes(SUZURI_ITEM_IDS["acrylic-keychain"]));
  assert("centerグループ: 結果は2商品のみ返る", result.products.length === 2);
}

// ---------------------------------------------------------------------------
// SUZURI_TORIBUN（価格計算）
// ---------------------------------------------------------------------------
console.log("\n[SUZURI_TORIBUN]");

{
  // ベース価格 × 30% 切り捨てが正しいこと
  assert("t-shirt: Math.floor(1980 × 0.30) = 594",        SUZURI_TORIBUN["t-shirt"]         === 594);
  assert("sticker: Math.floor(385 × 0.30) = 115",         SUZURI_TORIBUN["sticker"]          === 115);
  assert("can-badge: Math.floor(385 × 0.30) = 115",       SUZURI_TORIBUN["can-badge"]        === 115);
  assert("acrylic-keychain: Math.floor(495 × 0.30) = 148", SUZURI_TORIBUN["acrylic-keychain"] === 148);
  // 全商品に正の取り分が設定されている
  const allPositive = Object.values(SUZURI_TORIBUN).every(v => v > 0);
  assert("全商品のトリブンが 0 より大きい", allPositive);
  // SUZURIの上限（5000円）を超えていない
  const withinLimit = Object.values(SUZURI_TORIBUN).every(v => v <= 5000);
  assert("全商品のトリブンが上限 5000 円以内", withinLimit);
  // SUZURI_ITEM_IDS の全スラッグに対応するトリブンが存在する
  const allSlugsHavePrice = Object.keys(SUZURI_ITEM_IDS).every(slug => slug in SUZURI_TORIBUN);
  assert("全スラッグに対応するトリブンが定義されている", allSlugsHavePrice);
}

// ---------------------------------------------------------------------------
// createSuzuriProducts: price フィールド検証
// ---------------------------------------------------------------------------
console.log("\n[createSuzuriProducts: トリブン価格]");

{
  // POST /materials リクエストに各商品の price が含まれること
  let capturedBody;
  const captureFetch = async (url, opts) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/items") && method === "GET") {
      return { ok: true, status: 200, json: async () => MOCK_ITEMS_ALL_OK };
    }
    if (url.includes("/materials") && method === "POST") {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => makeMaterialsRes() };
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  globalThis.fetch = captureFetch;
  await createSuzuriProducts("data:image/jpeg;base64,abc", "テスト", ENV);
  globalThis.fetch = _origFetch;

  assert("POST /materials に products が含まれる", Array.isArray(capturedBody?.products));
  const tshirt = capturedBody?.products?.find(p => p.itemId === SUZURI_ITEM_IDS["t-shirt"]);
  const sticker = capturedBody?.products?.find(p => p.itemId === SUZURI_ITEM_IDS["sticker"]);
  assert("t-shirt の price が SUZURI_TORIBUN と一致（594円）",
    tshirt?.price === SUZURI_TORIBUN["t-shirt"]);
  assert("sticker の price が SUZURI_TORIBUN と一致（115円）",
    sticker?.price === SUZURI_TORIBUN["sticker"]);
  const allHavePrice = capturedBody?.products?.every(p => typeof p.price === "number" && p.price > 0);
  assert("全商品に正の price が設定されている", allHavePrice);
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
// updateMetaInR2: productsマージ（スラッグ単位 upsert）
// ---------------------------------------------------------------------------
console.log("\n[updateMetaInR2: productsマージ]");

{
  // 既存products（centerグループ）に新しいproducts（rightグループ）をマージ
  const existing = [
    { slug: "can-badge", sampleUrl: "https://suzuri.jp/cb", available: true },
    { slug: "acrylic-keychain", sampleUrl: "https://suzuri.jp/ak", available: true },
  ];
  const bucket = makeMockBucket({ theme: "テスト", materialId: 10, products: existing });
  const newProducts = [
    { slug: "t-shirt", sampleUrl: "https://suzuri.jp/ts", available: true },
    { slug: "sticker", sampleUrl: "https://suzuri.jp/st", available: true },
  ];
  await updateMetaInR2(bucket, "test-id", { products: newProducts });
  const result = bucket._read("test-id/meta.json");
  assert("productsマージ: 全4スラッグが存在する", result.products.length === 4);
  assert("productsマージ: can-badge が保持される", result.products.some(p => p.slug === "can-badge"));
  assert("productsマージ: acrylic-keychain が保持される", result.products.some(p => p.slug === "acrylic-keychain"));
  assert("productsマージ: t-shirt が追加される", result.products.some(p => p.slug === "t-shirt"));
  assert("productsマージ: sticker が追加される", result.products.some(p => p.slug === "sticker"));
  assert("productsマージ: materialId は変わらない", result.materialId === 10);
}

{
  // 既存スラッグを上書き（available が false → true に更新される場合）
  const bucket = makeMockBucket({
    theme: "テスト",
    products: [{ slug: "t-shirt", sampleUrl: "https://suzuri.jp/old", available: false }],
  });
  await updateMetaInR2(bucket, "test-id", {
    products: [{ slug: "t-shirt", sampleUrl: "https://suzuri.jp/new", available: true }],
  });
  const result = bucket._read("test-id/meta.json");
  assert("productsマージ: 既存スラッグは新しい値で上書きされる", result.products.length === 1);
  assert("productsマージ: 上書き後のsampleUrlが新しい値", result.products[0].sampleUrl === "https://suzuri.jp/new");
  assert("productsマージ: 上書き後のavailableがtrue", result.products[0].available === true);
}

{
  // 既存productsが空の場合: そのまま新しいproductsになる
  const bucket = makeMockBucket({ theme: "テスト", products: [] });
  await updateMetaInR2(bucket, "test-id", {
    products: [{ slug: "t-shirt", sampleUrl: "https://suzuri.jp/ts", available: true }],
  });
  const result = bucket._read("test-id/meta.json");
  assert("productsマージ: 既存空でも新productが追加される", result.products.length === 1);
  assert("productsマージ: 既存空でもt-shirtが存在する", result.products[0].slug === "t-shirt");
}

// ---------------------------------------------------------------------------
// _calcWatermarkLayout（frontend/index.html の applyWatermark 座標計算ロジック）
// ※ ブラウザCanvasなしで検証するため、同じ純粋関数をここで定義してテストする
// ---------------------------------------------------------------------------
console.log("\n[_calcWatermarkLayout]");

function calcWatermarkLayout(imgWidth, imgHeight, textWidth, position = "bottom-right") {
  const fontSize = Math.max(12, Math.round(imgWidth * 0.013));
  const padX = 8, padY = 5, margin = 12;
  const bgW  = textWidth + padX * 2;
  const bgH  = fontSize  + padY * 2;
  const bgX  = position === "bottom-center"
    ? Math.round((imgWidth - bgW) / 2)
    : imgWidth - bgW - margin;
  const bgY  = imgHeight - bgH - margin;
  return { bgX, bgY, bgW, bgH, fontSize, textX: bgX + padX, textY: bgY + bgH / 2 };
}

{
  // bottom-right（デフォルト）: 標準サイズ 1024×1024
  const layout = calcWatermarkLayout(1024, 1024, 80);
  assert("bottom-right 1024px: fontSize = max(12, round(1024×0.013)) = 13", layout.fontSize === 13);
  assert("bottom-right 1024px: bgW = textWidth + 16",  layout.bgW === 80 + 16);
  assert("bottom-right 1024px: bgH = fontSize + 10",   layout.bgH === 13 + 10);
  assert("bottom-right 1024px: 右端から margin だけ内側（bgX + bgW + margin = imgWidth）",
    layout.bgX + layout.bgW + 12 === 1024);
  assert("bottom-right 1024px: 下端から margin だけ内側（bgY + bgH + margin = imgHeight）",
    layout.bgY + layout.bgH + 12 === 1024);
  assert("bottom-right 1024px: textX = bgX + padX",    layout.textX === layout.bgX + 8);
  assert("bottom-right 1024px: textY = 背景の垂直中央", layout.textY === layout.bgY + layout.bgH / 2);
}

{
  // position 省略時は bottom-right と同じ結果になる
  const withDefault  = calcWatermarkLayout(1024, 1024, 80);
  const withExplicit = calcWatermarkLayout(1024, 1024, 80, "bottom-right");
  assert("position省略時は bottom-right と同じ bgX", withDefault.bgX === withExplicit.bgX);
}

{
  // bottom-center: bgX が水平中央に配置される
  const layout = calcWatermarkLayout(1024, 1024, 80);
  const center = calcWatermarkLayout(1024, 1024, 80, "bottom-center");
  assert("bottom-center 1024px: bgX = round((imgWidth - bgW) / 2)",
    center.bgX === Math.round((1024 - center.bgW) / 2));
  assert("bottom-center 1024px: bgX が bottom-right より左",
    center.bgX < layout.bgX);
  assert("bottom-center 1024px: bgY は bottom-right と同じ（下端margin固定）",
    center.bgY === layout.bgY);
  assert("bottom-center 1024px: textX = bgX + padX", center.textX === center.bgX + 8);
}

{
  // bottom-center: 缶バッジの円形クロップ内に収まること（内接円チェック）
  // 正方形画像の中心(W/2, H/2)から各コーナーの距離がW/2以内であること
  const W = 1024, H = 1024, textW = 80;
  const layout = calcWatermarkLayout(W, H, textW, "bottom-center");
  const cx = W / 2, cy = H / 2, r = W / 2;
  // 左端・右端の中央下部コーナーが円内に収まるか
  const leftX  = layout.bgX;
  const rightX = layout.bgX + layout.bgW;
  const bottomY = layout.bgY + layout.bgH;
  const leftInCircle  = (leftX  - cx) ** 2 + (bottomY - cy) ** 2 <= r ** 2;
  const rightInCircle = (rightX - cx) ** 2 + (bottomY - cy) ** 2 <= r ** 2;
  assert("bottom-center 1024px: ウォーターマーク左端が缶バッジ内接円内", leftInCircle);
  assert("bottom-center 1024px: ウォーターマーク右端が缶バッジ内接円内", rightInCircle);
}

{
  // bottom-center: 512×512 でも範囲内（Pollinationsフォールバック画像）
  const layout = calcWatermarkLayout(512, 512, 80, "bottom-center");
  assert("bottom-center 512px: bgX が 0 以上", layout.bgX >= 0);
  assert("bottom-center 512px: bgY が 0 以上", layout.bgY >= 0);
  assert("bottom-center 512px: bgX + bgW が imgWidth 以内", layout.bgX + layout.bgW <= 512);
  assert("bottom-center 512px: bgY + bgH が imgHeight 以内", layout.bgY + layout.bgH <= 512);
}

{
  // 極小サイズ: fontSize が最小値 12 にクランプされる
  const layout = calcWatermarkLayout(100, 100, 60);
  assert("100px: fontSize が min 12 にクランプ", layout.fontSize === 12);
}

{
  // テキスト幅が変わると bgW が変わる（bottom-right）
  const a = calcWatermarkLayout(512, 512, 50);
  const b = calcWatermarkLayout(512, 512, 100);
  assert("bottom-right: textWidth増加でbgWが増加する", b.bgW > a.bgW);
  assert("bottom-right: textWidth増加でbgXが左にずれる（右端は固定）", b.bgX < a.bgX);
}

{
  // テキスト幅が変わると bgW が変わる（bottom-center）
  const a = calcWatermarkLayout(512, 512, 50, "bottom-center");
  const b = calcWatermarkLayout(512, 512, 100, "bottom-center");
  assert("bottom-center: textWidth増加でbgWが増加する", b.bgW > a.bgW);
  assert("bottom-center: bgX は常に (imgWidth - bgW) / 2（中央固定）",
    a.bgX === Math.round((512 - a.bgW) / 2) && b.bgX === Math.round((512 - b.bgW) / 2));
}

{
  // bottom-right: 最小想定サイズ 512×512 でも範囲内に収まること
  const layout = calcWatermarkLayout(512, 512, 80);
  assert("bottom-right 512px: bgX が 0 以上", layout.bgX >= 0);
  assert("bottom-right 512px: bgY が 0 以上", layout.bgY >= 0);
  assert("bottom-right 512px: bgX + bgW が imgWidth 以内", layout.bgX + layout.bgW <= 512);
  assert("bottom-right 512px: bgY + bgH が imgHeight 以内", layout.bgY + layout.bgH <= 512);
}

// ---------------------------------------------------------------------------
// pickPersona
// ---------------------------------------------------------------------------
console.log("\n[pickPersona]");
{
  // null（おまかせ）または ASCII 文字列を返す
  const results = new Set(Array.from({ length: 200 }, () => pickPersona()));
  const strings = [...results].filter(v => v !== null);
  assert("文字列またはnullを返す", [...results].every(v => v === null || typeof v === "string"));
  assert("文字列はASCIIのみ（Pollinations プロンプトに安全）",
    strings.every(s => /^[\x20-\x7E]+$/.test(s)));
}

{
  // 1000回試行して全ペルソナ（null含む）が少なくとも1回出現する
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(pickPersona());
  assert("1000回試行で Ultra Rare 以外の全ペルソナ（null含む）が出現する",
    seen.size >= 10);
  assert("1000回試行でおまかせ(null)が出現する", seen.has(null));
}

{
  // Ultra Rare（weight=1）が1000回中に高頻度で出ないこと（上限10%）
  const ultraRare = "smoke-patterned Persian, pale undercoat with dark silver tips";
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (pickPersona() === ultraRare) count++;
  }
  assert(`Ultra Rare の出現率が10%以下 (実測: ${count}/1000)`, count <= 100);
}

{
  // 最頻出ペルソナ（weight=20）が最低頻出ペルソナ（weight=1）より多く出現すること
  const mostCommon = "orange mackerel tabby with white chest, amber eyes";
  const ultraRare  = "smoke-patterned Persian, pale undercoat with dark silver tips";
  let commonCount = 0;
  let rareCount = 0;
  for (let i = 0; i < 1000; i++) {
    const p = pickPersona();
    if (p === mostCommon) commonCount++;
    if (p === ultraRare)  rareCount++;
  }
  assert(`Common(w=20) の出現数がUltra Rare(w=1)より多い (${commonCount} vs ${rareCount})`,
    commonCount > rareCount);
}

// ---------------------------------------------------------------------------
// pickPersonality
// ---------------------------------------------------------------------------
console.log("\n[pickPersonality]");
{
  // null（おまかせ）または ASCII 文字列を返す
  const results = new Set(Array.from({ length: 200 }, () => pickPersonality()));
  const strings = [...results].filter(v => v !== null);
  assert("文字列またはnullを返す", [...results].every(v => v === null || typeof v === "string"));
  assert("文字列はASCIIのみ（Pollinations プロンプトに安全）",
    strings.every(s => /^[\x20-\x7E]+$/.test(s)));
}

{
  // 除外すべき攻撃的・神経質ワードが含まれていないこと（null はスキップ）
  const FORBIDDEN = ["aggress", "fearful", "anxious", "nervous", "attack", "hostile", "impulsive", "erratic"];
  let violations = 0;
  for (let i = 0; i < 200; i++) {
    const p = pickPersonality();
    if (p !== null && FORBIDDEN.some(w => p.toLowerCase().includes(w))) violations++;
  }
  assert("攻撃的・神経質ワードが含まれない", violations === 0);
}

{
  // 1000回試行して全5タイプ＋null が出現すること
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(pickPersonality());
  assert("1000回試行で全5タイプ＋おまかせ(null)が出現する", seen.size === 6);
  assert("1000回試行でおまかせ(null)が出現する", seen.has(null));
}

{
  // Cantankerous（ツンデレ・weight=3）が10%以下であること
  const tsundere = "sitting with back slightly turned, dignified aloof expression, secretly glancing back";
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (pickPersonality() === tsundere) count++;
  }
  assert(`Cantankerous の出現率が10%以下 (実測: ${count}/1000)`, count <= 100);
}

{
  // Human Cat（weight=35）が Cantankerous（weight=3）より多く出現すること
  const humanCat     = "gazing lovingly at viewer, sitting close, soft gentle expression";
  const cantankerous = "sitting with back slightly turned, dignified aloof expression, secretly glancing back";
  let humanCount = 0;
  let tsundereCount = 0;
  for (let i = 0; i < 1000; i++) {
    const p = pickPersonality();
    if (p === humanCat)     humanCount++;
    if (p === cantankerous) tsundereCount++;
  }
  assert(
    `Human Cat(w=35) の出現数が Cantankerous(w=3) より多い (${humanCount} vs ${tsundereCount})`,
    humanCount > tsundereCount
  );
}

// ---------------------------------------------------------------------------
// submitFalJob / getFalResult（Queue API）
// ---------------------------------------------------------------------------
console.log("\n[submitFalJob]");

{
  // FAL_KEY 未設定: fetch を呼ばず requestId=null を返す
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return {}; };
  const result = await submitFalJob("abc123", "image/png", {});
  globalThis.fetch = origFetch;
  assert("FAL_KEY 未設定: fetch を呼ばない", !fetchCalled);
  assert("FAL_KEY 未設定: requestId が null", result.requestId === null);
}

{
  // 正常系: queue投入してrequest_idを返す
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("queue.fal.run")) {
      return { ok: true, json: async () => ({ request_id: "test-req-123" }) };
    }
    throw new Error("unexpected fetch");
  };
  const result = await submitFalJob("abc", "image/png", { FAL_KEY: "test-key" });
  globalThis.fetch = origFetch;
  assert("正常系: requestId が返る", result.requestId === "test-req-123");
}

{
  // HTTPエラー時: エラーをthrow
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "error" });
  let threw = false;
  try { await submitFalJob("abc", "image/png", { FAL_KEY: "test-key" }); } catch { threw = true; }
  globalThis.fetch = origFetch;
  assert("HTTP 500: エラーをthrowする", threw);
}

{
  // request_id なしのレスポンス: エラーをthrow
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  let threw = false;
  try { await submitFalJob("abc", "image/png", { FAL_KEY: "test-key" }); } catch { threw = true; }
  globalThis.fetch = origFetch;
  assert("request_id なし: エラーをthrowする", threw);
}

console.log("\n[getFalResult]");

{
  // IN_QUEUE ステータス: cdnUrl なしで status だけ返す
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/status")) {
      return { ok: true, json: async () => ({ status: "IN_QUEUE" }) };
    }
    throw new Error("result fetch should not be called");
  };
  const result = await getFalResult("req-123", { FAL_KEY: "key" });
  globalThis.fetch = origFetch;
  assert("IN_QUEUE: status が返る", result.status === "IN_QUEUE");
  assert("IN_QUEUE: cdnUrl がない", result.cdnUrl === undefined);
}

{
  // COMPLETED: cdnUrl が返る
  const origFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount++;
    if (url.includes("/status")) {
      return { ok: true, json: async () => ({ status: "COMPLETED" }) };
    }
    // result fetch
    return { ok: true, json: async () => ({ image: { url: "https://cdn.fal.ai/hires.png" } }) };
  };
  const result = await getFalResult("req-123", { FAL_KEY: "key" });
  globalThis.fetch = origFetch;
  assert("COMPLETED: 2回fetchする（status + result）", callCount === 2);
  assert("COMPLETED: cdnUrl が返る", result.cdnUrl === "https://cdn.fal.ai/hires.png");
  assert("COMPLETED: mimeType が返る", result.mimeType === "image/png");
}

{
  // status check HTTPエラー: error を返す（throw しない）
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const result = await getFalResult("req-123", { FAL_KEY: "key" });
  globalThis.fetch = origFetch;
  assert("status check 失敗: error を返す", result.status === "error");
}

{
  // COMPLETED だが CDN URL なし: error を返す
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/status")) return { ok: true, json: async () => ({ status: "COMPLETED" }) };
    return { ok: true, json: async () => ({ image: {} }) };
  };
  const result = await getFalResult("req-123", { FAL_KEY: "key" });
  globalThis.fetch = origFetch;
  assert("CDN URL なし: error を返す", result.status === "error");
}

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed}件中 ${passed}件成功、${failed}件失敗`);
if (failed > 0) process.exit(1);
