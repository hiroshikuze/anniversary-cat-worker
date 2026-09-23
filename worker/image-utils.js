/**
 * worker/image-utils.js - Photon（WASM画像処理）の共有ローダー・自動トリミング
 *
 * worker/bot.js（JPEG圧縮）とworker/index.js（生成後の余白自動トリミング）の
 * 両方から使うため独立ファイルとして新設した（http-utils.jsと同じ循環import回避パターン）。
 *
 * 背景: プロンプト側の「余白を残さない」指示（architecture.mdの「構図の余白削減指示」）だけでは
 * 効果が不安定なため、生成後にコード側で余白を検出・トリミングする機能を追加した。
 * CPU時間の実測結果（Node.js環境で約45〜60ms）はarchitecture.mdの「生成後の自動トリミング」参照。
 * Workers Freeプランの公式CPU上限（10ms）を大きく超過するため、2026-08時点では
 * `/generate`（レート制限あり）のみに適用し、`runBot()`には組み込まない計測フェーズとしている。
 */

import holidayJp from "@holiday-jp/holiday_jp";

// Photonは動的importで遅延ロード（Node.jsテスト環境での.wasmロード失敗を回避。worker/bot.jsと同じパターン）
let _photonReady = false;
let _PhotonImage  = null;
let _photonFns    = null; // { crop, resize, SamplingFilter }

export async function ensurePhoton() {
  if (_photonReady) return;
  const mod = await import("@silvia-odwyer/photon");
  const { default: photonWasm } = await import("@silvia-odwyer/photon/photon_rs_bg.wasm");
  mod.initSync({ module: photonWasm });
  _PhotonImage = mod.PhotonImage;
  _photonFns   = {
    crop: mod.crop, resize: mod.resize, SamplingFilter: mod.SamplingFilter, watermark: mod.watermark,
    draw_text_with_border: mod.draw_text_with_border,
  };
  _photonReady = true;
}

export function getPhotonImage() { return _PhotonImage; }
export function getPhotonFns()   { return _photonFns; }

/** テスト用: Photonのモックを注入する（worker/bot.jsの_setPhotonForTestと同じパターン） */
export function _setPhotonForTest(mockPhotonImage, mockFns = null) {
  _PhotonImage = mockPhotonImage;
  _photonFns   = mockFns;
  _photonReady = mockPhotonImage !== null;
}

/** base64 文字列を Uint8Array に変換（Cloudflare Workers の atob を使用） */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Uint8Array を base64 文字列に変換 */
export function uint8ArrayToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * ダウンサンプルした画像のRGBAピクセル配列（Photonの get_raw_pixels() 形式）から、
 * 被写体のバウンディングボックスを検出する。WASM非依存の純粋関数。
 *
 * @param {Uint8Array} pixels - width*height*4 のRGBA配列（行優先）
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.whiteThreshold=245] - この値以上のR/G/Bを「背景」とみなす
 * @param {number} [options.backgroundFraction=0.99] - 行/列内で背景ピクセルがこの割合以上なら「背景の行/列」
 * @param {number} [options.minMarginRatio=0.03] - 全辺の余白がこの割合未満ならトリミングしない
 * @param {number} [options.maxMarginRatio=0.2] - 1辺あたりの最大クロップ率（誤検出時の暴走防止）
 * @param {number} [options.paddingRatio=0.02] - 被写体ギリギリまで詰めない安全パディング
 * @returns {{x1:number,y1:number,x2:number,y2:number}|null} 0〜1の比率。トリミング不要ならnull
 */
export function _detectCropBox(pixels, width, height, options = {}) {
  const {
    whiteThreshold     = 245,
    backgroundFraction = 0.99,
    minMarginRatio     = 0.03,
    maxMarginRatio     = 0.2,
    paddingRatio       = 0.02,
  } = options;

  function isBg(i) {
    return pixels[i] >= whiteThreshold && pixels[i + 1] >= whiteThreshold && pixels[i + 2] >= whiteThreshold;
  }
  function isBgRow(y) {
    let bg = 0;
    for (let x = 0; x < width; x++) if (isBg((y * width + x) * 4)) bg++;
    return bg / width >= backgroundFraction;
  }
  function isBgCol(x) {
    let bg = 0;
    for (let y = 0; y < height; y++) if (isBg((y * width + x) * 4)) bg++;
    return bg / height >= backgroundFraction;
  }

  let top = 0;
  while (top < height && isBgRow(top)) top++;
  let bottom = height - 1;
  while (bottom > top && isBgRow(bottom)) bottom--;
  let left = 0;
  while (left < width && isBgCol(left)) left++;
  let right = width - 1;
  while (right > left && isBgCol(right)) right--;

  // 全面背景・検出不能（被写体が見つからない）
  if (top >= bottom || left >= right) return null;

  const marginTop    = Math.min(top / height, maxMarginRatio);
  const marginBottom = Math.min((height - 1 - bottom) / height, maxMarginRatio);
  const marginLeft   = Math.min(left / width, maxMarginRatio);
  const marginRight  = Math.min((width - 1 - right) / width, maxMarginRatio);

  if (marginTop < minMarginRatio && marginBottom < minMarginRatio &&
      marginLeft < minMarginRatio && marginRight < minMarginRatio) {
    return null; // すでに余白が小さいのでトリミング不要
  }

  return {
    x1: Math.max(0, marginLeft - paddingRatio),
    y1: Math.max(0, marginTop - paddingRatio),
    x2: Math.min(1, 1 - marginRight + paddingRatio),
    y2: Math.min(1, 1 - marginBottom + paddingRatio),
  };
}

/**
 * 画像（base64）を受け取り、余白を検出して必要ならトリミングする。
 * 失敗時・トリミング不要時は元のimageDataをそのまま返す（cropped: false）。
 * 出力は常にPNG（get_bytes()）に統一する。
 *
 * @param {string} imageData - base64エンコードされた画像
 * @param {object} [deps] - テスト用の依存注入
 * @returns {Promise<{imageData: string, mimeType: string, cropped: boolean}>}
 */
export async function autoCropImage(imageData, deps = {}) {
  const {
    ensurePhotonFn   = ensurePhoton,
    getPhotonImageFn = getPhotonImage,
    getPhotonFnsFn   = getPhotonFns,
    sampleSize       = 64,
  } = deps;

  await ensurePhotonFn();
  const PhotonImage = getPhotonImageFn();
  const { crop, resize, SamplingFilter } = getPhotonFnsFn();

  const bytes = base64ToBytes(imageData);
  const img = PhotonImage.new_from_byteslice(bytes);
  let small;
  try {
    const fullWidth  = img.get_width();
    const fullHeight = img.get_height();

    small = resize(img, sampleSize, sampleSize, SamplingFilter.Nearest);
    const pixels = small.get_raw_pixels();
    const box = _detectCropBox(pixels, sampleSize, sampleSize);
    if (!box) {
      return { imageData, mimeType: "image/png", cropped: false };
    }

    const x1 = Math.round(box.x1 * fullWidth);
    const y1 = Math.round(box.y1 * fullHeight);
    const x2 = Math.round(box.x2 * fullWidth);
    const y2 = Math.round(box.y2 * fullHeight);

    const croppedImg = crop(img, x1, y1, x2, y2);
    try {
      const outBytes = croppedImg.get_bytes();
      return { imageData: uint8ArrayToBase64(outBytes), mimeType: "image/png", cropped: true };
    } finally {
      croppedImg.free();
    }
  } finally {
    if (small) small.free();
    img.free();
  }
}

// ---------------------------------------------------------------------------
// 月替わり壁紙: カレンダー・月名オーバーレイ（Satori要素ツリー・純粋関数）
// architecture.mdの「カレンダー・月名の合成」参照。ランタイムの空白帯検出は行わず、
// オーバーレイ自体に半透明パネルを常時描画することで可読性を保証する設計。
// ---------------------------------------------------------------------------

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const COLOR_SUNDAY_HOLIDAY = "#c0392b";
const COLOR_SATURDAY = "#2e6da4";
const COLOR_WEEKDAY = "#2b2b2b";
const SIGNATURE_TEXT = "© nyanmusu";
// Bug#38: スマートフォン実機（iPhone 17 Pro）で月名バッジ・カレンダー帯・署名が画面の曲面や
// システムUIに隠れて見切れていた。オーバーレイ要素の配置を固定px値ではなく画面サイズに対する
// 比率で管理し、キャンバスサイズが変わっても安全マージンが保たれるようにする
const SAFE_AREA_RATIO = 0.09; // 上下セーフエリア（全高の約9%）
const CALENDAR_MARGIN_RATIO = 0.1225; // カレンダー帯の左右マージン（全幅の約12.25%・横幅は約75.5%相当）
const SIGNATURE_GAP_ABOVE_CALENDAR = 32; // カレンダー帯の下端と署名の間隔（従来デザインを踏襲）

/** 指定年月の日数（純粋関数） */
export function _daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 指定年月1日の曜日（0=日曜）（純粋関数） */
function _firstWeekday(year, month) {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

export function _dayColor(year, month, day, weekday) {
  if (weekday === 0) return COLOR_SUNDAY_HOLIDAY;
  if (weekday === 6) return COLOR_SATURDAY;
  if (holidayJp.isHoliday(new Date(year, month - 1, day))) return COLOR_SUNDAY_HOLIDAY;
  return COLOR_WEEKDAY;
}

/**
 * 指定年月のカレンダー週配列を返す（純粋関数）。各要素は7要素（日曜始まり）で、
 * 月に属さない日はnull。
 */
export function _buildCalendarWeeks(year, month) {
  const totalDays = _daysInMonth(year, month);
  const startWeekday = _firstWeekday(year, month);
  const weeks = [];
  let week = new Array(7).fill(null);
  let col = startWeekday;
  for (let day = 1; day <= totalDays; day++) {
    week[col] = day;
    col++;
    if (col === 7) {
      weeks.push(week);
      week = new Array(7).fill(null);
      col = 0;
    }
  }
  if (week.some((d) => d !== null)) weeks.push(week);
  return weeks;
}

/** 「© nyanmusu」署名のみのSatori要素ツリーを返す（カレンダーなし版用・純粋関数） */
export function _buildSignatureOnlyElement(options = {}) {
  const { width = 1080, height = 1920 } = options;
  const left = Math.round(width * CALENDAR_MARGIN_RATIO);
  const bottom = Math.round(height * SAFE_AREA_RATIO);
  return {
    type: "div",
    props: {
      style: {
        display: "flex", width, height, position: "relative",
      },
      children: {
        type: "div",
        props: {
          style: {
            display: "flex", position: "absolute", left, bottom,
            color: "#ffffff", fontFamily: "WorkSans", fontSize: 26,
          },
          children: SIGNATURE_TEXT,
        },
      },
    },
  };
}

/**
 * カレンダー格子＋左上の月名・年バッジ＋左下の署名を含むSatori要素ツリーを返す（純粋関数）。
 * @param {number} year
 * @param {number} month - 1〜12
 * @param {object} [options] - { width, height }
 */
export function _buildCalendarOverlayElement(year, month, options = {}) {
  const { width = 1080, height = 1920 } = options;
  const weeks = _buildCalendarWeeks(year, month);

  const headerRow = {
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "row", width: "100%" },
      children: WEEKDAY_LABELS.map((label, idx) => ({
        type: "div",
        props: {
          style: {
            display: "flex", flex: 1, justifyContent: "center",
            fontFamily: "WorkSans", fontSize: 22, fontWeight: 700,
            color: idx === 0 ? COLOR_SUNDAY_HOLIDAY : idx === 6 ? COLOR_SATURDAY : COLOR_WEEKDAY,
          },
          children: label,
        },
      })),
    },
  };

  const weekRows = weeks.map((week) => ({
    type: "div",
    props: {
      style: { display: "flex", flexDirection: "row", width: "100%", marginTop: 10 },
      children: week.map((day, idx) => ({
        type: "div",
        props: {
          style: {
            display: "flex", flex: 1, justifyContent: "center",
            fontFamily: "WorkSans", fontSize: 30,
            color: day === null ? "transparent" : _dayColor(year, month, day, idx),
          },
          children: day === null ? "" : String(day),
        },
      })),
    },
  }));

  // Bug#38: スマートフォン実機で見切れないよう、左右マージン・下端の浮きを画面サイズ比率で算出する
  const calMargin = Math.round(width * CALENDAR_MARGIN_RATIO);
  const safeBottom = Math.round(height * SAFE_AREA_RATIO);
  const calendarPanel = {
    type: "div",
    props: {
      style: {
        display: "flex", flexDirection: "column", position: "absolute",
        left: calMargin, right: calMargin, bottom: safeBottom + SIGNATURE_GAP_ABOVE_CALENDAR,
        padding: 28, borderRadius: 24,
        backgroundColor: "rgba(255,255,255,0.82)",
      },
      children: [headerRow, ...weekRows],
    },
  };

  // Bug#37: 元のバッジPNGデザイン案（「October」＋大きな「10」）のうち月番号がSatori書き換え時に
  // 抜け落ちていた。大きな月番号（左）＋月名・年を縦積みにしたブロック（右）の横並びに修正する
  const safeTop = Math.round(height * SAFE_AREA_RATIO);
  const monthBadge = {
    type: "div",
    props: {
      style: {
        display: "flex", flexDirection: "row", alignItems: "flex-end", position: "absolute",
        left: calMargin, top: safeTop, padding: "18px 26px", borderRadius: 20,
        backgroundColor: "rgba(255,255,255,0.82)",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", fontFamily: "Gloock", fontSize: 72, color: COLOR_WEEKDAY },
            children: String(month),
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", marginLeft: 16 },
            children: [
              {
                type: "div",
                props: {
                  style: { display: "flex", fontFamily: "Gloock", fontSize: 32, color: COLOR_WEEKDAY },
                  children: MONTH_NAMES_EN[month - 1],
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", fontFamily: "WorkSans", fontWeight: 700, fontSize: 22, color: COLOR_WEEKDAY },
                  children: String(year),
                },
              },
            ],
          },
        },
      ],
    },
  };

  const signature = _buildSignatureOnlyElement({ width, height }).props.children;

  return {
    type: "div",
    props: {
      style: { display: "flex", width, height, position: "relative" },
      children: [monthBadge, calendarPanel, signature],
    },
  };
}

/**
 * 生成画像に月替わり壁紙用のカレンダー/署名オーバーレイを合成する。
 * カレンダーあり版・なし版の2枚を返す。失敗時は元画像にフォールバックする
 * （`autoCropImage()`と同じ設計方針）。
 *
 * @param {string} imageData - base64エンコードされた生成画像
 * @param {number} year
 * @param {number} month - 1〜12
 * @param {object} [deps] - テスト用の依存注入
 * @returns {Promise<{calendarImageData: string, noCalendarImageData: string, mimeType: string, composited: boolean}>}
 */
export async function compositeMonthlyWallpaper(imageData, year, month, deps = {}) {
  const {
    ensurePhotonFn      = ensurePhoton,
    getPhotonImageFn    = getPhotonImage,
    getPhotonFnsFn      = getPhotonFns,
    renderElementToPngFn,
    ensureFontsFn,
    getFontsFn,
    width               = 1080,
    height              = 1920,
  } = deps;

  // Bug#37追記: error 1102（CPU/メモリ上限超過による強制終了）発生時、JS例外を伴わないため
  // どのステップまで到達したかをCloudflare側の実タイムスタンプ（query-worker-logs.mjs）から
  // 判断できるよう、主要ステップの直後に素のconsole.logを置く（recordCpuCheckpoint()は
  // worker/index.jsとの循環import制約により呼べないため、計測自体は呼び出し元のbot.jsで行う）
  console.log("[monthly-wallpaper-composite] 開始");
  try {
    await ensurePhotonFn();
    const PhotonImage = getPhotonImageFn();
    const { crop, resize, SamplingFilter, watermark, draw_text_with_border: drawTextWithBorder } = getPhotonFnsFn();

    if (ensureFontsFn) await ensureFontsFn();
    const fonts = getFontsFn ? getFontsFn() : [];

    const bytes = base64ToBytes(imageData);
    const srcImg = PhotonImage.new_from_byteslice(bytes);

    const srcW = srcImg.get_width();
    const srcH = srcImg.get_height();
    const scale = Math.max(width / srcW, height / srcH);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);
    const scaledImg = resize(srcImg, scaledW, scaledH, SamplingFilter.Lanczos3);
    const x1 = Math.round((scaledW - width) / 2);
    const y1 = Math.round((scaledH - height) / 2);
    const baseImg = crop(scaledImg, x1, y1, x1 + width, y1 + height);
    const baseBytes = baseImg.get_bytes();
    console.log("[monthly-wallpaper-composite] ベースクロップ完了");

    // Bug#37: カレンダーなし版限定の被写体センタリング。reserveCalendarSpaceのプロンプト指示で
    // 画像下部に余白（実測30〜46%）を空けさせているため、カレンダーあり版はカレンダー帯で
    // 覆えるがカレンダーなし版は覆うものがなく被写体が上寄りに見える。既存の_detectCropBox()
    // （/generateの自動トリミングと同じロジック）を再利用し、被写体の垂直中心を検出する。
    //
    // 当初は検出領域を切り出してcover-fitで1080x1920へズームイン再フィットする方式だったが、
    // Satori×2＋resvg×2＋Photon合成×2という既に重い処理に追加のLanczos3リサイズを丸ごと
    // 1回上乗せしたことで、本番でCloudflare Workersのerror 1102（CPU/メモリ上限超過による
    // 強制終了）を引き起こした（Bug#37追記）。resize()を一切追加しない「scaledImg内で
    // クロップ窓をずらすだけ」の軽量な方式に変更した。scaledImgに十分な垂直方向の余剰が
    // ない場合は効果が限定的というトレードオフがあるが、CPU予算超過による全体失敗より安全
    let noCalendarBaseBytes = baseBytes;
    try {
      const sampleW = 64;
      const sampleH = Math.round(sampleW * height / width);
      const small = resize(baseImg, sampleW, sampleH, SamplingFilter.Nearest);
      try {
        const pixels = small.get_raw_pixels();
        // 実測で余白量が30〜46%とばらつくため、/generateの自動トリミング用デフォルト
        // （maxMarginRatio=0.2）では過小評価してしまう
        const box = _detectCropBox(pixels, sampleW, sampleH, { maxMarginRatio: 0.5 });
        if (box) {
          const contentCenterY = (box.y1 + box.y2) / 2;
          const shiftPx = Math.round((contentCenterY - 0.5) * height);
          const newY1 = Math.max(0, Math.min(scaledH - height, y1 + shiftPx));
          if (Math.abs(newY1 - y1) >= 4) {
            const recropped = crop(scaledImg, x1, newY1, x1 + width, newY1 + height);
            try {
              noCalendarBaseBytes = recropped.get_bytes();
            } finally {
              recropped.free();
            }
          }
        }
      } finally {
        small.free();
      }
    } catch (err) {
      console.warn(`[monthly-wallpaper] カレンダーなし版の再センタリング失敗、通常クロップで継続: ${err.message}`);
    }
    console.log(`[monthly-wallpaper-composite] 再センタリング判定完了 shifted=${noCalendarBaseBytes !== baseBytes}`);

    // Bug#37追記: カレンダー版はSatori/resvgでの色分け・カスタムフォント描画が必須だが、
    // カレンダーなし版（署名のみ）はSatoriの表現力を必要としないため、CPU削減のため
    // Photonのdraw_text_with_border()（縁取り文字を直接画像へ焼き込む）に置き換えた。
    // Satori render・resvgラスタライズ・オーバーレイ用のPhoton合成を1セット分削除できる
    async function applyCalendarOverlay(element, sourceBytes) {
      const overlayPng = await renderElementToPngFn(element, { width, height, fonts });
      const overlayImg = PhotonImage.new_from_byteslice(overlayPng);
      const targetImg = PhotonImage.new_from_byteslice(sourceBytes);
      try {
        watermark(targetImg, overlayImg, 0n, 0n);
        return uint8ArrayToBase64(targetImg.get_bytes());
      } finally {
        overlayImg.free();
        targetImg.free();
      }
    }

    function drawSignature(sourceBytes) {
      const targetImg = PhotonImage.new_from_byteslice(sourceBytes);
      try {
        const fontSize = 26;
        // Bug#38: Satori版の_buildSignatureOnlyElement()と同じ比率でカレンダー帯の左端・
        // 下部セーフエリアに揃える（スマートフォン実機での見切れ対策）
        const x = Math.round(width * CALENDAR_MARGIN_RATIO);
        const y = height - Math.round(height * SAFE_AREA_RATIO) - fontSize;
        drawTextWithBorder(targetImg, SIGNATURE_TEXT, x, y, fontSize);
        return uint8ArrayToBase64(targetImg.get_bytes());
      } finally {
        targetImg.free();
      }
    }

    const calendarElement = _buildCalendarOverlayElement(year, month, { width, height });

    const calendarImageData = await applyCalendarOverlay(calendarElement, baseBytes);
    console.log("[monthly-wallpaper-composite] カレンダー版オーバーレイ描画完了");
    const noCalendarImageData = drawSignature(noCalendarBaseBytes);
    console.log("[monthly-wallpaper-composite] カレンダーなし版署名描画完了");

    srcImg.free();
    scaledImg.free();
    baseImg.free();

    return { calendarImageData, noCalendarImageData, mimeType: "image/png", composited: true };
  } catch (err) {
    console.warn(`[monthly-wallpaper] compositeMonthlyWallpaper失敗、未加工画像にフォールバック: ${err.message}`);
    return { calendarImageData: imageData, noCalendarImageData: imageData, mimeType: "image/png", composited: false };
  }
}
