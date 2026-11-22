#!/usr/bin/env node
/**
 * test-growth-metrics.mjs - scripts/growth-metrics.mjs ユニットテスト
 *
 * 外部API接続は不要（純粋関数と、globalThis.fetch をモックした再試行の確認のみ）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-growth-metrics.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import {
  METRIC_KEYS,
  parseBlueskyFollowers,
  sumBlueskyEngagement,
  parseMastodonAccount,
  sumMastodonEngagement,
  parseUmamiShare,
  parseUmamiVisitors,
  parseUmamiEventCount,
  buildRange,
  redactSecrets,
  reasonFromError,
  HttpError,
  fetchJson,
  collectMetrics,
  buildCommentBody,
} from "./growth-metrics.mjs";

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

async function assertRejects(label, fn, check = () => true) {
  try {
    await fn();
    assert(`${label}（例外が出なかった）`, false);
  } catch (e) {
    assert(label, check(e));
  }
}

const SHARE_ID   = "AbCdEf123456";
const TOKEN      = "eyJhbGciOiJIUzI1NiJ9.secret-token-value";
const WEBSITE_ID = "11111111-2222-3333-4444-555555555555";

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------
console.log("\n[Bluesky]");
{
  assert("followersCountを取り出す", parseBlueskyFollowers({ followersCount: 112 }) === 112);
  assert("followersCount=0も有効", parseBlueskyFollowers({ followersCount: 0 }) === 0);
  let threw = false;
  try { parseBlueskyFollowers({}); } catch { threw = true; }
  assert("followersCountが無ければ例外", threw);

  const feed = {
    feed: [
      { post: { likeCount: 5, repostCount: 1, replyCount: 0 } },
      { post: { likeCount: 2, repostCount: 0, replyCount: 3 } },
      { post: { likeCount: 100, repostCount: 100, replyCount: 100 }, reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
      { post: { likeCount: 1 } }, // 欠けた数値は0とみなす
    ],
  };
  assert("いいね＋リポスト＋返信を合計し、他人の投稿の再投稿は除く", sumBlueskyEngagement(feed) === 5 + 1 + 2 + 3 + 1);
  assert("空のフィードは0", sumBlueskyEngagement({ feed: [] }) === 0);
  let threw2 = false;
  try { sumBlueskyEngagement({}); } catch { threw2 = true; }
  assert("feedが配列でなければ例外", threw2);
}

// ---------------------------------------------------------------------------
// Mastodon
// ---------------------------------------------------------------------------
console.log("\n[Mastodon]");
{
  const acc = parseMastodonAccount({ id: "110641526892617143", followers_count: 25 });
  assert("idとfollowers_countを取り出す", acc.id === "110641526892617143" && acc.followers === 25);
  let threw = false;
  try { parseMastodonAccount({ id: "1" }); } catch { threw = true; }
  assert("followers_countが無ければ例外", threw);

  const statuses = [
    { favourites_count: 2, reblogs_count: 1, replies_count: 1, reblog: null },
    { favourites_count: 0, reblogs_count: 0, replies_count: 0, reblog: null },
    { favourites_count: 50, reblogs_count: 50, replies_count: 50, reblog: { id: "x" } },
  ];
  assert("お気に入り＋ブースト＋返信を合計し、ブーストした他人の投稿は除く", sumMastodonEngagement(statuses) === 4);
  let threw2 = false;
  try { sumMastodonEngagement({ error: "x" }); } catch { threw2 = true; }
  assert("配列でなければ例外", threw2);
}

// ---------------------------------------------------------------------------
// Umami
// ---------------------------------------------------------------------------
console.log("\n[Umami]");
{
  const s = parseUmamiShare({ websiteId: WEBSITE_ID, token: TOKEN, shareId: "z" });
  assert("websiteIdとtokenを取り出す", s.websiteId === WEBSITE_ID && s.token === TOKEN);
  let threw = false;
  try { parseUmamiShare({ websiteId: WEBSITE_ID }); } catch (e) { threw = !String(e.message).includes(WEBSITE_ID); }
  assert("tokenが無ければ例外（メッセージに値を含めない）", threw);

  assert("visitorsが数値（現行版）", parseUmamiVisitors({ visitors: 42, pageviews: 99 }) === 42);
  assert("visitorsが{value,prev}（旧版）", parseUmamiVisitors({ visitors: { value: 7, prev: 3 } }) === 7);
  let threw2 = false;
  try { parseUmamiVisitors({ pageviews: 1 }); } catch { threw2 = true; }
  assert("visitorsが無ければ例外", threw2);

  const events = [{ x: "gallery-click", y: 9 }, { x: "suzuri-click", y: 4, t: "" }];
  assert("suzuri-clickのyを取り出す", parseUmamiEventCount(events, "suzuri-click") === 4);
  assert("該当イベントが無ければ0", parseUmamiEventCount([{ x: "gallery-click", y: 9 }], "suzuri-click") === 0);
  let threw3 = false;
  try { parseUmamiEventCount({}, "suzuri-click"); } catch { threw3 = true; }
  assert("配列でなければ例外", threw3);

  const now = Date.UTC(2026, 10, 22, 0, 0, 0);
  const r7 = buildRange(now, 7);
  assert("直近7日の範囲（ミリ秒）", r7.endAt === now && r7.endAt - r7.startAt === 7 * 86_400_000);
}

// ---------------------------------------------------------------------------
// errors の理由（秘密情報を含めない）
// ---------------------------------------------------------------------------
console.log("\n[errors の理由]");
{
  const secrets = [SHARE_ID, TOKEN, WEBSITE_ID];
  assert("既知の秘密情報を***に置き換える",
    redactSecrets(`share ${SHARE_ID} token ${TOKEN} site ${WEBSITE_ID}`, secrets) === "share *** token *** site ***");
  assert("URLを丸ごと伏せる（クエリを残さない）",
    !redactSecrets("failed https://cloud.umami.is/api/websites/abc/stats?startAt=1&endAt=2", []).includes("startAt"));
  assert("空の秘密情報は無視する", redactSecrets("abc", ["", null, undefined]) === "abc");

  assert("HttpErrorはHTTPステータスだけ", reasonFromError(new HttpError(404), secrets) === "HTTP 404");
  assert("非JSONはステータス付きの定型文", reasonFromError(new HttpError(502, "non-json"), secrets) === "非JSONレスポンス（HTTP 502）");
  const te = new Error(`The operation was aborted https://cloud.umami.is/api/share/${SHARE_ID}`);
  te.name = "TimeoutError";
  assert("タイムアウトは定型文", reasonFromError(te, secrets) === "タイムアウト");
  const ne = new TypeError(`fetch failed for ${TOKEN}`);
  assert("ネットワークエラーは定型文（値を含めない）", reasonFromError(ne, secrets) === "通信エラー");
  const pe = new Error(`token missing in ${WEBSITE_ID}`);
  const r = reasonFromError(pe, secrets);
  assert("その他の例外は秘密情報を伏せる", !r.includes(WEBSITE_ID) && r.includes("***"));
}

// ---------------------------------------------------------------------------
// 再試行の方針（fetchWithRetry と同じ: ネットワークエラー・5xxだけ再試行、429は再試行しない）
// ---------------------------------------------------------------------------
console.log("\n[再試行の方針]");
{
  const originalFetch = globalThis.fetch;
  const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });
  function mock(seq) {
    let calls = 0;
    globalThis.fetch = async () => {
      const step = seq[Math.min(calls, seq.length - 1)];
      calls++;
      if (step instanceof Error) throw step;
      return step;
    };
    return () => calls;
  }
  const opts = { retryDelayMs: 1 };
  try {
    let count = mock([resp(500, "x"), resp(200, '{"a":1}')]);
    let data = await fetchJson("https://example.test/a", {}, opts);
    assert("5xxは再試行して成功する", data.a === 1 && count() === 2);

    count = mock([new TypeError("fetch failed"), resp(200, '{"a":2}')]);
    data = await fetchJson("https://example.test/a", {}, opts);
    assert("ネットワークエラーは再試行して成功する", data.a === 2 && count() === 2);

    count = mock([resp(429, "{}"), resp(200, '{"a":3}')]);
    await assertRejects("429は再試行せずHTTP 429で失敗", () => fetchJson("https://example.test/a", {}, opts),
      (e) => e instanceof HttpError && e.status === 429);
    assert("429のときの呼び出しは1回", count() === 1);

    count = mock([resp(404, "{}")]);
    await assertRejects("4xxは再試行しない", () => fetchJson("https://example.test/a", {}, opts),
      (e) => e instanceof HttpError && e.status === 404);
    assert("404のときの呼び出しは1回", count() === 1);

    count = mock([resp(503, "x")]);
    await assertRejects("5xxが続けば最大3回で失敗", () => fetchJson("https://example.test/a", {}, opts),
      (e) => e instanceof HttpError && e.status === 503);
    assert("5xxのときの呼び出しは3回", count() === 3);

    mock([resp(200, "<html>Bad Gateway</html>")]);
    await assertRejects("200でも非JSONは失敗（res.text()→JSON.parse()）", () => fetchJson("https://example.test/a", {}, opts),
      (e) => e instanceof HttpError && e.kind === "non-json");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// collectMetrics（一部の項目が失敗したときの errors）
// ---------------------------------------------------------------------------
console.log("\n[collectMetrics]");
{
  const now = Date.UTC(2026, 10, 22, 4, 0, 0);
  const logs = [];
  const log = (m) => logs.push(m);

  // Bluesky成功・Mastodon失敗(404)・Umami未設定
  const fetchJsonFn = async (url) => {
    if (url.includes("getProfile")) return { followersCount: 112 };
    if (url.includes("getAuthorFeed")) return { feed: [{ post: { likeCount: 1, repostCount: 1, replyCount: 1 } }] };
    if (url.includes("mastodon.social")) throw new HttpError(404);
    throw new Error("unexpected");
  };
  const r = await collectMetrics({ fetchJsonFn, env: {}, now, log });
  assert("8キーがすべて揃う", METRIC_KEYS.every((k) => k in r.metrics));
  assert("成功した値が入る", r.metrics.bluesky_followers === 112 && r.metrics.bluesky_engagement_15 === 3);
  assert("失敗した項目はnull", r.metrics.mastodon_followers === null && r.metrics.mastodon_engagement_15 === null);
  assert("失敗の理由はHTTPステータス", r.errors.mastodon_followers === "HTTP 404");
  assert("UMAMI_SHARE_IDが無ければUmami4項目が未設定", r.errors.umami_visitors_7d === "UMAMI_SHARE_IDが未設定" && r.errors.umami_suzuri_click_30d === "UMAMI_SHARE_IDが未設定");
  assert("measured_atはISO8601", r.measured_at === new Date(now).toISOString());
  assert("allFailedはfalse", r.allFailed === false);

  // Umami成功（トークン付きヘッダー・マスク）
  const seen = [];
  const masks = [];
  const fetchOk = async (url, headers) => {
    seen.push({ url, headers });
    if (url.includes("getProfile")) return { followersCount: 1 };
    if (url.includes("getAuthorFeed")) return { feed: [] };
    if (url.includes("accounts/lookup")) return { id: "9", followers_count: 2 };
    if (url.includes("/statuses")) return [];
    if (url.includes("/api/share/")) return { websiteId: WEBSITE_ID, token: TOKEN };
    if (url.includes("/stats")) return { visitors: url.includes(String(now - 7 * 86_400_000)) ? 10 : 40 };
    if (url.includes("/metrics")) return [{ x: "suzuri-click", y: url.includes(String(now - 7 * 86_400_000)) ? 1 : 5 }];
    throw new Error("unexpected");
  };
  const logs2 = [];
  const r2 = await collectMetrics({ fetchJsonFn: fetchOk, env: { UMAMI_SHARE_ID: SHARE_ID }, now, log: (m) => logs2.push(m), mask: (v) => masks.push(v) });
  assert("Umamiの4項目が取れる",
    r2.metrics.umami_visitors_7d === 10 && r2.metrics.umami_visitors_30d === 40 &&
    r2.metrics.umami_suzuri_click_7d === 1 && r2.metrics.umami_suzuri_click_30d === 5);
  assert("errorsは空", Object.keys(r2.errors).length === 0);
  const umamiCalls = seen.filter((s) => s.url.includes("/api/websites/"));
  assert("statsとmetricsにx-umami-share-tokenとx-umami-share-contextを付ける",
    umamiCalls.length === 4 && umamiCalls.every((s) => s.headers["x-umami-share-token"] === TOKEN && s.headers["x-umami-share-context"]));
  assert("共有ID・トークン・websiteIdをマスクに登録する", [SHARE_ID, TOKEN, WEBSITE_ID].every((v) => masks.includes(v)));
  assert("ログに秘密情報を出さない", !logs2.join("\n").includes(TOKEN) && !logs2.join("\n").includes(WEBSITE_ID) && !logs2.join("\n").includes(SHARE_ID));

  // 共有トークンでイベントが拒否された（403）
  const fetch403 = async (url, headers) => {
    if (url.includes("/metrics")) throw new HttpError(403);
    return fetchOk(url, headers);
  };
  const r3 = await collectMetrics({ fetchJsonFn: fetch403, env: { UMAMI_SHARE_ID: SHARE_ID }, now, log: () => {}, mask: () => {} });
  assert("イベントが403なら共有設定の可能性を理由にする", r3.errors.umami_suzuri_click_7d === "共有URLでイベントが非公開の可能性（HTTP 403）");

  // 理由に秘密情報が混ざる例外でも伏せる
  const fetchLeak = async (url, headers) => {
    if (url.includes("/stats")) throw new Error(`boom ${TOKEN} ${WEBSITE_ID} ${url}`);
    return fetchOk(url, headers);
  };
  const r4 = await collectMetrics({ fetchJsonFn: fetchLeak, env: { UMAMI_SHARE_ID: SHARE_ID }, now, log: () => {}, mask: () => {} });
  const reason = r4.errors.umami_visitors_7d;
  assert("理由にトークン・ID・URLが入らない",
    typeof reason === "string" && !reason.includes(TOKEN) && !reason.includes(WEBSITE_ID) && !reason.includes(SHARE_ID) && !reason.includes("startAt") && !reason.includes("http"));

  // 全項目失敗
  const r5 = await collectMetrics({ fetchJsonFn: async () => { throw new TypeError("fetch failed"); }, env: {}, now, log: () => {} });
  assert("全項目失敗ならallFailed", r5.allFailed === true && Object.values(r5.metrics).every((v) => v === null));
}

// ---------------------------------------------------------------------------
// コメント本文の形式
// ---------------------------------------------------------------------------
console.log("\n[buildCommentBody]");
{
  const result = {
    measured_at: "2026-11-22T04:00:00.000Z",
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, null])),
    errors: {},
  };
  result.metrics.bluesky_followers = 112;
  result.errors.umami_visitors_7d = "UMAMI_SHARE_IDが未設定";
  const body = buildCommentBody(result);
  const lines = body.split("\n");
  assert("1行目が目印", lines[0] === "<!-- growth-metrics v1 -->");
  assert("JSTの日時の見出し", lines[1] === "週次の集計（2026-11-22 13:00 JST）");
  assert("表に値が出る", body.includes("| Blueskyフォロワー | 112 |"));
  assert("表に計測不可と理由が出る", body.includes("| Umami訪問者（7日） | 計測不可（UMAMI_SHARE_IDが未設定） |"));
  const m = body.match(/```json\n(.+)\n```/);
  assert("jsonコードブロックがある", !!m);
  const parsed = m ? JSON.parse(m[1]) : null;
  assert("JSONにmeasured_at・metrics・errors",
    parsed && parsed.measured_at === result.measured_at && parsed.metrics.bluesky_followers === 112 &&
    parsed.errors.umami_visitors_7d === "UMAMI_SHARE_IDが未設定");
  assert("JSONのmetricsに8キーすべて（失敗はnull）", parsed && METRIC_KEYS.every((k) => k in parsed.metrics) && parsed.metrics.mastodon_followers === null);
  assert("本文は改行で終わる", body.endsWith("\n"));
}

// ---------------------------------------------------------------------------
console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
