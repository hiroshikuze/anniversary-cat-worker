#!/usr/bin/env node
/**
 * test-compare-image-models.mjs - scripts/compare-image-models.mjs ユニットテスト
 *
 * 外部API接続は不要（純粋関数のみ）。
 * GitHub Actionsおよびローカルで実行可能:
 *   node scripts/test-compare-image-models.mjs
 *
 * 終了コード 0 = 全件成功、1 = 1件以上失敗
 */

import {
  DEFAULT_MODELS,
  VARIANTS,
  CASES,
  PRICES,
  parseArgs,
  applyVariant,
  columnKey,
  parseImageSize,
  buildRequestBody,
  extractImage,
  parseUsage,
  estimateCostUsd,
  summarize,
  redactKey,
  safeFileName,
  buildReportHtml,
  generateOnce,
} from "./compare-image-models.mjs";

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

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// ---------------------------------------------------------------------------
console.log("\n[parseArgs]");
{
  const d = parseArgs([]);
  assert("既定のモデルは2つ（現行と3.1 flash-lite-image）", d.models.length === 2 && d.models[0] === "gemini-2.5-flash-image" && d.models[1] === "gemini-3.1-flash-lite-image");
  assert("既定の試行回数は2", d.trials === 2);
  assert("既定はdry-runでない", d.dryRun === false);
  assert("既定の出力先はtmp/image-model-compare", d.out === "tmp/image-model-compare");

  const c = parseArgs(["--models", "a,b , c", "--trials", "3", "--out", "tmp/x", "--dry-run"]);
  assert("--modelsはカンマ区切り・空白を除く", c.models.join("|") === "a|b|c");
  assert("--trialsを数値にする", c.trials === 3);
  assert("--outを受け取る", c.out === "tmp/x");
  assert("--dry-run", c.dryRun === true);

  assert("--trialsが0なら例外", throws(() => parseArgs(["--trials", "0"])));
  assert("--trialsが数値でなければ例外", throws(() => parseArgs(["--trials", "abc"])));
  assert("--trialsが大きすぎれば例外（課金の事故防止）", throws(() => parseArgs(["--trials", "11"])));
  assert("--modelsが空なら例外", throws(() => parseArgs(["--models", ""])));
  assert("未知の引数は例外", throws(() => parseArgs(["--unknown"])));
  assert("値のない--modelsは例外", throws(() => parseArgs(["--models"])));
  assert("DEFAULT_MODELSと一致", d.models.join() === DEFAULT_MODELS.join());

  assert("既定の変種はA（現行のプロンプトだけ）", d.variants.join() === "A");
  assert("--variantsはカンマ区切り", parseArgs(["--variants", "A, B,C"]).variants.join() === "A,B,C");
  assert("--variantsは重複を除く", parseArgs(["--variants", "B,B,A"]).variants.join() === "B,A");
  assert("未知の変種は例外", throws(() => parseArgs(["--variants", "A,Z"])));
  assert("--variantsが空なら例外", throws(() => parseArgs(["--variants", ""])));
}

// ---------------------------------------------------------------------------
console.log("\n[変種（applyVariant）]");
{
  const base = CASES[0].prompt;
  assert("A（現行）はプロンプトを変えない", applyVariant(base, "A") === base);

  const b = applyVariant(base, "B");
  assert("Bは「画面を埋める」の構図の行を外す", !b.includes("fill the frame") && !b.includes("full and immersive"));
  assert("Bは「余白を残さない」の念押しを外す", !b.includes("Do not leave large blank margins"));
  assert("Bは白背景のスポットイラストを指定する", b.includes("a spot illustration isolated on a pure white background"));
  assert("Bは全面の風景背景を描かない指示を入れる", b.includes("Do not draw a full scenery background"));
  assert("Bでも文字禁止の指示は残る", b.includes("Do not include any text"));
  assert("Bでも猫以外に顔をつけない指示は残る（Bug#33）", b.includes("Only the cat(s) described above should have a face"));
  assert("Bでも円形フレーム禁止は残る（Bug#27）", b.includes("do not add a circular frame, border, or vignette"));
  assert("Bは葉の枚数や絵本風の指定を足さない", !/5 to 7|children's book/i.test(b));
  assert("BはStyle行（白背景）を残す", b.includes("white background, Japanese illustration style"));
  assert("Cのプロンプトは本文がBと同じ", applyVariant(base, "C") === b);

  assert("本番のプロンプトに想定の文が無ければ例外（黙って何もしない事故を防ぐ）", throws(() => applyVariant("Create a cat.", "B")));
  assert("未知の変種は例外", throws(() => applyVariant(base, "Z")));

  assert("変種はA・B・C", Object.keys(VARIANTS).join() === "A,B,C");
  assert("AとBはimageConfigを送らない", VARIANTS.A.imageConfig === null && VARIANTS.B.imageConfig === null);
  assert("Cは縦横比1:1だけをimageConfigで指定する", JSON.stringify(VARIANTS.C.imageConfig) === JSON.stringify({ aspectRatio: "1:1" }));
  assert("全ケースでBが成立する（想定の文が本番のプロンプトにある）", CASES.every((c) => !throws(() => applyVariant(c.prompt, "B"))));
  assert("列のキーはモデルと変種から作る", columnKey("m1", "B") === "m1__B");
}

// ---------------------------------------------------------------------------
console.log("\n[parseImageSize]");
{
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(768, 20);
  const p = parseImageSize(png);
  assert("PNGの幅と高さ", p && p.width === 1024 && p.height === 768);

  // JPEG: SOI + APP0（長さ16）+ SOF0（高さ768・幅1408）
  const jpg = Buffer.alloc(2 + 18 + 19);
  jpg.writeUInt16BE(0xffd8, 0);
  jpg.writeUInt16BE(0xffe0, 2);
  jpg.writeUInt16BE(16, 4);
  jpg.writeUInt16BE(0xffc0, 20);
  jpg.writeUInt16BE(17, 22);
  jpg.writeUInt8(8, 24);
  jpg.writeUInt16BE(768, 25);
  jpg.writeUInt16BE(1408, 27);
  const j = parseImageSize(jpg);
  assert("JPEGの幅と高さ（SOFを探す）", j && j.width === 1408 && j.height === 768);

  assert("未知の形式はnull", parseImageSize(Buffer.from("hello world, not an image")) === null);
  assert("短すぎる入力はnull", parseImageSize(Buffer.alloc(4)) === null);
  assert("空はnull", parseImageSize(Buffer.alloc(0)) === null);
}

// ---------------------------------------------------------------------------
console.log("\n[ケース（プロンプト）]");
{
  assert("ケースは3つ以上", CASES.length >= 3);
  assert("idが重複しない", new Set(CASES.map((c) => c.id)).size === CASES.length);
  assert("本番の_buildGeminiPrompt()で作られている", CASES.every((c) => c.prompt.startsWith("Create a cute kawaii watercolor style cat character illustration.")));
  assert("文字禁止の指示を含む", CASES.every((c) => c.prompt.includes("Do not include any text")));
  assert("猫以外に顔をつけない指示を含む（Bug#33）", CASES.every((c) => c.prompt.includes("Only the cat(s) described above should have a face")));
  assert("各ケースにテーマ名がある", CASES.every((c) => typeof c.theme === "string" && c.theme.length > 0));
}

// ---------------------------------------------------------------------------
console.log("\n[buildRequestBody / extractImage]");
{
  const body = buildRequestBody("hello");
  assert("本番と同じresponseModalities", JSON.stringify(body.generationConfig.responseModalities) === JSON.stringify(["IMAGE", "TEXT"]));
  assert("プロンプトがpartsに入る", body.contents[0].parts[0].text === "hello");
  assert("imageConfigが無ければgenerationConfigに入れない", !("imageConfig" in body.generationConfig));
  const withCfg = buildRequestBody("hello", { aspectRatio: "1:1" });
  assert("imageConfigはgenerationConfigに入る", withCfg.generationConfig.imageConfig.aspectRatio === "1:1");
  assert("imageConfigを足してもresponseModalitiesは残る", withCfg.generationConfig.responseModalities.length === 2);

  const ok = extractImage({ candidates: [{ content: { parts: [{ text: "t" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] } }] });
  assert("画像パートを取り出す", ok.mimeType === "image/png" && ok.data === "QUJD");
  assert("mimeTypeが無ければimage/png", extractImage({ candidates: [{ content: { parts: [{ inlineData: { data: "QUJD" } }] } }] }).mimeType === "image/png");
  assert("画像パートが無ければnull", extractImage({ candidates: [{ content: { parts: [{ text: "only text" }] } }] }) === null);
  assert("candidatesが無ければnull", extractImage({}) === null);
  assert("空の入力でもnull", extractImage(null) === null);
}

// ---------------------------------------------------------------------------
console.log("\n[parseUsage]");
{
  const u = parseUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 1400,
    totalTokenCount: 1500,
    candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }, { modality: "TEXT", tokenCount: 110 }],
  });
  assert("入力トークン", u.prompt === 100);
  assert("画像トークンは詳細のIMAGEの合計", u.image === 1290);
  assert("テキストトークンは出力から画像を引く", u.text === 110);
  assert("合計", u.total === 1500);
  assert("画像の内訳が分かる", u.imageKnown === true);

  const t = parseUsage({ promptTokenCount: 50, candidatesTokenCount: 1290, thoughtsTokenCount: 200, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }] });
  assert("思考トークンはテキスト側に数える", t.text === 200 && t.image === 1290);
  assert("totalTokenCountが無ければ合算", t.total === 50 + 1290 + 200);

  const n = parseUsage({ promptTokenCount: 10, candidatesTokenCount: 1300, totalTokenCount: 1310 });
  assert("詳細が無ければ画像の内訳は不明", n.imageKnown === false && n.image === 0);

  const e = parseUsage(undefined);
  assert("usageが無くても0で返す", e.prompt === 0 && e.text === 0 && e.image === 0 && e.total === 0 && e.imageKnown === false);
  assert("出力より画像が多くてもテキストは負にならない", parseUsage({ candidatesTokenCount: 5, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 9 }] }).text === 0);
}

// ---------------------------------------------------------------------------
console.log("\n[estimateCostUsd]");
{
  const price = { input: 0.25, textOut: 1.5, imageOut: 30 };
  const usage = { prompt: 1_000_000, text: 1_000_000, image: 1_000_000, total: 3_000_000, imageKnown: true };
  assert("入力＋テキスト＋画像の合計", Math.abs(estimateCostUsd(usage, price) - (0.25 + 1.5 + 30)) < 1e-9);
  assert("1枚の目安（約1,290画像トークン）", Math.abs(estimateCostUsd({ prompt: 0, text: 0, image: 1290, total: 1290, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) - 0.0387) < 1e-9);
  assert("テキストが0なら、テキスト価格が不明でも計算できる", estimateCostUsd({ prompt: 100, text: 0, image: 1290, total: 1390, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) !== null);
  assert("テキストがあるのにテキスト価格が不明ならnull", estimateCostUsd({ prompt: 0, text: 5, image: 1290, total: 1295, imageKnown: true }, { input: 0.3, textOut: null, imageOut: 30 }) === null);
  assert("画像の内訳が不明ならnull", estimateCostUsd({ prompt: 1, text: 0, image: 0, total: 1, imageKnown: false }, price) === null);
  assert("価格表に無いモデルならnull", estimateCostUsd(usage, undefined) === null);
  assert("PRICESに既定モデルの価格がある", DEFAULT_MODELS.every((m) => PRICES[m]));
}

// ---------------------------------------------------------------------------
console.log("\n[summarize]");
{
  const trials = [
    { success: true, elapsedMs: 8000, bytes: 1000, usage: { total: 1500 }, costUsd: 0.04 },
    { success: true, elapsedMs: 10000, bytes: 3000, usage: { total: 1700 }, costUsd: 0.05 },
    { success: false, elapsedMs: 2000, error: "x" },
  ];
  const s = summarize(trials);
  assert("試行数・成功数", s.trials === 3 && s.successes === 2);
  assert("成功率", Math.abs(s.successRate - 2 / 3) < 1e-9);
  assert("所要時間は成功した試行だけで集計", s.minMs === 8000 && s.maxMs === 10000 && s.avgMs === 9000);
  assert("平均のバイト数・トークン", s.avgBytes === 2000 && s.avgTokens === 1600);
  assert("平均コスト", Math.abs(s.avgCostUsd - 0.045) < 1e-9);
  assert("12秒以内の件数", s.within12s === 2);

  const slow = summarize([{ success: true, elapsedMs: 13000, bytes: 1, usage: { total: 1 }, costUsd: null }]);
  assert("12秒を超えた成功は12秒以内に数えない", slow.within12s === 0);
  assert("コストが不明なら平均コストもnull", slow.avgCostUsd === null);

  const sz = summarize([
    { success: true, elapsedMs: 1, bytes: 1, usage: { total: 1 }, costUsd: 0, size: "1024x1024" },
    { success: true, elapsedMs: 1, bytes: 1, usage: { total: 1 }, costUsd: 0, size: "1408x768" },
    { success: true, elapsedMs: 1, bytes: 1, usage: { total: 1 }, costUsd: 0, size: "1024x1024" },
  ]);
  assert("出力サイズは重複を除いて集める", sz.sizes.join() === "1024x1024,1408x768");

  const none = summarize([{ success: false, elapsedMs: 1, error: "e" }]);
  assert("全失敗なら集計値はnull", none.successes === 0 && none.avgMs === null && none.minMs === null && none.avgBytes === null && none.avgCostUsd === null);
  const empty = summarize([]);
  assert("空でも例外にならず成功率は0", empty.trials === 0 && empty.successRate === 0);
}

// ---------------------------------------------------------------------------
console.log("\n[redactKey / safeFileName]");
{
  assert("APIキーを***に置き換える", redactKey("failed key=SECRET123 and SECRET123", "SECRET123") === "failed key=*** and ***");
  assert("キーが空なら何もしない", redactKey("abc", "") === "abc");
  assert("URLのkeyパラメーターも伏せる", !redactKey("https://x/y?key=abcdef&z=1", "").includes("abcdef"));
  assert("ファイル名に使えない文字を置き換える", safeFileName("a/b c:d") === "a_b_c_d");
  assert("英数字・ドット・ハイフンはそのまま", safeFileName("gemini-3.1-flash-lite-image") === "gemini-3.1-flash-lite-image");
}

// ---------------------------------------------------------------------------
console.log("\n[buildReportHtml]");
{
  const k1 = columnKey("m<1>", "A");
  const k2 = columnKey("m2", "B");
  const report = {
    startedAt: "2026-11-24T00:00:00.000Z",
    columns: [
      { key: k1, model: "m<1>", variant: "A", label: "現行<のプロンプト" },
      { key: k2, model: "m2", variant: "B", label: "B案" },
    ],
    cases: [{ id: "case1", theme: "<script>alert(1)</script>" }],
    trials: [
      { column: k1, model: "m<1>", variant: "A", caseId: "case1", n: 1, success: true, elapsedMs: 9000, bytes: 2048, size: "1408x768", usage: { total: 1500 }, costUsd: 0.04, file: "m_1___A__case1__1.png" },
      { column: k2, model: "m2", variant: "B", caseId: "case1", n: 1, success: false, elapsedMs: 100, error: "boom <b>" },
    ],
    summaries: {
      [k1]: summarize([{ success: true, elapsedMs: 9000, bytes: 2048, usage: { total: 1500 }, costUsd: 0.04, size: "1408x768" }]),
      [k2]: summarize([{ success: false, elapsedMs: 100, error: "boom" }]),
    },
  };
  const html = buildReportHtml(report);
  assert("HTMLの文書になっている", html.startsWith("<!doctype html>") && html.includes("<title>"));
  assert("モデル名の<をエスケープ", !html.includes("m<1>") && html.includes("m&lt;1&gt;"));
  assert("変種のラベルの<もエスケープ", !html.includes("現行<のプロンプト") && html.includes("現行&lt;のプロンプト"));
  assert("変種の記号を表示する", html.includes("案A") && html.includes("案B"));
  assert("テーマ名のスクリプトをエスケープ", !html.includes("<script>alert(1)</script>"));
  assert("失敗の理由もエスケープして載せる", html.includes("boom &lt;b&gt;"));
  assert("画像を相対パスで参照する", html.includes('src="m_1___A__case1__1.png"'));
  assert("出力サイズを載せる", html.includes("1408x768"));
  assert("目視のチェック項目を載せる", html.includes("文字の混入") && html.includes("猫以外の顔"));
  assert("価格は要確認の注記がある", html.includes("要確認"));
  assert("APIキーらしい文字列（key=）を含まない", !/key=/i.test(html));
}

// ---------------------------------------------------------------------------
console.log("\n[generateOnce（通信・fetchをモック）]");
{
  const originalFetch = globalThis.fetch;
  const KEY = "AIzaSyDUMMY-key-value-1234";
  const MODEL = "gemini-3.1-flash-lite-image";
  const resp = (status, data) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof data === "string" ? data : JSON.stringify(data)) });
  const okBody = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }] } }],
    usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 1500, totalTokenCount: 1900, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }, { modality: "TEXT", tokenCount: 380 }] },
  };
  let last = null;
  const mock = (impl) => { last = null; globalThis.fetch = async (url, opts) => { last = { url: String(url), opts }; return impl(url, opts); }; };
  try {
    mock(() => resp(200, okBody));
    const ok = await generateOnce(MODEL, "PROMPT", { aspectRatio: "1:1" }, KEY);
    assert("成功: 画像とmimeTypeを返す", ok.success === true && ok.image.data === "QUJD" && ok.image.mimeType === "image/jpeg");
    assert("成功: usageを解析し、推定コストを出す", ok.usage.image === 1120 && ok.usage.text === 380 && typeof ok.costUsd === "number");
    assert("成功: 所要時間を記録する", typeof ok.elapsedMs === "number" && ok.elapsedMs >= 0);
    assert("URLはモデルのgenerateContent", last.url === `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    assert("APIキーはURLに載せない（key=を含まない）", !last.url.includes("key=") && !last.url.includes(KEY));
    assert("APIキーはx-goog-api-keyヘッダーで送る", last.opts.headers["x-goog-api-key"] === KEY);
    assert("メソッドはPOST", last.opts.method === "POST");
    const sent = JSON.parse(last.opts.body);
    assert("プロンプトとimageConfigを本文に入れる", sent.contents[0].parts[0].text === "PROMPT" && sent.generationConfig.imageConfig.aspectRatio === "1:1");
    assert("タイムアウトのシグナルを付ける", last.opts.signal instanceof AbortSignal);

    await generateOnce(MODEL, "PROMPT", null, KEY);
    assert("imageConfigがnullなら本文に入れない", !("imageConfig" in JSON.parse(last.opts.body).generationConfig));

    mock(() => resp(400, { error: { message: `API key ${KEY} is invalid` } }));
    const e400 = await generateOnce(MODEL, "P", null, KEY);
    assert("HTTPエラー: 失敗として返す", e400.success === false && typeof e400.elapsedMs === "number");
    assert("HTTPエラー: メッセージのAPIキーを***に伏せる", !e400.error.includes(KEY) && e400.error.includes("***"));

    mock(() => resp(502, "<html>Bad Gateway</html>"));
    const e502 = await generateOnce(MODEL, "P", null, KEY);
    assert("非JSONは、ステータス付きの定型文", e502.success === false && e502.error === "非JSONレスポンス（HTTP 502）");

    mock(() => resp(200, { candidates: [{ content: { parts: [{ text: "画像を作れません" }] } }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }));
    const noImg = await generateOnce(MODEL, "P", null, KEY);
    assert("画像パートが無ければ失敗（理由は定型文・usageは残す）", noImg.success === false && noImg.error === "画像パートなし" && noImg.usage.prompt === 10);

    mock(() => { throw new TypeError(`fetch failed for https://x/?key=${KEY}`); });
    const eNet = await generateOnce(MODEL, "P", null, KEY);
    assert("通信例外: キー（keyパラメーターを含む）を出力に出さない", eNet.success === false && !eNet.error.includes(KEY) && !/key=AIza/.test(eNet.error));

    mock(() => { const e = new Error(`The operation was aborted ${KEY}`); e.name = "TimeoutError"; throw e; });
    const eTime = await generateOnce(MODEL, "P", null, KEY);
    assert("タイムアウトは定型文", eTime.success === false && eTime.error === "タイムアウト");

    mock(() => resp(200, okBody));
    const unpriced = await generateOnce("gemini-unknown-model", "P", null, KEY);
    assert("価格表にないモデルは、コストをnullにする", unpriced.success === true && unpriced.costUsd === null);
  } catch (e) {
    assert(`generateOnceのテストが予期しない例外で止まった: ${e.message}`, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
