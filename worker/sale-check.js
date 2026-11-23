/**
 * worker/sale-check.js - SUZURIセール一覧からセール記事を自動検知（2026-08追加・2026-11に取得元を変更）
 *
 * 毎日1回Cronで実行し、新しいセール関連記事を検知したらGeminiで構造化抽出し、
 * Discordに通知する。worker/sale.jsの_currentSaleへの反映は自動化せず、
 * 人間・Claude Codeセッションによるレビュー後の手動反映とする（誤検知・誤抽出が
 * そのまま本番のセールバナー・Bot投稿に反映されるリスクを避けるため。詳細は
 * architecture.mdの「SUZURIセール自動検知Cron」参照）。
 */

import { fetchWithRetry } from "./http-utils.js";
import { recordCpuCheckpoint, _deferOrAwait, selectBestModel, GEMINI_BASE } from "./index.js";

// 2026-11: 取得元をニュース一覧（category/news/）からセール一覧（category/sale/）へ変更した。
// category/news/には運営告知しか載らず、ブラックフライデー等のセール記事が一覧に出ていなかった。
// 詳細は.claude/docs/architecture/sale-check-and-cleanup.mdの「検知漏れ（2026-11）」参照
const SALE_LIST_URL        = "https://suzuri.jp/media/category/sale/";
const SITE_ORIGIN          = "https://suzuri.jp";
const PROCESSED_KV_KEY     = "sale-check:processed";     // 処理済み記事URLのJSON配列（新しい順）
const LEGACY_KV_KEY        = "sale-check:last-notified"; // 旧方式（直近1件のURL）。移行用に読むだけで書かない
const PROCESSED_TTL        = 60 * 24 * 60 * 60;          // 60日
const PROCESSED_MAX        = 20;                         // 処理済みURLの保持件数
const ARTICLES_PER_RUN     = 3;                          // 1回のCronで見る記事数（サブリクエスト・Gemini呼び出しの上限対策）

/**
 * セール一覧HTMLから、記事URLを一覧上の並び（新着順）のまま上位limit件抽出する（純粋関数）。
 * 絶対URL（https://suzuri.jp/media/journal_…）と相対パス（/media/journal_…）の両方に対応し、
 * 絶対URLへ正規化して重複を除く。スラッグのキーワード判定はしない（セールかどうかはGeminiのisSaleで判定する。
 * `black_friday`のように`sale`を含まない命名を見逃さないため・2026-11）。
 * @param {string|null|undefined} html
 * @param {number} [limit]
 * @returns {string[]}
 */
export function extractRecentArticleUrls(html, limit = ARTICLES_PER_RUN) {
  if (!(limit > 0)) return [];
  const urls = [];
  for (const [, slug] of (html ?? "").matchAll(/href="(?:https:\/\/suzuri\.jp)?\/media\/(journal_[^"\/?#]+)/g)) {
    const url = `${SITE_ORIGIN}/media/${slug}/`;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

/** KVから処理済みURLの一覧を読む（新配列キー＋旧キーの単一URL。旧キーは移行用に既読として扱う） */
async function loadProcessedUrls(kv) {
  if (!kv) return [];
  const urls = [];
  try {
    const raw = await kv.get(PROCESSED_KV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) urls.push(...arr.filter(u => typeof u === "string"));
  } catch {
    // 壊れたJSONは空として扱う（再判定されるだけで実害は小さい）
  }
  const legacy = await kv.get(LEGACY_KV_KEY);
  if (legacy) urls.push(legacy);
  return urls;
}

/** Gemini構造化抽出用プロンプト構築（純粋関数） */
function buildSaleExtractPrompt(articleText) {
  return `以下はSUZURI（グッズ販売サービス）のお知らせ記事本文です。セールの詳細を抽出してJSON形式で出力してください。
出力は以下のスキーマのJSONのみ（説明文不要）:
{
  "isSale": boolean,
  "saleName": string,
  "startDisplay": string,
  "endDisplay": string,
  "items": [
    { "name": string, "discountYen": number, "included": boolean }
  ]
}
対象商品は「Tシャツ」「ステッカー」「缶バッジ」「アクリルキーホルダー」の4種のみ。
それぞれ記事内でセール対象と明記されているか（included）・割引額（discountYen、対象外の場合は0）を判定すること。
セール告知記事でない場合はisSaleをfalseにし、他のフィールドは空文字・空配列でよい。

記事本文:
${(articleText ?? "").slice(0, 8000)}`;
}

/**
 * Geminiで記事本文からセール情報を構造化抽出する（handleResearch()と同じres.text()+JSON.parse()パターン）。
 * モデル名は固定文字列で書かず、worker/index.jsのselectBestModel()で動的に選択する
 * （2026-08: gemini-2.5-flash-liteを固定文字列で書いていたところ、初回Cron発火時にモデル廃止(404)で
 * 抽出が失敗した。revision_log.md参照）。
 */
async function extractSaleInfoWithGemini(articleText, apiKey, kv, webhookUrl) {
  const model = await selectBestModel(apiKey, kv, webhookUrl);
  const res = await fetchWithRetry(
    `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        contents:         [{ parts: [{ text: buildSaleExtractPrompt(articleText) }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const resText = await res.text();
  let data;
  try {
    data = JSON.parse(resText);
  } catch (e) {
    throw new Error(`[sale-check] Gemini非JSONレスポンス: status=${res.status} body=${resText.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(`[sale-check] Geminiエラー: status=${res.status} message=${data.error?.message ?? JSON.stringify(data)}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("[sale-check] Geminiレスポンスにテキストが含まれません");
  return JSON.parse(text);
}

/**
 * _currentSaleに入れる値の案内文を組み立てる（純粋関数・2026-11追加・Bug#51）。
 * Geminiの抽出結果からの提案であり、反映前に人間が記事で確認する前提は変わらない。
 * 判定できない値は断定せず「記事で確認」と書く。
 */
function buildCurrentSaleHint(items) {
  const included = items.filter(i => i.included && Number(i.discountYen) > 0);
  const maxYen = included.length > 0 ? Math.max(...included.map(i => Number(i.discountYen))) : null;
  const sticker = items.find(i => typeof i.name === "string" && i.name.includes("ステッカー"));
  const discountHint = maxYen !== null
    ? `discountYen: ${maxYen}（対象商品の最大額）`
    : "discountYen: 対象商品の最大額を記事で確認してください";
  const stickerHint = !sticker
    ? "stickerExcluded: ステッカーが対象かを記事で確認してください（対象外ならtrue）"
    : sticker.included
      ? "stickerExcluded: false（ステッカーも対象）"
      : "stickerExcluded: true（ステッカーは対象外。文言に「ステッカーを除く」が付く）";
  return `入れる値の案内（記事で確認してから反映）: ${discountHint} / ${stickerHint}`;
}

/** Discord通知用メッセージを組み立てる（純粋関数） */
export function buildSaleCandidateMessage(saleInfo, articleUrl) {
  const items = Array.isArray(saleInfo.items) ? saleInfo.items : [];
  const itemLines = items
    .map(i => (i.included ? `${i.name} ${i.discountYen}円引き` : `${i.name} 対象外`))
    .join(" / ");
  return [
    "🏷️ SUZURIセール候補を検知しました",
    `セール名: ${saleInfo.saleName || "(不明)"}`,
    `期間: ${saleInfo.startDisplay || "?"} 〜 ${saleInfo.endDisplay || "?"}`,
    itemLines ? `対象: ${itemLines}` : null,
    `元記事: ${articleUrl}`,
    "",
    "worker/sale.js の _currentSale を更新してください（Claude Codeセッションで対応可）。",
    buildCurrentSaleHint(items),
  ].filter(Boolean).join("\n");
}

/** HTMLからおおまかに本文テキストを抽出する（厳密なパースは不要・Geminiへの入力用） */
function htmlToPlainText(html) {
  return (html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SUZURIセール一覧を1日1回チェックし、未処理の記事（上位ARTICLES_PER_RUN件まで）をGeminiで
 * セールかどうか判定・構造化抽出し、セール記事ならDiscordへ通知する。既存のBot Cronとは別の
 * scheduled() invocationとして呼ばれる（独立したCPU時間予算を持つ）。
 * @param {object} env
 * @param {object|null} ctx - Workers ExecutionContext（recordCpuCheckpointの背景化用）
 * @param {(webhookUrl: string, message: string, emoji?: string) => Promise<void>} notifyFn
 *   worker/bot.jsのnotifyDiscord()。sale-check.jsからbot.jsへの新規importを増やさないため、
 *   呼び出し元（worker/index.js）から関数として注入する
 */
export async function checkForNewSale(env, ctx, notifyFn) {
  const kv = env.RATE_KV ?? null;

  let html;
  try {
    const res = await fetchWithRetry(SALE_LIST_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`status=${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn(`[sale-check] セール一覧取得失敗: ${e.message}`);
    await notifyFn?.(
      env.DISCORD_WEBHOOK_URL,
      `⚠️ SUZURIセールチェック失敗（セール一覧取得エラー）: ${e.message}\n手動確認をお願いします: ${SALE_LIST_URL}`,
      "⚠️"
    );
    return;
  }

  const recentUrls = extractRecentArticleUrls(html);
  if (recentUrls.length === 0) {
    // category/sale/には常に過去の記事が並ぶため、0件はSUZURI側のHTML変更を疑う（testing.mdのログパターン参照）
    console.warn("[sale-check] 一覧に記事リンクが見つかりません（ページ構造の変更を確認）");
    return;
  }

  const processed = await loadProcessedUrls(kv);
  const unprocessed = recentUrls.filter(u => !processed.includes(u));
  if (unprocessed.length === 0) {
    console.log("[sale-check] 新しい記事はありません（すべて処理済み）");
    return;
  }

  console.log(`[sale-check] 未処理の記事を検知 count=${unprocessed.length} urls=${unprocessed.join(",")}`);

  if (!env.GEMINI_API_KEY) {
    console.warn("[sale-check] GEMINI_API_KEY未設定のため抽出をスキップ");
    return;
  }

  // 新しい記事から順に判定する。記事ごとの失敗は他の記事の処理を止めない
  const newlyProcessed = [];
  for (const articleUrl of unprocessed) {
    const tExtractStart = performance.now();
    let saleInfo;
    try {
      const res = await fetchWithRetry(articleUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`status=${res.status}`);
      const articleHtml = await res.text();
      saleInfo = await extractSaleInfoWithGemini(htmlToPlainText(articleHtml), env.GEMINI_API_KEY, kv, env.DISCORD_WEBHOOK_URL);
    } catch (e) {
      // 処理済みにしない＝翌日また再試行される
      console.warn(`[sale-check] 記事取得・Gemini抽出失敗 url=${articleUrl}: ${e.message}`);
      await notifyFn?.(
        env.DISCORD_WEBHOOK_URL,
        `⚠️ SUZURIセール候補を検知しましたが構造化抽出に失敗しました。手動確認をお願いします: ${articleUrl}`,
        "⚠️"
      );
      continue;
    } finally {
      await _deferOrAwait(recordCpuCheckpoint("sale-check-extract", performance.now() - tExtractStart, kv), ctx);
    }

    if (!saleInfo.isSale) {
      console.log(`[sale-check] セール記事ではないと判定 url=${articleUrl}`);
      // セール以外の記事（新商品・運営告知等）も処理済みにし、翌日以降の無駄な再抽出を防ぐ
      newlyProcessed.push(articleUrl);
      continue;
    }

    // Discord通知を先に送り、処理済みへの追加（KV書き込み）はその後（自己修復的リトライのため。詳細はarchitecture.md参照）
    await notifyFn?.(env.DISCORD_WEBHOOK_URL, buildSaleCandidateMessage(saleInfo, articleUrl), "🏷️");
    newlyProcessed.push(articleUrl);
    console.log(`[sale-check] Discord通知完了 url=${articleUrl}`);
  }

  if (kv && newlyProcessed.length > 0) {
    const merged = [...newlyProcessed, ...processed.filter(u => !newlyProcessed.includes(u))].slice(0, PROCESSED_MAX);
    await kv.put(PROCESSED_KV_KEY, JSON.stringify(merged), { expirationTtl: PROCESSED_TTL });
  }
}
