#!/usr/bin/env node
/**
 * query-worker-logs.mjs - Cloudflare Workers Logs（console.logの内容）をキーワード・時間範囲で検索する
 *
 * 背景: fal.aiポーリング未完了等の障害調査のたびに、Cloudflareダッシュボードのログ確認をユーザーに
 * 依頼する必要があった。Cloudflare Workers Observability Telemetry Query APIを使い、ClaudeCodeセッション
 * （GitHub Actions経由）から直接ログを検索できるようにする。
 *
 * 参照: https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
 * 保持期間: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ （Free 3日 / Paid 7日）
 *
 * 2026-08-14にGitHub Actions（workflow_dispatch）から実際に実行し、Cloudflare APIから正常な
 * レスポンスを取得できることを確認済み。想定外のレスポンス構造の場合はprintEvents()が生データの
 * 一部を出力するので、必要に応じてパース処理を調整すること。
 *
 * 必要な環境変数:
 *   CLOUDFLARE_API_TOKEN   - デプロイ用トークン（checkCloudflareTokenが検証しているもの）で
 *                            追加スコープなしに認証成功することを確認済み
 *   CLOUDFLARE_ACCOUNT_ID
 *
 * 実行例:
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx node scripts/query-worker-logs.mjs --grep fal --since 6h
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx node scripts/query-worker-logs.mjs --request-id 9f2cd1a2088fa79b69202ac5c3d2e940 --since 3d
 *
 * オプション:
 *   --grep <文字列>        $metadata.message に対する部分一致フィルター（省略時は絞り込みなし）
 *   --request-id <ID>     $metadata.requestId に対する完全一致フィルター。1回のWorker呼び出し
 *                          （ctx.waitUntil()のバックグラウンド処理含む）の全ログ行を時系列で相関
 *                          させたいときに使う。--grep と併用可（AND条件）
 *   --since <期間>         現在時刻からの遡り期間。例: 30m, 6h, 2d（省略時は 3h）
 *   --limit <件数>         取得件数上限（省略時は 200）
 *   --service <名前>       $metadata.service フィルター（省略時は "anniversary-cat-worker"）
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_SERVICE = "anniversary-cat-worker";
const DEFAULT_SINCE = "3h";
const DEFAULT_LIMIT = 200;

/**
 * "30m" / "6h" / "2d" 形式の期間文字列をミリ秒に変換する。
 * @param {string} since
 * @returns {number}
 */
export function parseSinceMs(since) {
  const m = /^(\d+)(m|h|d)$/.exec(since ?? "");
  if (!m) {
    throw new Error(`--since の形式が不正です: "${since}"（例: 30m, 6h, 2d）`);
  }
  const n = Number(m[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n * unitMs;
}

/**
 * Workers Observability Telemetry Query API のリクエストボディを組み立てる。
 * @param {string} service - $metadata.service フィルター値
 * @param {string|null} grep - $metadata.message の部分一致フィルター値（nullなら未指定）
 * @param {number} sinceMs - 遡る期間（ミリ秒）
 * @param {number} limit - 取得件数上限
 * @param {number} [nowMs] - テスト用。省略時は Date.now()
 * @param {string|null} [requestId] - $metadata.requestId の完全一致フィルター値（nullなら未指定）
 * @returns {object}
 */
export function buildQueryBody(service, grep, sinceMs, limit, nowMs = Date.now(), requestId = null) {
  const filters = [
    { key: "$metadata.service", operation: "eq", type: "string", value: service },
  ];
  if (grep) {
    filters.push({ key: "$metadata.message", operation: "includes", type: "string", value: grep });
  }
  if (requestId) {
    filters.push({ key: "$metadata.requestId", operation: "eq", type: "string", value: requestId });
  }
  return {
    queryId: "claude-code-ad-hoc",
    timeframe: { from: nowMs - sinceMs, to: nowMs },
    view: "events",
    limit,
    dry: false,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters,
    },
  };
}

/**
 * コマンドライン引数をパースする。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { grep: null, since: DEFAULT_SINCE, limit: DEFAULT_LIMIT, service: DEFAULT_SERVICE, requestId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grep") args.grep = argv[++i] ?? null;
    else if (a === "--since") args.since = argv[++i] ?? DEFAULT_SINCE;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--service") args.service = argv[++i] ?? DEFAULT_SERVICE;
    else if (a === "--request-id") args.requestId = argv[++i] ?? null;
  }
  return args;
}

async function queryLogs(accountId, apiToken, body) {
  const res = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const resText = await res.text();
  let data;
  try { data = JSON.parse(resText); } catch {
    throw new Error(`[cf-logs] 非JSONレスポンス: status=${res.status} body=${resText.slice(0, 200)}`);
  }
  if (!res.ok || data.success === false) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`[cf-logs] 認証エラー（トークンにWorkers Observability読み取り権限がない可能性）: status=${res.status} ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
    }
    throw new Error(`[cf-logs] エラー: status=${res.status} ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
  }
  return data;
}

function printEvents(data) {
  const events = data?.result?.events?.events;
  if (!Array.isArray(events)) {
    console.warn("[cf-logs] 想定外のレスポンス構造です。生データの先頭を出力します:");
    console.warn(JSON.stringify(data).slice(0, 1000));
    return;
  }
  if (events.length === 0) {
    console.log("[cf-logs] 該当ログなし");
    return;
  }
  for (const ev of events) {
    const ts = new Date(ev.timestamp ?? ev.$metadata?.startTime ?? 0).toISOString();
    const level = ev.$metadata?.level ?? "";
    const message = ev.$metadata?.message ?? ev.source ?? "";
    const requestId = ev.$metadata?.requestId ?? "";
    console.log(`${ts} [${level}]${requestId ? ` reqId=${requestId}` : ""} ${message}`);
  }
  console.log(`\n[cf-logs] ${events.length}件`);
}

async function main() {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    console.error("[cf-logs] CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID の環境変数が必要です");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const sinceMs = parseSinceMs(args.since);
  const body = buildQueryBody(args.service, args.grep, sinceMs, args.limit, Date.now(), args.requestId);
  console.log(`[cf-logs] クエリ実行: service=${args.service} grep=${args.grep ?? "(なし)"} requestId=${args.requestId ?? "(なし)"} since=${args.since} limit=${args.limit}`);
  const data = await queryLogs(accountId, apiToken, body);
  printEvents(data);
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((e) => {
    console.error(`[cf-logs] エラー: ${e.message}`);
    process.exit(1);
  });
}
