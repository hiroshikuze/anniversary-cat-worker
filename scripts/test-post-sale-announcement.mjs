#!/usr/bin/env node
/**
 * test-post-sale-announcement.mjs - scripts/post-sale-announcement.mjs ユニットテスト
 *
 * 外部API接続は不要（純粋関数のみ）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-post-sale-announcement.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import {
  graphemeCount,
  countHashtags,
  xWeightedLength,
  validateAnnouncement,
  buildAnnouncementFacets,
  buildDiscordMessages,
  LIMITS,
} from "./post-sale-announcement.mjs";

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

const URL_T = "https://suzuri.jp/nyanmusu/21047599/t-shirt/s/white";
const VALID = {
  bluesky:  `SUZURI「秋のビッグセール」開催中🍁\n${URL_T}\n#にゃんバーサリー #SUZURI #猫`,
  mastodon: `SUZURI Autumn Big Sale is on! 🍁\n${URL_T}\n#Nyaniversary #cat`,
  x:        `SUZURI「秋のビッグセール」開催中🍁\n${URL_T}\n#にゃんバーサリー #SUZURI #猫 #AIart`,
  alt:      "SUZURI秋のビッグセールの告知画像。",
  imageBytes: 297_752,
};

// ---------------------------------------------------------------------------
// 文字数・ハッシュタグ数・Xの加重文字数
// ---------------------------------------------------------------------------
console.log("\n[graphemeCount / countHashtags / xWeightedLength]");
{
  assert("絵文字1つは1文字（grapheme）", graphemeCount("🍁") === 1);
  assert("日本語はそのまま文字数", graphemeCount("秋のセール") === 5);
  assert("ハッシュタグを数える", countHashtags("#猫 #SUZURI #AIart") === 3);
  assert("URL中の#はハッシュタグに数えない", countHashtags("https://example.com/#top です") === 0);
  assert("ハッシュタグなしは0", countHashtags("タグなし") === 0);
  assert("Xの加重: 英数字は1", xWeightedLength("abc") === 3);
  assert("Xの加重: 日本語は2", xWeightedLength("猫猫") === 4);
  assert("Xの加重: URLは長さに関係なく23", xWeightedLength(URL_T) === 23);
  assert("Xの加重: 日本語＋URLの合計", xWeightedLength(`猫 ${URL_T}`) === 2 + 1 + 23);
}

// ---------------------------------------------------------------------------
// validateAnnouncement - 正常系・境界値・エラー系
// ---------------------------------------------------------------------------
console.log("\n[validateAnnouncement]");
{
  assert("正常系: エラーなし", validateAnnouncement(VALID).length === 0);

  const bskyJust = { ...VALID, bluesky: "あ".repeat(LIMITS.blueskyGraphemes) };
  assert("境界値: Bluesky 300文字ちょうどは可", validateAnnouncement(bskyJust).length === 0);
  const bskyOver = { ...VALID, bluesky: "あ".repeat(LIMITS.blueskyGraphemes + 1) };
  assert("エラー系: Bluesky 301文字は不可", validateAnnouncement(bskyOver).some((e) => e.includes("bluesky.txt")));

  const mastoOver = { ...VALID, mastodon: "a".repeat(LIMITS.mastodonChars + 1) };
  assert("エラー系: Mastodon 501文字は不可", validateAnnouncement(mastoOver).some((e) => e.includes("mastodon.txt")));

  const x5 = { ...VALID, x: "本文 #a #b #c #d #e" };
  assert("境界値: Xのハッシュタグ5つは可", validateAnnouncement(x5).length === 0);
  const x6 = { ...VALID, x: "本文 #a #b #c #d #e #f" };
  assert("エラー系: Xのハッシュタグ6つは不可", validateAnnouncement(x6).some((e) => e.includes("ハッシュタグ")));

  const xLong = { ...VALID, x: "猫".repeat(141) };
  assert("エラー系: Xの加重282は不可", validateAnnouncement(xLong).some((e) => e.includes("x.txt")));
  const xJust = { ...VALID, x: "猫".repeat(140) };
  assert("境界値: Xの加重280ちょうどは可", validateAnnouncement(xJust).length === 0);

  const altOver = { ...VALID, alt: "あ".repeat(LIMITS.altChars + 1) };
  assert("エラー系: 代替テキスト1501文字は不可", validateAnnouncement(altOver).some((e) => e.includes("alt.txt")));

  const bigImage = { ...VALID, imageBytes: LIMITS.imageBytes + 1 };
  assert("エラー系: 画像がBluesky上限超過は不可", validateAnnouncement(bigImage).some((e) => e.includes("画像")));
  const noImage = { ...VALID, imageBytes: 0 };
  assert("エラー系: 画像なしは不可", validateAnnouncement(noImage).some((e) => e.includes("画像")));

  const empty = { ...VALID, bluesky: "  \n" };
  assert("エラー系: 空の本文は不可", validateAnnouncement(empty).some((e) => e.includes("bluesky.txt")));
}

// ---------------------------------------------------------------------------
// buildAnnouncementFacets - URLとハッシュタグをUTF-8バイト位置でfacet化
// ---------------------------------------------------------------------------
console.log("\n[buildAnnouncementFacets]");
{
  const text   = `開催中🍁\n${URL_T}\n#にゃんバーサリー #SUZURI`;
  const facets = buildAnnouncementFacets(text);
  const enc    = new TextEncoder();
  const bytes  = enc.encode(text);
  const slice  = (f) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));

  const links = facets.filter((f) => f.features[0].$type === "app.bsky.richtext.facet#link");
  const tags  = facets.filter((f) => f.features[0].$type === "app.bsky.richtext.facet#tag");
  assert("URLが1件のlink facetになる", links.length === 1 && links[0].features[0].uri === URL_T);
  assert("link facetのバイト位置が正確", slice(links[0]) === URL_T);
  assert("ハッシュタグが2件のtag facetになる", tags.length === 2);
  assert("tag facetのタグ名は#なし", tags.map((f) => f.features[0].tag).join(",") === "にゃんバーサリー,SUZURI");
  assert("tag facetのバイト位置が正確", slice(tags[0]) === "#にゃんバーサリー");
  assert("URLもタグもない本文はfacetなし", buildAnnouncementFacets("ただの本文").length === 0);
  const urlWithHash = buildAnnouncementFacets("https://example.com/#top");
  assert("URL中の#はタグにしない", urlWithHash.every((f) => f.features[0].$type !== "app.bsky.richtext.facet#tag"));
}

// ---------------------------------------------------------------------------
// buildDiscordMessages - 成否の表示と文面の分割
// ---------------------------------------------------------------------------
console.log("\n[buildDiscordMessages]");
{
  const texts = { x: VALID.x, mastodon: VALID.mastodon, alt: VALID.alt };
  const ok = buildDiscordMessages({
    dryRun: false,
    bluesky:  { status: "ok", url: "https://bsky.app/profile/nyanmusu.bsky.social/post/abc" },
    mastodon: { status: "ok", url: "https://mastodon.social/@nyanmusu/123" },
    texts,
  });
  assert("正常系: 4通に分かれる", ok.length === 4);
  assert("1通目にBlueskyの成功とURL", ok[0].includes("✅ Bluesky投稿完了") && ok[0].includes("bsky.app"));
  assert("1通目にMastodonの成功とURL", ok[0].includes("✅ Mastodon投稿完了") && ok[0].includes("mastodon.social/@nyanmusu/123"));
  assert("2通目はX等用の本文", ok[1].includes(VALID.x));
  assert("3通目はMastodon用の本文", ok[2].includes(VALID.mastodon));
  assert("4通目は代替テキスト", ok[3].includes(VALID.alt));
  assert("すべて2,000字以内", ok.every((m) => m.length <= 2000));

  const fail = buildDiscordMessages({
    dryRun: false,
    bluesky:  { status: "error", error: "Bluesky認証失敗: 401" },
    mastodon: { status: "skipped" },
    texts,
  });
  assert("エラー系: Blueskyの失敗理由を表示", fail[0].includes("❌ Bluesky投稿失敗") && fail[0].includes("401"));
  assert("Mastodon未設定はスキップと表示", fail[0].includes("⏭️ Mastodon"));

  const dry = buildDiscordMessages({
    dryRun: true,
    bluesky:  { status: "dry" },
    mastodon: { status: "dry" },
    texts,
  });
  assert("お試し実行は明記される", dry[0].includes("🧪 テスト実行（投稿は行われていません）"));
  assert("お試し実行は投稿完了と表示しない", !dry[0].includes("投稿完了"));

  const invalid = buildDiscordMessages({ dryRun: false, errors: ["bluesky.txt が301文字です"], texts });
  assert("検証エラー時は理由を1通目に表示", invalid[0].includes("検証エラー") && invalid[0].includes("bluesky.txt"));
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
