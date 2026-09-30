#!/usr/bin/env node
/**
 * post-sale-announcement.mjs - SNSセール告知の検証・Bluesky/Mastodon投稿・Discord送信
 *
 * GitHub Actions（.github/workflows/sale-announcement.yml）から、
 * tmp-sale-announcement/<日付-内容>/ のフォルダを引数にして実行する:
 *   node scripts/post-sale-announcement.mjs tmp-sale-announcement/2026-09-29-autumn-sale
 *
 * フォルダに置くもの・検証ルール・Discordの内容は .claude/rules/git-workflow.md の
 * 「SNSセール告知の自動投稿とDiscord送信」参照。フォルダに DRY_RUN があればSNSへは投稿しない。
 *
 * 必要な環境変数: BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD / DISCORD_WEBHOOK_URL
 * 任意: MASTODON_INSTANCE_URL / MASTODON_ACCESS_TOKEN（未設定ならMastodonはスキップ）
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = {
  blueskyGraphemes: 300,
  mastodonChars:    500,
  xWeighted:        280,
  xHashtags:        5,     // Instagramの上限（2025-12〜）に合わせる
  altChars:         1500,  // Mastodonの代替テキスト上限
  imageBytes:       976_000, // worker/bot.jsのBLUESKY_MAX_IMAGE_BYTESと同じ
  discordChars:     2000,
};

const BLUESKY_API = "https://bsky.social/xrpc";
const URL_RE      = /https?:\/\/[^\s]+/g;
// 行頭または空白の直後の # から始まる語をハッシュタグとみなす（URL中の # は除外される）
const HASHTAG_RE  = /(^|\s)(#[^\s#]+)/g;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export function graphemeCount(text) {
  return [...segmenter.segment(text)].length;
}

export function countHashtags(text) {
  return [...text.matchAll(HASHTAG_RE)].length;
}

/**
 * Xの加重文字数（概算）。URLは長さに関係なく23、U+10FF以下の文字は1、それ以外（日本語・絵文字等）は2。
 * 公式のtwitter-textのレンジ定義の簡易版で、日本語中心の告知文の判定には十分な精度。
 */
export function xWeightedLength(text) {
  const urls   = text.match(URL_RE) ?? [];
  const rest   = text.replace(URL_RE, "");
  let weighted = urls.length * 23;
  for (const seg of segmenter.segment(rest)) {
    const cp = seg.segment.codePointAt(0);
    weighted += cp <= 0x10ff ? 1 : 2;
  }
  return weighted;
}

/**
 * 告知の中身を検証し、エラーメッセージの配列を返す（空なら問題なし）。
 * @param {{bluesky: string, mastodon: string, x: string, alt: string, imageBytes: number}} a
 */
export function validateAnnouncement(a) {
  const errors = [];
  for (const [name, text] of [["bluesky.txt", a.bluesky], ["mastodon.txt", a.mastodon], ["x.txt", a.x], ["alt.txt", a.alt]]) {
    if (!text || !text.trim()) errors.push(`${name} が空です`);
  }
  if (a.bluesky && graphemeCount(a.bluesky) > LIMITS.blueskyGraphemes) {
    errors.push(`bluesky.txt が${graphemeCount(a.bluesky)}文字です（上限${LIMITS.blueskyGraphemes}）`);
  }
  if (a.mastodon && graphemeCount(a.mastodon) > LIMITS.mastodonChars) {
    errors.push(`mastodon.txt が${graphemeCount(a.mastodon)}文字です（上限${LIMITS.mastodonChars}）`);
  }
  if (a.x && xWeightedLength(a.x) > LIMITS.xWeighted) {
    errors.push(`x.txt がXの加重文字数で${xWeightedLength(a.x)}です（上限${LIMITS.xWeighted}）`);
  }
  if (a.x && countHashtags(a.x) > LIMITS.xHashtags) {
    errors.push(`x.txt のハッシュタグが${countHashtags(a.x)}個です（Instagramの上限${LIMITS.xHashtags}個）`);
  }
  if (a.alt && graphemeCount(a.alt) > LIMITS.altChars) {
    errors.push(`alt.txt が${graphemeCount(a.alt)}文字です（上限${LIMITS.altChars}）`);
  }
  if (!a.imageBytes) {
    errors.push("画像（banner.jpg または banner.png）がありません");
  } else if (a.imageBytes > LIMITS.imageBytes) {
    errors.push(`画像が${a.imageBytes}バイトです（Blueskyの上限${LIMITS.imageBytes}）。JPEGに変換してください`);
  }
  return errors;
}

/**
 * 本文中のURLとハッシュタグを、AT Protocolのfacet（UTF-8バイト位置）に変換する。
 * worker/bot.jsのbuildHashtagFacets()は固定タグ一覧前提のため、告知文用に全タグを拾う版を持つ。
 */
export function buildAnnouncementFacets(text) {
  const enc     = new TextEncoder();
  const byteAt  = (i) => enc.encode(text.slice(0, i)).length;
  const facets  = [];
  for (const m of text.matchAll(URL_RE)) {
    facets.push({
      index:    { byteStart: byteAt(m.index), byteEnd: byteAt(m.index + m[0].length) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  for (const m of text.matchAll(HASHTAG_RE)) {
    const start = m.index + m[1].length;
    const tag   = m[2];
    facets.push({
      index:    { byteStart: byteAt(start), byteEnd: byteAt(start + tag.length) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: tag.slice(1) }],
    });
  }
  return facets;
}

function statusLine(label, r) {
  switch (r?.status) {
    case "ok":      return `✅ ${label}投稿完了 ${r.url ?? ""}`.trim();
    case "error":   return `❌ ${label}投稿失敗: ${r.error}`;
    case "skipped": return `⏭️ ${label}未設定・スキップ`;
    case "dry":     return `🧪 ${label}: お試し実行のため投稿していません`;
    default:        return `❔ ${label}: 未実行`;
  }
}

function clip(text) {
  return text.length > LIMITS.discordChars ? text.slice(0, LIMITS.discordChars - 4) + "\n..." : text;
}

/**
 * Discordに送るメッセージ（1通2,000字以内）の配列を組み立てる。1通目に画像を添付する想定。
 * @param {{dryRun: boolean, bluesky?: object, mastodon?: object, errors?: string[], texts: {x: string, mastodon: string, alt: string}}} p
 */
export function buildDiscordMessages({ dryRun, bluesky, mastodon, errors = [], texts }) {
  const head = dryRun
    ? "🧪 テスト実行（投稿は行われていません）SNSセール告知のプレビュー"
    : "📣 SNSセール告知";
  const first = errors.length > 0
    ? [head, "❌ 検証エラーのため、どのSNSにも投稿していません:", ...errors.map((e) => `・${e}`)].join("\n")
    : [head, statusLine("Bluesky", bluesky), statusLine("Mastodon", mastodon)].join("\n");
  return [
    first,
    `📣 X・Instagram等に転載用（ハッシュタグ5つまで）:\n${texts.x ?? ""}`,
    `📣 Mastodon用の本文:\n${texts.mastodon ?? ""}`,
    `🖼 代替テキスト（alt・共通）:\n${texts.alt ?? ""}`,
  ].map(clip);
}

// ---------------------------------------------------------------------------
// ここから下は外部通信（Actionsからの実行時のみ）
// ---------------------------------------------------------------------------

async function createAnnouncementPost(accessJwt, did, text, blobRef, altText) {
  const record = {
    $type:     "app.bsky.feed.post",
    text,
    facets:    buildAnnouncementFacets(text),
    embed:     { $type: "app.bsky.embed.images", images: [{ image: blobRef, alt: altText }] },
    createdAt: new Date().toISOString(),
  };
  const res = await fetch(`${BLUESKY_API}/com.atproto.repo.createRecord`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${accessJwt}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
    signal:  AbortSignal.timeout(10_000),
  });
  const resText = await res.text();
  let data = {};
  try { data = JSON.parse(resText); } catch { /**/ }
  if (!res.ok) throw new Error(`Bluesky投稿作成失敗: ${data.error ?? res.status} ${data.message ?? ""}`);
  return data;
}

async function sendDiscord(webhookUrl, content, image = null) {
  let res;
  if (image) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    form.append("files[0]", new Blob([image.bytes], { type: image.mimeType }), image.name);
    res = await fetch(webhookUrl, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  } else {
    res = await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ content }),
      signal:  AbortSignal.timeout(10_000),
    });
  }
  if (!res.ok) throw new Error(`Discord送信失敗: status=${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function main(dir) {
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");
  const imageName = ["banner.jpg", "banner.jpeg", "banner.png"].find((f) => existsSync(join(dir, f)));
  const image = imageName
    ? { name: imageName, bytes: readFileSync(join(dir, imageName)), mimeType: imageName.endsWith(".png") ? "image/png" : "image/jpeg" }
    : null;
  const texts  = { bluesky: read("bluesky.txt"), mastodon: read("mastodon.txt"), x: read("x.txt"), alt: read("alt.txt") };
  const dryRun = existsSync(join(dir, "DRY_RUN"));
  const env    = process.env;
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL が未設定です");

  const errors = validateAnnouncement({ ...texts, imageBytes: image?.bytes.length ?? 0 });
  let bluesky  = { status: "dry" };
  let mastodon = { status: "dry" };

  if (errors.length === 0 && !dryRun) {
    // 投稿はリトライしない（二重投稿を避けるため。worker/bot.jsと同じ方針）
    const { createBlueskySession, uploadBlob, uploadMediaToMastodon, postStatusToMastodon, buildBlueskyPostUrl } =
      await import("../worker/bot.js");
    const mastoUrl = (env.MASTODON_INSTANCE_URL ?? "").replace(/\/+$/, "");
    const [b, m] = await Promise.allSettled([
      (async () => {
        const { accessJwt, did } = await createBlueskySession(env.BLUESKY_IDENTIFIER, env.BLUESKY_APP_PASSWORD);
        const blob = await uploadBlob(accessJwt, image.bytes, image.mimeType);
        const post = await createAnnouncementPost(accessJwt, did, texts.bluesky, blob, texts.alt);
        return buildBlueskyPostUrl(post.uri, env.BLUESKY_IDENTIFIER);
      })(),
      (async () => {
        if (!mastoUrl || !env.MASTODON_ACCESS_TOKEN) return null;
        const mediaId = await uploadMediaToMastodon(mastoUrl, env.MASTODON_ACCESS_TOKEN, image.bytes, image.mimeType, texts.alt);
        const status  = await postStatusToMastodon(mastoUrl, env.MASTODON_ACCESS_TOKEN, texts.mastodon, mediaId);
        return status.url;
      })(),
    ]);
    bluesky  = b.status === "fulfilled" ? { status: "ok", url: b.value } : { status: "error", error: b.reason.message };
    mastodon = m.status === "rejected"  ? { status: "error", error: m.reason.message }
             : m.value == null          ? { status: "skipped" }
             : { status: "ok", url: m.value };
  }

  const messages = buildDiscordMessages({ dryRun, bluesky, mastodon, errors, texts });
  for (const [i, content] of messages.entries()) {
    await sendDiscord(env.DISCORD_WEBHOOK_URL, content, i === 0 ? image : null);
    await new Promise((r) => setTimeout(r, 1000)); // Discord Webhookのレート制限を避ける
  }
  console.log(messages[0]);

  const failed = errors.length > 0 || bluesky.status === "error" || mastodon.status === "error";
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使い方: node scripts/post-sale-announcement.mjs <tmp-sale-announcement/フォルダ>");
    process.exit(1);
  }
  main(dir).catch((e) => { console.error(e); process.exit(1); });
}
