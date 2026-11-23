#!/usr/bin/env node
/**
 * growth-metrics.mjs - 成長ループの集計（Bluesky・Mastodon・Umami）とIssueへのコメント
 *
 * GitHub Actions（.github/workflows/growth-metrics.yml）から週1回実行する:
 *   node scripts/growth-metrics.mjs
 * ローカル確認（Issueへ投稿せず、コメント本文を標準出力に出す）:
 *   node scripts/growth-metrics.mjs --dry-run
 *
 * 仕様は .claude/docs/architecture/growth-metrics.md 参照。
 *
 * 環境変数:
 *   UMAMI_SHARE_ID   … Umamiの共有URLのID（任意。無ければUmamiの4項目は計測不可）
 *   GITHUB_TOKEN     … Issueへのコメント用（--dry-run では不要）
 *   GITHUB_REPOSITORY … owner/repo（Actionsが自動で設定）
 *
 * ログ・コメントに、UMAMI_SHARE_ID・トークン・websiteId・UmamiのURLを出さない。
 */

import { fileURLToPath } from "node:url";
import { fetchWithRetry } from "../worker/http-utils.js";

export const METRIC_KEYS = [
  "bluesky_followers",
  "bluesky_engagement_15",
  "mastodon_followers",
  "mastodon_engagement_15",
  "umami_visitors_7d",
  "umami_visitors_30d",
  "umami_suzuri_click_7d",
  "umami_suzuri_click_30d",
];

const METRIC_LABELS = {
  bluesky_followers:      "Blueskyフォロワー",
  bluesky_engagement_15:  "Bluesky直近15投稿の反応（いいね＋リポスト＋返信）",
  mastodon_followers:     "Mastodonフォロワー",
  mastodon_engagement_15: "Mastodon直近15投稿の反応（お気に入り＋ブースト＋返信）",
  umami_visitors_7d:      "Umami訪問者（7日）",
  umami_visitors_30d:     "Umami訪問者（30日）",
  umami_suzuri_click_7d:  "suzuri-click（7日）",
  umami_suzuri_click_30d: "suzuri-click（30日）",
};

const BLUESKY_ACTOR  = "nyanmusu.bsky.social";
const BLUESKY_API    = "https://public.api.bsky.app/xrpc";
const MASTODON_BASE  = "https://mastodon.social";
const MASTODON_ACCT  = "nyanmusu";
// Umami Cloudの共有ページが使うAPIのベース。us は地域（地域が変わると gateway-eu になる可能性がある）
const UMAMI_BASE     = "https://gateway-us.umami.is";
const UMAMI_EVENT    = "suzuri-click";
const FEED_LIMIT     = 15;
const DAY_MS         = 86_400_000;
const TIMEOUT_MS     = 15_000;
const MARKER         = "<!-- growth-metrics v1 -->";
export const ISSUE_TITLE = "成長ループ：週次の集計";
export const ISSUE_LABEL = "growth:metrics";

// ---------------------------------------------------------------------------
// レスポンスから値を取り出す（純粋関数）
// ---------------------------------------------------------------------------

function requireNumber(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}が数値ではない`);
  return v;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseBlueskyFollowers(profile) {
  return requireNumber(profile?.followersCount, "followersCount");
}

/** 自分の投稿だけを数える（reason付き＝他人の投稿の再投稿は除く） */
export function sumBlueskyEngagement(feedJson) {
  if (!Array.isArray(feedJson?.feed)) throw new Error("feedが配列ではない");
  return feedJson.feed
    .filter((item) => !item.reason)
    .reduce((sum, { post = {} }) => sum + num(post.likeCount) + num(post.repostCount) + num(post.replyCount), 0);
}

export function parseMastodonAccount(acc) {
  if (typeof acc?.id !== "string" || !acc.id) throw new Error("idが無い");
  return { id: acc.id, followers: requireNumber(acc.followers_count, "followers_count") };
}

/** 自分の投稿だけを数える（reblog付き＝他人の投稿のブーストは除く） */
export function sumMastodonEngagement(statuses) {
  if (!Array.isArray(statuses)) throw new Error("statusesが配列ではない");
  return statuses
    .filter((s) => !s.reblog)
    .reduce((sum, s) => sum + num(s.favourites_count) + num(s.reblogs_count) + num(s.replies_count), 0);
}

export function parseUmamiShare(share) {
  if (typeof share?.websiteId !== "string" || !share.websiteId) throw new Error("共有情報にwebsiteIdが無い");
  if (typeof share?.token !== "string" || !share.token) throw new Error("共有情報にtokenが無い");
  return { websiteId: share.websiteId, token: share.token };
}

/** 現行版は visitors が数値、旧版は { value, prev } */
export function parseUmamiVisitors(stats) {
  const v = stats?.visitors;
  if (typeof v === "number") return requireNumber(v, "visitors");
  if (v && typeof v === "object") return requireNumber(v.value, "visitors.value");
  throw new Error("visitorsが無い");
}

export function parseUmamiEventCount(metrics, eventName) {
  if (!Array.isArray(metrics)) throw new Error("metricsが配列ではない");
  const hit = metrics.find((m) => m?.x === eventName);
  return hit ? requireNumber(hit.y, "y") : 0;
}

export function buildRange(nowMs, days) {
  return { startAt: nowMs - days * DAY_MS, endAt: nowMs };
}

// ---------------------------------------------------------------------------
// 失敗理由（秘密情報を含めない）
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, kind = "status") {
    super(kind === "non-json" ? `非JSONレスポンス（HTTP ${status}）` : `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.kind = kind;
  }
}

/** URLを丸ごと伏せ、既知の秘密情報を *** に置き換える */
export function redactSecrets(text, secrets = []) {
  let out = String(text).replace(/https?:\/\/\S+/g, "<url>");
  for (const s of secrets) {
    if (typeof s === "string" && s) out = out.split(s).join("***");
  }
  return out;
}

export function reasonFromError(err, secrets = []) {
  if (err instanceof HttpError) return err.message;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "タイムアウト";
  if (err instanceof TypeError) return "通信エラー";
  return redactSecrets(err?.message ?? String(err), secrets).slice(0, 120);
}

// ---------------------------------------------------------------------------
// 通信（fetchWithRetry: ネットワークエラー・5xxだけ再試行、429は再試行しない）
// ---------------------------------------------------------------------------

/**
 * GETしてJSONを返す。エラーメッセージにURLは入れない（UmamiのURLにwebsiteIdが含まれるため）。
 * retryDelayMs はテスト用（本番は fetchWithRetry の既定 1000ms）。
 */
export async function fetchJson(url, headers = {}, { retryDelayMs, method = "GET", body } = {}) {
  const options = {
    method,
    headers: { Accept: "application/json", "User-Agent": "growth-metrics", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers["Content-Type"] = "application/json";
  }
  const res = await fetchWithRetry(url, options, 3, retryDelayMs);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new HttpError(res.status, "non-json");
  }
  if (!res.ok) throw new HttpError(res.status);
  return data;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/**
 * すべての指標を集める。1項目の失敗で全体を止めない。
 * deps.fetchJsonFn(url, headers) はテスト用に差し替え可能。
 * deps.mask(value) は、ログで伏せる値を登録する（Actionsでは ::add-mask::）。
 */
export async function collectMetrics({
  fetchJsonFn = fetchJson,
  env = process.env,
  now = Date.now(),
  log = console.log,
  // ::add-mask:: はActionsの中でだけ出す（Actionsの外では値がそのまま表示されるため）
  mask = (v) => { if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${v}`); },
} = {}) {
  const metrics = Object.fromEntries(METRIC_KEYS.map((k) => [k, null]));
  const errors = {};
  const secrets = [];
  const shareId = env.UMAMI_SHARE_ID || "";
  if (shareId) { secrets.push(shareId); mask(shareId); }

  const fail = (keys, err, reasonOverride) => {
    const reason = reasonOverride ?? reasonFromError(err, secrets);
    for (const k of keys) { metrics[k] = null; errors[k] = reason; }
    log(`[growth-metrics] 計測不可: ${keys.join(", ")} (${reason})`);
  };
  const ok = (key, value) => { metrics[key] = value; log(`[growth-metrics] ${key} = ${value}`); };

  // Bluesky
  try {
    ok("bluesky_followers", parseBlueskyFollowers(
      await fetchJsonFn(`${BLUESKY_API}/app.bsky.actor.getProfile?actor=${BLUESKY_ACTOR}`, {})));
  } catch (e) { fail(["bluesky_followers"], e); }
  try {
    ok("bluesky_engagement_15", sumBlueskyEngagement(
      await fetchJsonFn(`${BLUESKY_API}/app.bsky.feed.getAuthorFeed?actor=${BLUESKY_ACTOR}&limit=${FEED_LIMIT}`, {})));
  } catch (e) { fail(["bluesky_engagement_15"], e); }

  // Mastodon
  let mastoId = null;
  try {
    const acc = parseMastodonAccount(await fetchJsonFn(`${MASTODON_BASE}/api/v1/accounts/lookup?acct=${MASTODON_ACCT}`, {}));
    mastoId = acc.id;
    ok("mastodon_followers", acc.followers);
  } catch (e) { fail(["mastodon_followers", "mastodon_engagement_15"], e); }
  if (mastoId) {
    try {
      ok("mastodon_engagement_15", sumMastodonEngagement(
        await fetchJsonFn(`${MASTODON_BASE}/api/v1/accounts/${mastoId}/statuses?limit=${FEED_LIMIT}`, {})));
    } catch (e) { fail(["mastodon_engagement_15"], e); }
  }

  // Umami（共有URLのトークン方式。URL・ID・トークンはログに出さない）
  const visitorKeys = { 7: "umami_visitors_7d", 30: "umami_visitors_30d" };
  const clickKeys = { 7: "umami_suzuri_click_7d", 30: "umami_suzuri_click_30d" };
  const umamiKeys = [...Object.values(visitorKeys), ...Object.values(clickKeys)];
  if (!shareId) {
    fail(umamiKeys, null, "UMAMI_SHARE_IDが未設定");
  } else {
    let share = null;
    try {
      share = parseUmamiShare(await fetchJsonFn(`${UMAMI_BASE}/api/share/${encodeURIComponent(shareId)}`, {}));
      secrets.push(share.token, share.websiteId);
      mask(share.token);
      mask(share.websiteId);
    } catch (e) { fail(umamiKeys, e); }
    if (share) {
      const headers = { "x-umami-share-token": share.token, "x-umami-share-context": "1" };
      const base = `${UMAMI_BASE}/api/websites/${encodeURIComponent(share.websiteId)}`;
      for (const days of [7, 30]) {
        const { startAt, endAt } = buildRange(now, days);
        try {
          ok(visitorKeys[days], parseUmamiVisitors(await fetchJsonFn(`${base}/stats?startAt=${startAt}&endAt=${endAt}`, headers)));
        } catch (e) { fail([visitorKeys[days]], e); }
        try {
          ok(clickKeys[days], parseUmamiEventCount(
            await fetchJsonFn(`${base}/metrics?type=event&startAt=${startAt}&endAt=${endAt}`, headers), UMAMI_EVENT));
        } catch (e) {
          const denied = e instanceof HttpError && (e.status === 401 || e.status === 403);
          fail([clickKeys[days]], e, denied ? `共有URLでイベントが非公開の可能性（HTTP ${e.status}）` : undefined);
        }
      }
    }
  }

  const allFailed = METRIC_KEYS.every((k) => metrics[k] === null);
  return { measured_at: new Date(now).toISOString(), metrics, errors, allFailed };
}

// ---------------------------------------------------------------------------
// コメント本文
// ---------------------------------------------------------------------------

function formatJst(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function buildCommentBody({ measured_at, metrics, errors }) {
  const rows = METRIC_KEYS.map((k) => {
    const v = metrics[k];
    const cell = v === null || v === undefined ? `計測不可（${errors[k] ?? "理由不明"}）` : String(v);
    return `| ${METRIC_LABELS[k]} | ${cell} |`;
  });
  const json = JSON.stringify({
    measured_at,
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, metrics[k] ?? null])),
    errors,
  });
  return [
    MARKER,
    `週次の集計（${formatJst(measured_at)} JST）`,
    "",
    "| 指標 | 値 |",
    "| --- | --- |",
    ...rows,
    "",
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GitHub（Issueを探す・作る・コメントする）
// ---------------------------------------------------------------------------

async function github(path, token, { method = "GET", body } = {}) {
  return fetchJson(`https://api.github.com/${path}`, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }, { method, body });
}

/**
 * ラベル growth:metrics の開いているIssueを1件探し、無ければ作ってコメントする。
 * コメント投稿も fetchWithRetry で再試行する。5xxの再試行で同じコメントが2件になる可能性はあるが、
 * 成長ループのスキルは最新の1件だけを使うため害はない。
 */
export async function postToIssue(body, { token, repo, log = console.log }) {
  const issues = await github(`repos/${repo}/issues?labels=${encodeURIComponent(ISSUE_LABEL)}&state=open&per_page=10`, token);
  let issue = Array.isArray(issues) ? issues.find((i) => !i.pull_request) : null;
  if (!issue) {
    try {
      await github(`repos/${repo}/labels`, token, { method: "POST", body: { name: ISSUE_LABEL, color: "d4a843" } });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 422)) throw e; // 422 = すでにある
    }
    issue = await github(`repos/${repo}/issues`, token, {
      method: "POST",
      body: { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: "成長ループ（`.claude/growth/`）が読む週次の集計です。GitHub Actionsのワークフロー`growth-metrics.yml`がコメントします。仕様は`.claude/docs/architecture/growth-metrics.md`参照。" },
    });
    log(`[growth-metrics] 集計Issueを作成: #${issue.number}`);
  }
  const comment = await github(`repos/${repo}/issues/${issue.number}/comments`, token, { method: "POST", body: { body } });
  log(`[growth-metrics] コメントしました: #${issue.number} ${comment.html_url ?? ""}`);
  return issue.number;
}

// ---------------------------------------------------------------------------
// エントリーポイント
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await collectMetrics();
  const body = buildCommentBody(result);

  if (dryRun) {
    console.log("[growth-metrics] --dry-run: Issueへは投稿しません。コメント本文:\n");
    console.log(body);
  } else {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
      console.error("[growth-metrics] GITHUB_TOKENまたはGITHUB_REPOSITORYが未設定です");
      process.exit(1);
    }
    try {
      await postToIssue(body, { token, repo });
    } catch (e) {
      console.error(`[growth-metrics] Issueへのコメントに失敗: ${reasonFromError(e)}`);
      process.exit(1);
    }
  }

  if (result.allFailed) {
    console.error("[growth-metrics] すべての項目が計測不可でした");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
