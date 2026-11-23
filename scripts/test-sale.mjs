#!/usr/bin/env node
/**
 * test-sale.mjs - worker/sale.js ユニットテスト
 *
 * 外部API接続は不要（純粋関数のみ）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-sale.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import { isSaleActive, getActiveSaleInfo, _setSaleForTest } from "../worker/sale.js";

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

const SAMPLE_SALE = {
  id: "test-sale",
  startUtcMs: Date.UTC(2026, 7, 28, 3, 0),
  endUtcMs: Date.UTC(2026, 8, 3, 14, 59),
  discountYen: 800,
  endDisplay: { month: 9, day: 3, weekdayJa: "木" },
  stickerExcluded: true,
  url: "https://suzuri.jp/nyanmusu",
};

// ---------------------------------------------------------------------------
// 本番設定の_currentSale（他のテストが_setSaleForTestで書き換える前に検証する）
// 2026-11 SUZURIのブラックフライデー（一次情報: https://suzuri.jp/media/journal_black_friday_202611/ 2026-11-23確認）
// ---------------------------------------------------------------------------
console.log("\n[本番設定の_currentSale（ブラックフライデー）]");
{
  const justBefore = Date.UTC(2026, 10, 27, 2, 59);   // 11/27 11:59 JST
  const start      = Date.UTC(2026, 10, 27, 3, 0);    // 11/27 12:00 JST
  const end        = Date.UTC(2026, 11, 8, 14, 59);   // 12/8 23:59 JST
  const justAfter  = Date.UTC(2026, 11, 8, 15, 0);    // 12/9 00:00 JST
  assert("開始1分前（11/27 11:59 JST）はセール外", getActiveSaleInfo(justBefore) === null);
  assert("開始（11/27 12:00 JST）からセール中", getActiveSaleInfo(start) !== null);
  assert("終了（12/8 23:59 JST）までセール中", getActiveSaleInfo(end) !== null);
  assert("終了直後（12/9 00:00 JST）はセール外", getActiveSaleInfo(justAfter) === null);
  const info = getActiveSaleInfo(start);
  assert("最大値は1000円（スタンダードTシャツ）", info?.discountYen === 1000);
  assert("終了表示は12/8（火）", info?.endDisplay?.month === 12 && info?.endDisplay?.day === 8 && info?.endDisplay?.weekdayJa === "火");
  assert("ステッカーは対象（stickerExcluded=false）", info?.stickerExcluded === false);
  assert("ショップURLはnyanmusu", info?.url === "https://suzuri.jp/nyanmusu");
  // 12/8は2026年の火曜日であること（曜日の書き間違い防止）
  assert("12/8は火曜日", new Date(Date.UTC(2026, 11, 8, 3, 0)).getUTCDay() === 2);
  // 前回（ニンニンSALE 10/27終了）の期間はもうセール外
  assert("前回セール期間（10/25）はセール外", getActiveSaleInfo(Date.UTC(2026, 9, 25, 0, 0)) === null);
}

// ---------------------------------------------------------------------------
// isSaleActive / getActiveSaleInfo - 正常系
// ---------------------------------------------------------------------------
console.log("\n[isSaleActive / getActiveSaleInfo - 正常系]");
{
  _setSaleForTest(SAMPLE_SALE);
  const duringSale = Date.UTC(2026, 7, 30, 0, 0);

  assert("セール期間中はtrue", isSaleActive(duringSale) === true);
  assert("セール期間中はsaleオブジェクトを返す", getActiveSaleInfo(duringSale)?.id === "test-sale");
  assert("stickerExcludedがそのまま返る", getActiveSaleInfo(duringSale)?.stickerExcluded === true);

  const beforeSale = Date.UTC(2026, 7, 20, 0, 0);
  assert("セール開始前はfalse", isSaleActive(beforeSale) === false);
  assert("セール開始前はnullを返す", getActiveSaleInfo(beforeSale) === null);

  const afterSale = Date.UTC(2026, 8, 10, 0, 0);
  assert("セール終了後はfalse", isSaleActive(afterSale) === false);
  assert("セール終了後はnullを返す", getActiveSaleInfo(afterSale) === null);
}

// ---------------------------------------------------------------------------
// isSaleActive / getActiveSaleInfo - 境界値
// ---------------------------------------------------------------------------
console.log("\n[isSaleActive / getActiveSaleInfo - 境界値]");
{
  _setSaleForTest(SAMPLE_SALE);

  assert("startUtcMsちょうどはtrue", isSaleActive(SAMPLE_SALE.startUtcMs) === true);
  assert("endUtcMsちょうどはtrue", isSaleActive(SAMPLE_SALE.endUtcMs) === true);
  assert("startUtcMsの1ms前はfalse", isSaleActive(SAMPLE_SALE.startUtcMs - 1) === false);
  assert("endUtcMsの1ms後はfalse", isSaleActive(SAMPLE_SALE.endUtcMs + 1) === false);
}

// ---------------------------------------------------------------------------
// isSaleActive / getActiveSaleInfo - エラー系（セールなし）
// ---------------------------------------------------------------------------
console.log("\n[isSaleActive / getActiveSaleInfo - セールなし]");
{
  _setSaleForTest(null);
  const now = Date.now();

  assert("セール設定なしはfalse", isSaleActive(now) === false);
  assert("セール設定なしはnullを返す", getActiveSaleInfo(now) === null);
}

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------
console.log(`\n合計: ${passed}件成功 / ${failed}件失敗`);
process.exit(failed > 0 ? 1 : 0);
