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
  _photonFns   = { crop: mod.crop, resize: mod.resize, SamplingFilter: mod.SamplingFilter };
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
