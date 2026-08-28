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
  url: "https://suzuri.jp/nyanmusu",
};

// ---------------------------------------------------------------------------
// isSaleActive / getActiveSaleInfo - 正常系
// ---------------------------------------------------------------------------
console.log("\n[isSaleActive / getActiveSaleInfo - 正常系]");
{
  _setSaleForTest(SAMPLE_SALE);
  const duringSale = Date.UTC(2026, 7, 30, 0, 0);

  assert("セール期間中はtrue", isSaleActive(duringSale) === true);
  assert("セール期間中はsaleオブジェクトを返す", getActiveSaleInfo(duringSale)?.id === "test-sale");

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
