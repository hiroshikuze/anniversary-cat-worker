/**
 * translations.kana ブランチ用 ruby HTML 一括生成スクリプト
 *
 * 使い方:
 *   npm install kuroshiro kuroshiro-analyzer-kuromoji  # 初回のみ
 *   node scripts/generate-kana-translations.mjs
 *
 * 出力を目視確認して frontend/index.html の translations.kana に貼り付ける。
 * 一回限りのユーティリティ。本番コードには含めない。
 */

import KuroshiroModule from "kuroshiro";
import KuromojiModule from "kuroshiro-analyzer-kuromoji";

const Kuroshiro = KuroshiroModule.default ?? KuroshiroModule;
const KuromojiAnalyzer = KuromojiModule.default ?? KuromojiModule;

const k = new Kuroshiro();
await k.init(new KuromojiAnalyzer());

async function f(text) {
  return k.convert(text, { to: "hiragana", mode: "furigana" });
}

// ふりがな不要（漢字なし・または技術文字列）のキーはja値をそのまま使う
const PASS_THROUGH = new Set([
  "pageTitle",       // にゃんバーサリー（全かな）
  "generatePreviewPre", // 「
  "themeLabel",      // テーマ:
  "networkError",    // ネットワークエラー:
  "httpError",       // エラー (HTTP
  "dateLocale",      // ja-JP
]);

// テンプレートリテラル（STORAGE_DAYS を含む）は変数部分を保持したまま変換
const STORAGE_DAYS = "14"; // プレースホルダー値

const ja = {
  pageTitle:          "にゃんバーサリー",
  subtitle:           "今日の記念日を調べて、水彩画風の猫を生成します",
  step1Label:         "今日の記念日をリサーチ",
  researchBtn:        "🔍 今日の記念日を調べる",
  researchLoading:    "Googleで記念日を検索中です・・・",
  todayTheme:         "今日のテーマ",
  researchRetry:      "🔄 もう一度調べる",
  retryBtn:           "🔄 再試行する",
  step2Label:         "猫イラストを生成",
  waitingText:        "先に記念日を調べてください",
  generatePreviewPre: "「",
  generatePreviewPost:"」をテーマに猫を描きます",
  generateBtn:        "🎨 猫イラストを生成する",
  generateLoading:    "水彩画風の猫を描いています。...",
  generateTimeEst:    "少し時間がかかります（30秒ほど）",
  themeLabel:         "テーマ: ",
  regenerateBtn:      "🔄 もう一度生成",
  saveBtn:            "💾 保存する",
  shareBtn:           "🔗 共有する",
  // footer は HTML タグを含むため別途処理（下記 SPECIAL_CASES 参照）
  networkError:       "ネットワークエラー: ",
  httpError:          "エラー (HTTP ",
  imageLoadError:     "画像の読み込みに失敗しました。しばらく待ってから再度お試しください。",
  noImageError:       "画像データなし。返却フィールド: ",
  rateLimitError:     "本日の利用上限に達しました。明日またお試しください。",
  goodsLabel:         "🛍️ グッズを買う（SUZURI）",
  saleBanner:         "セール中！5/19(火)まで最大500円引き",
  goodsExpiry:        `共有リンクとグッズ購入は生成後${STORAGE_DAYS}日間のみご利用いただけます`,
  outOfStockToast:    "この商品は現在在庫切れです",
  preparingToast:     "まもなく準備完了です。しばらくお待ちください",
  preparingBtn:       "準備中…",
  expiredText:        `この記念日画像は期限切れです（${STORAGE_DAYS}日間保存）`,
  createNewBtn:       "🎨 今日の記念日で作る",
  newGenerateBtn:     "✨ 新しく生成",
  todayDateLabel:     "今日の記念日",
  researchSubtitle:   "AIが今日の記念日に合わせた猫のイラストを作ります",
  dateLocale:         "ja-JP",
  whatsNewTitle:      "🆕 アップデート情報",
  whatsNewClose:      "閉じる",
  galleryTitle:       "最近の作品",
};

// footer: HTML タグを保持しながらテキスト部分だけ変換
const footerTextPart = await f("画像はAIが生成します");
const footerLinkText  = await f("このサービスについて");
const footerKana = `Powered by Gemini &amp; Pollinations.ai ／ ${footerTextPart}<br><a href="https://github.com/hiroshikuze/anniversary-cat-worker#readme" target="_blank" rel="noopener" class="underline hover:text-pink-100">${footerLinkText}</a>`;

const results = { footer: footerKana };

for (const [key, val] of Object.entries(ja)) {
  if (key === "footer") continue;
  if (PASS_THROUGH.has(key)) {
    results[key] = val;
    continue;
  }
  results[key] = await f(val);
}

// ------------------------------------------------------------------
// 出力: 目視確認用
// ------------------------------------------------------------------
console.log("// ============================================================");
console.log("// translations.kana — ruby HTML 生成結果");
console.log("// STORAGE_DAYS は 14 で変換済み。実装時はテンプレートリテラルに戻す。");
console.log("// ============================================================");
console.log("kana: {");
for (const [key, val] of Object.entries(results)) {
  const escaped = val.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  console.log(`  ${key.padEnd(20)}: \`${escaped}\`,`);
}
console.log("},");
