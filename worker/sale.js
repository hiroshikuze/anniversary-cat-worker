/**
 * worker/sale.js - SUZURIセール期間・金額の一元管理
 *
 * frontend/index.htmlとworker/bot.js（Bot投稿へのセール告知リプライ）の両方が
 * このファイルの_currentSaleのみを参照する。次のセール開催が決まったら
 * _currentSaleオブジェクトを差し替えるだけでよい（詳細はarchitecture.md参照）。
 *
 * image-utils.jsのPhoton差し替えと同じ「モジュールスコープの状態＋テスト用差し替え関数」
 * パターンを踏襲する。
 */

let _currentSale = {
  id:          "ninnin-sale-2026-10",
  startUtcMs:  Date.UTC(2026, 9, 23, 3, 0),
  endUtcMs:    Date.UTC(2026, 9, 27, 14, 59),
  discountYen: 700,
  endDisplay:  { month: 10, day: 27, weekdayJa: "火" },
  url:         "https://suzuri.jp/nyanmusu",
}; // セールがない期間は null に書き換える
// discountYenは代表値（Tシャツ基準）。ステッカーはこのセール対象外
// （一次情報: https://suzuri.jp/media/journal_ninnin-sale_202610/ 2026-10-16確認）

export function isSaleActive(now = Date.now()) {
  return !!_currentSale && now >= _currentSale.startUtcMs && now <= _currentSale.endUtcMs;
}

export function getActiveSaleInfo(now = Date.now()) {
  return isSaleActive(now) ? _currentSale : null;
}

/** テスト用: セール設定を差し替える（image-utils.jsの_setPhotonForTestと同じパターン） */
export function _setSaleForTest(sale) {
  _currentSale = sale;
}
