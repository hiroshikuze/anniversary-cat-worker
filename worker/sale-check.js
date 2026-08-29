/**
 * worker/sale-check.js - SUZURIニュース一覧からセール記事を自動検知（2026-08追加）
 *
 * 毎日1回Cronで実行し、新しいセール関連記事を検知したらGeminiで構造化抽出し、
 * Discordに通知する。worker/sale.jsの_currentSaleへの反映は自動化せず、
 * 人間・Claude Codeセッションによるレビュー後の手動反映とする（誤検知・誤抽出が
 * そのまま本番のセールバナー・Bot投稿に反映されるリスクを避けるため。詳細は
 * architecture.mdの「SUZURIセール自動検知Cron」参照）。
 */

import { fetchWithRetry } from "./http-utils.js";
import { recordCpuCheckpoint, _deferOrAwait, selectBestModel, GEMINI_BASE } from "./index.js";

const NEWS_URL             = "https://suzuri.jp/media/category/news/";
const LAST_NOTIFIED_KV_KEY = "sale-check:last-notified";
const LAST_NOTIFIED_TTL    = 60 * 24 * 60 * 60; // 60日

/**
 * ニュース一覧HTMLから、直近のセール関連記事URLを抽出する（純粋関数）。
 * 一覧は新着順（上から新しい順）に並んでいる前提で、スラッグに"sale"を含む
 * 最初の記事を返す。見つからない場合はnull。
 */
export function extractLatestSaleArticleUrl(html) {
  const matches = [...(html ?? "").matchAll(/href="(https:\/\/suzuri\.jp\/media\/journal_[^"]+)"/g)];
  for (const [, url] of matches) {
    if (/sale/i.test(url)) return url;
  }
  return null;
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

/** Discord通知用メッセージを組み立てる（純粋関数） */
export function buildSaleCandidateMessage(saleInfo, articleUrl) {
  const itemLines = (saleInfo.items ?? [])
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
 * SUZURIニュース一覧を1日1回チェックし、新しいセール関連記事を検知したら
 * Gemini構造化抽出→Discord通知を行う。既存のBot Cronとは別のscheduled()
 * invocationとして呼ばれる（独立したCPU時間予算を持つ）。
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
    const res = await fetchWithRetry(NEWS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`status=${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn(`[sale-check] ニュース一覧取得失敗: ${e.message}`);
    await notifyFn?.(
      env.DISCORD_WEBHOOK_URL,
      `⚠️ SUZURIセールチェック失敗（ニュース一覧取得エラー）: ${e.message}\n手動確認をお願いします: ${NEWS_URL}`,
      "⚠️"
    );
    return;
  }

  const articleUrl = extractLatestSaleArticleUrl(html);
  if (!articleUrl) {
    console.log("[sale-check] セール関連記事が見つかりませんでした（通常運用）");
    return;
  }

  const lastNotified = kv ? await kv.get(LAST_NOTIFIED_KV_KEY) : null;
  if (articleUrl === lastNotified) {
    console.log(`[sale-check] 既知の記事のためスキップ url=${articleUrl}`);
    return;
  }

  console.log(`[sale-check] 新しい記事を検知 url=${articleUrl}`);

  if (!env.GEMINI_API_KEY) {
    console.warn("[sale-check] GEMINI_API_KEY未設定のため抽出をスキップ");
    return;
  }

  const tExtractStart = performance.now();
  let saleInfo;
  try {
    const res = await fetchWithRetry(articleUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`status=${res.status}`);
    const articleHtml = await res.text();
    saleInfo = await extractSaleInfoWithGemini(htmlToPlainText(articleHtml), env.GEMINI_API_KEY, kv, env.DISCORD_WEBHOOK_URL);
  } catch (e) {
    console.warn(`[sale-check] 記事取得・Gemini抽出失敗: ${e.message}`);
    await notifyFn?.(
      env.DISCORD_WEBHOOK_URL,
      `⚠️ SUZURIセール候補を検知しましたが構造化抽出に失敗しました。手動確認をお願いします: ${articleUrl}`,
      "⚠️"
    );
    return;
  } finally {
    await _deferOrAwait(recordCpuCheckpoint("sale-check-extract", performance.now() - tExtractStart, kv), ctx);
  }

  if (!saleInfo.isSale) {
    console.log(`[sale-check] セール記事ではないと判定 url=${articleUrl}`);
    // セール以外のニュース記事もKVに記録し、翌日以降の無駄な再抽出を防ぐ
    if (kv) await kv.put(LAST_NOTIFIED_KV_KEY, articleUrl, { expirationTtl: LAST_NOTIFIED_TTL });
    return;
  }

  // Discord通知を先に送り、KV書き込みはその後（自己修復的リトライのため。詳細はarchitecture.md参照）
  await notifyFn?.(env.DISCORD_WEBHOOK_URL, buildSaleCandidateMessage(saleInfo, articleUrl), "🏷️");
  if (kv) await kv.put(LAST_NOTIFIED_KV_KEY, articleUrl, { expirationTtl: LAST_NOTIFIED_TTL });
  console.log(`[sale-check] Discord通知完了 url=${articleUrl}`);
}
