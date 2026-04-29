#!/usr/bin/env node
/**
 * test-mastodon.mjs - Mastodon API単体テスト
 *
 * Mastodon投稿が失敗している原因を段階的に診断する。
 * 実際にテスト投稿を行い、完了後に自動削除する。
 *
 * 使い方:
 *   MASTODON_INSTANCE_URL=https://mstdn.jp MASTODON_ACCESS_TOKEN=xxx node scripts/test-mastodon.mjs
 *
 * オプション（画像なしでテキストのみ投稿する場合）:
 *   MASTODON_INSTANCE_URL=https://mstdn.jp MASTODON_ACCESS_TOKEN=xxx SKIP_IMAGE=1 node scripts/test-mastodon.mjs
 */

// Node.js 18未満ではglobal fetchが未定義のためundiciでpolyfill
if (typeof globalThis.fetch === "undefined") {
  try {
    const { fetch, FormData, Blob } = await import("undici");
    globalThis.fetch     = fetch;
    globalThis.FormData  = FormData;
    globalThis.Blob      = Blob;
  } catch {
    console.error("エラー: Node.js 18以上が必要です。");
    console.error("または: npm install undici を実行してから再試行してください。");
    process.exit(1);
  }
}

const INSTANCE_URL  = process.env.MASTODON_INSTANCE_URL?.replace(/\/$/, ""); // 末尾スラッシュを除去
const ACCESS_TOKEN  = process.env.MASTODON_ACCESS_TOKEN;
const SKIP_IMAGE    = process.env.SKIP_IMAGE === "1";

// ── 引数チェック ──────────────────────────────────────────────────────────────
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
  const res = await fetch(`${INSTANCE_URL}/api/v1/accounts/verify_credentials`, {
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` },
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /**/ }

  if (!res.ok) {
    console.error(`  ❌ 認証失敗: status=${res.status} error="${data.error ?? text.slice(0, 120)}"`);
    console.error("  → トークンが間違っているか、スコープが不足しています（write:statuses + write:media が必要）");
    process.exit(1);
  }
  accountName = data.acct ?? data.username ?? "(不明)";
  console.log(`  ✅ 認証成功: @${accountName}`);
} catch (e) {
  console.error(`  ❌ 接続失敗: ${e.message}`);
  console.error("  → MASTODON_INSTANCE_URL が間違っているか、インスタンスが応答していません");
  process.exit(1);
}

// ── ステップ2: 画像アップロード ───────────────────────────────────────────────
let mediaId = null;
if (!SKIP_IMAGE) {
  console.log("\n【ステップ2】画像アップロード (POST /api/v2/media)");
  try {
    // 最小サイズの1x1ピクセルPNG（テスト用）
    const PNG_1x1 = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a" +
      "49444154789c6260000000020001e221bc330000000049454e44ae426082", "hex"
    );
    const form = new FormData();
    form.append("file", new Blob([PNG_1x1], { type: "image/png" }), "test.png");
    form.append("description", "にゃんバーサリーBot 診断テスト画像");

    const res = await fetch(`${INSTANCE_URL}/api/v2/media`, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` },
      body:    form,
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /**/ }

    if (!res.ok) {
      console.error(`  ❌ 画像アップロード失敗: status=${res.status} error="${data.error ?? text.slice(0, 120)}"`);
      console.error("  → write:media スコープが必要です。または SKIP_IMAGE=1 でテキストのみ投稿を試してください");
      process.exit(1);
    }
    mediaId = data.id;
    const state = data.url ? "即時完了" : `非同期処理中 (202)`;
    console.log(`  ✅ アップロード成功: media_id=${mediaId} (${state})`);

    // 202（非同期）の場合、少し待機してから投稿
    if (res.status === 202) {
      console.log("  ⏳ 非同期処理中のため3秒待機...");
      await new Promise(r => setTimeout(r, 3000));
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
  const testText = `【にゃんバーサリーBot 診断テスト】\nこの投稿は自動的に削除されます。 #にゃんバーサリー`;
  const params = new URLSearchParams({ status: testText, visibility: "private" });
  if (mediaId) params.append("media_ids[]", mediaId);

  const res = await fetch(`${INSTANCE_URL}/api/v1/statuses`, {
    method:  "POST",
    headers: {
      "Authorization":   `Bearer ${ACCESS_TOKEN}`,
      "Content-Type":    "application/x-www-form-urlencoded",
      "Idempotency-Key": `test-${Date.now()}`,
    },
    body: params.toString(),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /**/ }

  if (!res.ok) {
    console.error(`  ❌ 投稿失敗: status=${res.status} error="${data.error ?? text.slice(0, 120)}"`);
    process.exit(1);
  }
  statusId = data.id;
  console.log(`  ✅ 投稿成功: id=${statusId} url=${data.url ?? "(不明)"}`);
} catch (e) {
  console.error(`  ❌ 接続失敗: ${e.message}`);
  process.exit(1);
}

// ── ステップ4: テスト投稿を削除 ───────────────────────────────────────────────
console.log("\n【ステップ4】テスト投稿を削除 (DELETE /api/v1/statuses/:id)");
try {
  const res = await fetch(`${INSTANCE_URL}/api/v1/statuses/${statusId}`, {
    method:  "DELETE",
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` },
  });
  if (res.ok) {
    console.log("  ✅ 削除成功");
  } else {
    console.warn(`  ⚠️ 削除失敗（投稿は残っています）: status=${res.status}`);
    console.warn(`  → ${INSTANCE_URL}/@${accountName}/${statusId} から手動削除してください`);
  }
} catch (e) {
  console.warn(`  ⚠️ 削除接続失敗: ${e.message}`);
}

console.log("\n=== 診断完了: 全ステップ成功 ✅ ===");
console.log("Cloudflare Worker上でもMastodon投稿は動作するはずです。");
console.log("それでもBot投稿が失敗する場合は、WorkerのシークレットにMastodon設定が正しく入っているか確認してください。");
