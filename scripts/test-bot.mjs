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
// 結果サマリー
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed}件中 ${passed}件成功、${failed}件失敗`);
if (failed > 0) process.exit(1);
