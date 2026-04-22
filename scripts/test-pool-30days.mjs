#!/usr/bin/env node
/**
 * test-pool-30days.mjs - 事前リサーチプール方式の複数日シミュレーション
 *
 * 過去N日分の記念日候補を実際にGemini APIで生成し、
 * フィルタリング・重複除去・季節補充のシミュレーションを行う。
 *
 * 実行方法:
 *   GEMINI_API_KEY=xxx node scripts/test-pool-30days.mjs           # 30日分
 *   GEMINI_API_KEY=xxx node scripts/test-pool-30days.mjs --days 7  # 7日分
 *
 * 目的:
 *   - google-search-fallback フィルタリングの効果確認
 *   - 1日あたりのプール件数（フィルタ後）の統計
 *   - 季節補充が発動する頻度の確認
 *   - 残存テーマの目視確認（ハルシネーション・不適切テーマ混入チェック）
 *
 * 所要時間の目安（並列10件）:
 *   7日  → 約 2分
 *   30日 → 約 8分
 */

import { handleResearch, filterAndDedupePool, getSeasonalFlower } from "../worker/index.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY が設定されていません");
  process.exit(1);
}

const daysArg = process.argv.indexOf("--days");
const DAYS     = daysArg !== -1 ? parseInt(process.argv[daysArg + 1], 10) : 30;
const PARALLEL = 10;

// 過去N日分の日付（JST基準）を新しい日順で返す
function getPastDates(n) {
  const dates = [];
  const nowJst = Date.now() + 9 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    const d   = new Date(nowJst - i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10); // UTC上でのUTCSlice ← JST補正後なので正しい
    dates.push(iso);
  }
  return dates;
}

function toJapaneseDate(isoDate) {
  const [yyyy, mm, dd] = isoDate.split("-").map(Number);
  return `${yyyy}年${mm}月${dd}日`;
}

// sourceUrlKind を絵文字に変換（目視判別用）
function kindEmoji(kind) {
  switch (kind) {
    case "grounding":              return "✅";
    case "json":                   return "✅";
    case "vertexaisearch-skipped": return "🔗";
    case "seasonal-flower-fallback": return "🌸";
    default:                       return "❓";
  }
}

const CALL_TIMEOUT_MS = 45_000;

async function testOneDay(isoDate) {
  const dateStr = toJapaneseDate(isoDate);

  const results = await Promise.allSettled(
    Array.from({ length: PARALLEL }, () =>
      Promise.race([
        handleResearch({ date: dateStr }, apiKey),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("45s timeout")), CALL_TIMEOUT_MS)
        ),
      ])
    )
  );

  const succeeded   = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const failedCount = results.filter(r => r.status === "rejected").length;
  const fbCount     = succeeded.filter(e => e.sourceUrlKind === "google-search-fallback").length;
  const filtered    = filterAndDedupePool(succeeded);
  const supplemented = filtered.length < 3;
  const flowerName   = supplemented ? getSeasonalFlower(isoDate) : null;

  // 補充エントリを追加（統計用・実際のgenerateResearchPool()と同じロジック）
  const finalEntries = supplemented
    ? [...filtered, { theme: `${flowerName}の季節`, sourceUrlKind: "seasonal-flower-fallback" }]
    : filtered;

  return {
    date:            isoDate,
    generated:       succeeded.length,
    failedCount,
    fbFiltered:      fbCount,
    dedupFiltered:   succeeded.length - fbCount - filtered.length,
    afterFilter:     filtered.length,
    finalCount:      finalEntries.length,
    supplemented,
    flowerName,
    themes:          finalEntries.map(e => ({ theme: e.theme, kind: e.sourceUrlKind })),
  };
}

async function main() {
  const dates = getPastDates(DAYS);
  console.log("\n" + "═".repeat(72));
  console.log(`事前リサーチプール ${DAYS}日間シミュレーション`);
  console.log(`対象: ${dates[dates.length - 1]} 〜 ${dates[0]}`);
  console.log(`呼び出し: ${DAYS}日 × ${PARALLEL}件並列 = ${DAYS * PARALLEL}件`);
  console.log("═".repeat(72) + "\n");

  const allResults = [];

  for (const date of dates) {
    process.stdout.write(`[${date}] 生成中...`);
    try {
      const r = await testOneDay(date);
      allResults.push(r);

      const supTag = r.supplemented ? ` ⚠️ 季節補充(${r.flowerName})` : "";
      process.stdout.write(
        `\r[${date}] ` +
        `生成 ${r.generated}/${PARALLEL} → ` +
        `fallback除外 -${r.fbFiltered} → ` +
        `重複除去 -${r.dedupFiltered} → ` +
        `計 ${r.finalCount}件${supTag}\n`
      );
      for (const t of r.themes) {
        console.log(`  ${kindEmoji(t.kind)} ${t.theme}`);
      }
    } catch (e) {
      console.log(`\r[${date}] ❌ エラー: ${e.message}`);
      allResults.push({ date, error: e.message });
    }
  }

  // ── 統計サマリー ──────────────────────────────────────────────
  const valid         = allResults.filter(r => !r.error);
  const totalGen      = valid.reduce((s, r) => s + r.generated,    0);
  const totalFb       = valid.reduce((s, r) => s + r.fbFiltered,   0);
  const totalDedup    = valid.reduce((s, r) => s + r.dedupFiltered, 0);
  const totalFinal    = valid.reduce((s, r) => s + r.finalCount,   0);
  const suppDays      = valid.filter(r => r.supplemented);
  const avgPool       = (totalFinal / valid.length).toFixed(1);

  console.log("\n" + "═".repeat(72));
  console.log("【統計サマリー】");
  console.log(`  テスト日数:           ${valid.length}日`);
  console.log(`  合計生成:             ${totalGen}件 / ${DAYS * PARALLEL}件`);
  console.log(`  fallback除外率:       ${(totalFb / totalGen * 100).toFixed(1)}%（${totalFb}件）`);
  console.log(`  重複除去率:           ${(totalDedup / totalGen * 100).toFixed(1)}%（${totalDedup}件）`);
  console.log(`  平均プール件数/日:    ${avgPool}件`);
  console.log(`  季節補充発動:         ${suppDays.length}日（${(suppDays.length / valid.length * 100).toFixed(1)}%）`);
  if (suppDays.length > 0) {
    console.log(`  補充発動日:           ${suppDays.map(r => `${r.date}(${r.flowerName})`).join(", ")}`);
  }

  // ── 全テーマ一覧（目視ハルシネーションチェック）──────────────
  console.log("\n【全テーマ一覧（目視ハルシネーションチェック）】");
  console.log("  凡例: ✅=grounding証拠あり  🔗=vertexaisearch(内容は根拠あり)  🌸=季節補充  ❓=不明");
  console.log("  ── 不適切テーマの例: 年号+災害/事故/訃報、架空の記念日 ──");
  for (const r of valid) {
    if (!r.themes?.length) continue;
    const themes = r.themes.map(t => `${kindEmoji(t.kind)}${t.theme}`).join("  ");
    console.log(`  ${r.date}: ${themes}`);
  }

  console.log("\n✅ シミュレーション完了");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
