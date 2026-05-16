/**
 * かなモード ふりがなプレビュースクリプト
 *
 * 使い方:
 *   node scripts/preview-kana.mjs "テーマ名" "説明文"
 *
 * 例:
 *   node scripts/preview-kana.mjs "大仏の日" "東大寺の大仏開眼法要が行われた記念日です。"
 *
 * /tmp/kana-preview.html を生成してパスを表示する。
 * ブラウザで開いて ruby ふりがなの見え方を確認する。
 */

import KuroshiroModule from "kuroshiro";
import KuromojiModule from "kuroshiro-analyzer-kuromoji";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const theme       = process.argv[2];
const description = process.argv[3] ?? "";

if (!theme) {
  console.error("使い方: node scripts/preview-kana.mjs \"テーマ名\" \"説明文\"");
  process.exit(1);
}

const Kuroshiro       = KuroshiroModule.default ?? KuroshiroModule;
const KuromojiAnalyzer = KuromojiModule.default ?? KuromojiModule;

const k = new Kuroshiro();
await k.init(new KuromojiAnalyzer());

const toRuby = (text) => k.convert(text, { to: "hiragana", mode: "furigana" });

const themeRuby = await toRuby(theme);
const descRuby  = description ? await toRuby(description) : "";

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>かなモード プレビュー</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
      background: #fdf2f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(190, 24, 93, 0.10);
      max-width: 400px;
      width: 100%;
      padding: 24px;
    }
    .badge {
      display: inline-block;
      background: #fce7f3;
      color: #9d174d;
      font-size: 11px;
      font-weight: 600;
      border-radius: 999px;
      padding: 2px 10px;
      margin-bottom: 12px;
      letter-spacing: 0.04em;
    }
    .section-label {
      font-size: 12px;
      font-weight: 600;
      color: #ec4899;
      margin-bottom: 8px;
    }
    .theme {
      font-size: 22px;
      font-weight: 700;
      color: #831843;
      line-height: 1.6;
      margin-bottom: 12px;
    }
    .description {
      font-size: 14px;
      color: #9d174d;
      line-height: 1.9;
      margin-bottom: 20px;
    }
    ruby rt {
      font-size: 0.55em;
      color: #be185d;
    }
    hr { border: none; border-top: 1px solid #fce7f3; margin: 20px 0; }
    .compare-title {
      font-size: 11px;
      color: #f9a8d4;
      margin-bottom: 8px;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .plain {
      font-size: 14px;
      color: #c084fc;
      line-height: 1.8;
    }
    .raw {
      font-size: 10px;
      color: #d1d5db;
      word-break: break-all;
      margin-top: 6px;
      font-family: monospace;
      background: #f9fafb;
      padding: 8px;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">かなモード プレビュー</div>

    <div class="section-label">テーマ（ふりがなあり）</div>
    <div class="theme">${themeRuby}</div>

    ${descRuby ? `
    <div class="section-label">説明（ふりがなあり）</div>
    <div class="description">${descRuby}</div>
    ` : ""}

    <hr>

    <div class="compare-title">▼ 元のテキスト（比較用）</div>
    <div class="plain">${theme}${description ? `<br><br>${description}` : ""}</div>

    <hr>

    <div class="compare-title">▼ ruby HTML（実装に使う値）</div>
    <div class="raw">theme: ${themeRuby.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
    ${descRuby ? `<div class="raw" style="margin-top:6px">desc: ${descRuby.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>` : ""}
  </div>
</body>
</html>`;

const outPath = join(tmpdir(), "kana-preview.html");
writeFileSync(outPath, html, "utf-8");

console.log(`✅ プレビュー生成完了`);
console.log(`📄 ファイル: ${outPath}`);
console.log(`\nブラウザで開く:`);
console.log(`  open "${outPath}"          # Mac`);
console.log(`  xdg-open "${outPath}"      # Linux`);
console.log(`  start "${outPath}"         # Windows`);
