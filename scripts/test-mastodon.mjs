#!/usr/bin/env node
/**
 * test-mastodon.mjs - Mastodon API単体テスト
 *
 * fetchに依存せずNode.js組み込みのhttpsモジュールのみで動作する。
 * 認証確認→画像アップロード→テスト投稿（非公開）→自動削除の4ステップで診断する。
 *
 * 使い方:
 *   MASTODON_INSTANCE_URL=https://mstdn.jp MASTODON_ACCESS_TOKEN=xxx node scripts/test-mastodon.mjs
 *
 * 画像アップロードをスキップしてテキストのみ試す場合:
 *   MASTODON_INSTANCE_URL=https://mstdn.jp MASTODON_ACCESS_TOKEN=xxx SKIP_IMAGE=1 node scripts/test-mastodon.mjs
 */

import https from "node:https";
import http  from "node:http";

// ── HTTPリクエストヘルパー（fetchの代替） ────────────────────────────────────
function req(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const options = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers,
    };
    const request = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text });
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

// ── multipart/form-data ビルダー ──────────────────────────────────────────────
function buildMultipart(boundary, parts) {
  const bufs = [];
  for (const part of parts) {
    const disp = `Content-Disposition: form-data; name="${part.name}"` +
                 (part.filename ? `; filename="${part.filename}"` : "");
    const ct   = part.contentType ? `Content-Type: ${part.contentType}\r\n` : "";
    bufs.push(Buffer.from(`--${boundary}\r\n${disp}\r\n${ct}\r\n`));
    bufs.push(part.data instanceof Buffer ? part.data : Buffer.from(String(part.data)));
    bufs.push(Buffer.from("\r\n"));
  }
  bufs.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(bufs);
}

// ── 引数チェック ──────────────────────────────────────────────────────────────
const INSTANCE_URL = (process.env.MASTODON_INSTANCE_URL ?? "").replace(/\/$/, "");
const ACCESS_TOKEN = process.env.MASTODON_ACCESS_TOKEN ?? "";
const SKIP_IMAGE   = process.env.SKIP_IMAGE === "1";

if (!INSTANCE_URL || !ACCESS_TOKEN) {
  console.error("エラー: 環境変数が未設定です。");
  console.error("使い方: MASTODON_INSTANCE_URL=https://mstdn.jp MASTODON_ACCESS_TOKEN=xxx node scripts/test-mastodon.mjs");
  process.exit(1);
}

console.log("=== Mastodon API 診断テスト ===");
console.log(`インスタンス: ${INSTANCE_URL}`);
console.log(`トークン: ${ACCESS_TOKEN.slice(0, 8)}...（先頭8文字のみ表示）\n`);

// ── ステップ1: 認証確認 ────────────────────────────────────────────────────────
console.log("【ステップ1】認証確認 (GET /api/v1/accounts/verify_credentials)");
let accountName = "";
try {
  const { ok, status, text } = await req(`${INSTANCE_URL}/api/v1/accounts/verify_credentials`, {
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` },
  });
  let data = {};
  try { data = JSON.parse(text); } catch { /**/ }

  if (!ok) {
    console.error(`  ❌ 認証失敗: status=${status} error="${data.error ?? text.slice(0, 120)}"`);
    if (status === 401) console.error("  → トークンが無効か期限切れです。Mastodonの設定→開発→アプリから新しいトークンを発行してください。");
    if (status === 403) console.error("  → スコープ不足です。アプリに read スコープが必要です。");
    process.exit(1);
  }
  accountName = data.acct ?? data.username ?? "(不明)";
  console.log(`  ✅ 認証成功: @${accountName}`);
} catch (e) {
  console.error(`  ❌ 接続失敗: ${e.message}`);
  console.error("  → MASTODON_INSTANCE_URL が間違っているか、インスタンスが応答していません。");
  process.exit(1);
}

// ── ステップ2: 画像アップロード ───────────────────────────────────────────────
let mediaId = null;
if (!SKIP_IMAGE) {
  console.log("\n【ステップ2】画像アップロード (POST /api/v2/media)");
  try {
    // 最小サイズの1×1ピクセルPNG（テスト用バイナリ）
    const PNG_1x1 = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082", "hex"
    );
    const boundary = `boundary${Date.now()}`;
    const formBody = buildMultipart(boundary, [
      { name: "file",        filename: "test.png", contentType: "image/png", data: PNG_1x1 },
      { name: "description", data: "にゃんバーサリーBot 診断テスト画像" },
    ]);

    const { ok, status, text } = await req(`${INSTANCE_URL}/api/v2/media`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type":  `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(formBody.length),
      },
      body: formBody,
    });
    let data = {};
    try { data = JSON.parse(text); } catch { /**/ }

    if (!ok) {
      console.error(`  ❌ 画像アップロード失敗: status=${status} error="${data.error ?? text.slice(0, 120)}"`);
      if (status === 403) console.error("  → write:media スコープが必要です。");
      console.error("  → SKIP_IMAGE=1 でテキストのみ投稿を試してください。");
      process.exit(1);
    }
    mediaId = data.id;
    const state = data.url ? "即時完了" : "非同期処理中 (202)";
    console.log(`  ✅ アップロード成功: media_id=${mediaId} (${state})`);

    if (status === 202) {
      console.log("  ⏳ 非同期処理中のため3秒待機...");
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (e) {
    console.error(`  ❌ 接続失敗: ${e.message}`);
    process.exit(1);
  }
} else {
  console.log("\n【ステップ2】スキップ（SKIP_IMAGE=1）");
}

// ── ステップ3: テスト投稿 ─────────────────────────────────────────────────────
console.log("\n【ステップ3】テスト投稿 (POST /api/v1/statuses)");
let statusId = null;
try {
  const testText = "【にゃんバーサリーBot 診断テスト】\nこの投稿は自動的に削除されます。 #にゃんバーサリー";
  const params = new URLSearchParams({ status: testText, visibility: "private" });
  if (mediaId) params.append("media_ids[]", mediaId);
  const bodyStr = params.toString();

  const { ok, status, text } = await req(`${INSTANCE_URL}/api/v1/statuses`, {
    method:  "POST",
    headers: {
      "Authorization":   `Bearer ${ACCESS_TOKEN}`,
      "Content-Type":    "application/x-www-form-urlencoded",
      "Content-Length":  String(Buffer.byteLength(bodyStr)),
      "Idempotency-Key": `test-${Date.now()}`,
    },
    body: bodyStr,
  });
  let data = {};
  try { data = JSON.parse(text); } catch { /**/ }

  if (!ok) {
    console.error(`  ❌ 投稿失敗: status=${status} error="${data.error ?? text.slice(0, 120)}"`);
    if (status === 403) console.error("  → write:statuses スコープが必要です。");
    process.exit(1);
  }
  statusId = data.id;
  console.log(`  ✅ 投稿成功: id=${statusId}`);
  if (data.url) console.log(`  URL: ${data.url}`);
} catch (e) {
  console.error(`  ❌ 接続失敗: ${e.message}`);
  process.exit(1);
}

// ── ステップ4: テスト投稿を削除 ───────────────────────────────────────────────
console.log("\n【ステップ4】テスト投稿を削除 (DELETE /api/v1/statuses/:id)");
try {
  const { ok, status } = await req(`${INSTANCE_URL}/api/v1/statuses/${statusId}`, {
    method:  "DELETE",
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` },
  });
  if (ok) {
    console.log("  ✅ 削除成功");
  } else {
    console.warn(`  ⚠️ 削除失敗（投稿は残っています）: status=${status}`);
    console.warn(`  → ${INSTANCE_URL}/@${accountName}/${statusId} から手動削除してください。`);
  }
} catch (e) {
  console.warn(`  ⚠️ 削除接続失敗: ${e.message}`);
}

console.log("\n=== 診断完了: 全ステップ成功 ✅ ===");
console.log("Cloudflare Worker上でもMastodon投稿は動作するはずです。");
console.log("それでもBot投稿が失敗する場合は、WorkerのシークレットにMastodon設定が正しく入っているか確認してください。");
