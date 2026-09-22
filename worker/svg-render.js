/**
 * worker/svg-render.js - Satori（要素ツリー→SVG）+ @resvg/resvg-wasm（SVG→PNG）の共有ローダー
 *
 * 月替わり壁紙のカレンダー・月名オーバーレイをビットマップ（事前生成PNG）ではなく
 * ベクターテキストとして動的描画するために新設した。Photon（worker/image-utils.js）の
 * draw_text()はRobotoフォント固定・色指定不可のため、色付き・カスタムフォントの
 * テキスト描画にはSatori（CSS風スタイルでSVGを組み立てる）+ resvg（SVG→PNGラスタライズ、
 * テキストは既にSVGパス化済みのためフォント探索不要）を使う。
 *
 * サイズの都合上、Satori本体とYoga（レイアウトエンジン、71KB）はPhotonと同じ
 * 直接importでバンドルするが、resvgのWASM（約2.4MB）はバンドルするとWorkers Free
 * プランのスクリプトサイズ上限（gzip圧縮後3MB）をPhoton分と合わせて圧迫するため、
 * R2バケット（既存のIMAGE_BUCKET）に静的アセットとして配置し、実行時にfetchする
 * （worker/index.jsの/back/:id・/hires/:idと同じ「R2をアセットストアとして使う」パターン）。
 *
 * resvg.wasmのR2配置は初回のみ手動で行う（デプロイ手順書参照）:
 *   wrangler r2 object put anniversary-cat-images/assets/resvg.wasm \
 *     --file node_modules/@resvg/resvg-wasm/index_bg.wasm
 */

let _satoriReady = false;
let _satoriFn    = null; // satori(element, options) => Promise<string(svg)>

let _resvgReady = false;
let _Resvg      = null;

const RESVG_WASM_R2_KEY = "assets/resvg.wasm";

/** Satori本体 + Yoga（レイアウトエンジンWASM）を遅延ロードする */
export async function ensureSatori() {
  if (_satoriReady) return;
  const mod = await import("satori/standalone");
  const { default: yogaWasm } = await import("satori/yoga.wasm");
  await mod.init(yogaWasm);
  _satoriFn = mod.default;
  _satoriReady = true;
}

export function getSatoriFn() { return _satoriFn; }

/** テスト用: Satoriのモックを注入する */
export function _setSatoriForTest(mockSatoriFn) {
  _satoriFn = mockSatoriFn;
  _satoriReady = mockSatoriFn !== null;
}

/**
 * resvg（SVG→PNGラスタライザー）を遅延ロードする。
 * WASMバイナリはR2（IMAGE_BUCKET）から取得する。バケット未配置の場合はエラーを投げる。
 *
 * @param {R2Bucket} bucket - env.IMAGE_BUCKET
 */
export async function ensureResvg(bucket) {
  if (_resvgReady) return;
  const mod = await import("@resvg/resvg-wasm");
  const obj = await bucket.get(RESVG_WASM_R2_KEY);
  if (!obj) {
    throw new Error(`[svg-render] resvg.wasmがR2に見つかりません（キー: ${RESVG_WASM_R2_KEY}）。デプロイ手順書の初回セットアップ手順を確認してください。`);
  }
  const wasmBytes = await obj.arrayBuffer();
  await mod.initWasm(wasmBytes);
  _Resvg = mod.Resvg;
  _resvgReady = true;
}

export function getResvgClass() { return _Resvg; }

/** テスト用: resvgのモックを注入する */
export function _setResvgForTest(mockResvgClass) {
  _Resvg = mockResvgClass;
  _resvgReady = mockResvgClass !== null;
}

/**
 * Satori要素ツリー（JSX形状のプレーンオブジェクト。ReactNode不要）をPNG（Uint8Array）に変換する。
 *
 * @param {object} element - { type, props: { style, children, ... } } 形式
 * @param {object} options - { width, height, fonts: [{name, data, weight, style}] }
 * @param {R2Bucket} bucket - resvg.wasm取得用（env.IMAGE_BUCKET）
 * @param {object} [deps] - テスト用の依存注入
 * @returns {Promise<Uint8Array>}
 */
export async function renderElementToPng(element, options, bucket, deps = {}) {
  const {
    ensureSatoriFn = ensureSatori,
    ensureResvgFn  = ensureResvg,
    getSatoriFnFn  = getSatoriFn,
    getResvgClassFn = getResvgClass,
  } = deps;

  await ensureSatoriFn();
  await ensureResvgFn(bucket);

  const satori = getSatoriFnFn();
  const Resvg  = getResvgClassFn();

  const svg = await satori(element, options);
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: options.width } });
  const rendered = resvg.render();
  return rendered.asPng();
}
