/**
 * worker/http-utils.js - 共通HTTPユーティリティ
 *
 * worker/index.js と worker/suzuri.js の両方から使うため独立ファイルとして新設した
 * （worker/index.js が worker/suzuri.js を import しているため循環import回避）。
 */

/**
 * 5xxエラーと fetch() 自体が投げるネットワーク例外（DNS失敗・接続断等）の両方を
 * 指数バックオフで最大 maxRetries 回リトライする。
 *
 * - 429（クォータ超過）はリトライしても無駄なため即座にレスポンスを返す
 * - AbortError（AbortSignal.timeout() によるタイムアウト）はリトライしても同じ結果に
 *   なるため即座にthrowする
 * - baseDelayMs はテスト用引数（本番は省略時1000msで既存動作と同一）
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      if (networkErr.name === "AbortError" || i === maxRetries - 1) throw networkErr;
      await new Promise((r) => setTimeout(r, Math.pow(2, i) * baseDelayMs + Math.random() * baseDelayMs * 0.5));
      continue;
    }
    if (res.status === 429) return res;
    if (res.status >= 500 && i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, Math.pow(2, i) * baseDelayMs + Math.random() * baseDelayMs * 0.5));
      continue;
    }
    return res;
  }
}
