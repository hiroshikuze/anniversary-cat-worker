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
  id:          "black-friday-2026-11",
  startUtcMs:  Date.UTC(2026, 10, 27, 3, 0),   // 2026-11-27（金）12:00 JST
  endUtcMs:    Date.UTC(2026, 11, 8, 14, 59),  // 2026-12-08（火）23:59 JST
  discountYen: 1000,
  endDisplay:  { month: 12, day: 8, weekdayJa: "火" },
  stickerExcluded: false,
  url:         "https://suzuri.jp/nyanmusu",
}; // セールがない期間は null に書き換える
// discountYenは最大額（スタンダードTシャツ1,000円引き）。商品別の割引表は持たない。
// ステッカー・缶バッジは各50円引き、アクリルキーホルダーは300円引きでいずれも対象。
// stickerExcludedは「（ステッカーを除く）」の出し分け用。対象外のセールではtrueにする。
// （一次情報: https://suzuri.jp/media/journal_black_friday_202611/ 2026-11-23確認）

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
