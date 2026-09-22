/**
 * worker/svg-render.js - Satori（要素ツリー→SVG）+ @resvg/resvg-wasm（SVG→PNG）の共有ローダー
 *
 * 月替わり壁紙のカレンダー・月名オーバーレイをビットマップ（事前生成PNG）ではなく
 * ベクターテキストとして動的描画するために新設した。Photon（worker/image-utils.js）の
 * draw_text()はRobotoフォント固定・色指定不可のため、色付き・カスタムフォントの
 * テキスト描画にはSatori（CSS風スタイルでSVGを組み立てる）+ resvg（SVG→PNGラスタライズ、
 * テキストは既にSVGパス化済みのためフォント探索不要）を使う。
 *
 * **生のsatoriパッケージではなく@cf-wasm/satori/workerdを使う（2026-09・重要）**:
 * 素の`satori`（v0.30以降）は内部でharfbuzzjs（Emscripten生成のJS）に依存しており、
 * これがNode専用の`require("fs")`分岐を静的に含むため、`wrangler deploy --dry-run`で
 * ビルド自体が失敗する（`Could not resolve "fs"`）。実機での動作以前にデプロイ自体が
 * 不可能だった。Cloudflare Workers向けにこの問題を解決済みの`@cf-wasm/satori`
 * （fineshopdesignのcf-wasmモノレポ、`/workerd`エントリポイントでharfbuzz WASMを
 * インスタンス経由で渡す実装）に切り替えることで解消した。実際に`wrangler deploy
 * --dry-run`でビルド成功・gzip後約1.16MBを確認済み（Workers Free 3MB上限に十分な余裕）。
 *
 * Yoga（レイアウトエンジン、71KB）は`@cf-wasm/satori`が内部でバンドル・自動初期化する
 * （importした時点で`initSatori(yogaWasmModule)`が実行される）ため、こちら側での
 * 明示initは不要。
 *
 * **resvgのWASM（約2.4MB）はPhotonと同じビルド時ESM静的importでバンドルする（2026-09・重要）**:
 * 当初はバンドルサイズ節約のためR2バケットに配置し実行時にfetchする設計だったが、
 * Cloudflare Workersは実行時の動的WASMコード生成（生バイト列からのcompile/instantiate）を
 * セキュリティ上禁止しており、実際に本番で`WebAssembly.instantiate(): Wasm code generation
 * disallowed by embedder`エラーが発生した（.claude/bugs-history.mdのBug#36参照）。
 * Photon（worker/image-utils.jsのensurePhoton()）が実際に本番稼働している
 * 「WASMをESM静的importしビルド時にWebAssembly.Moduleとしてプリコンパイルする」パターンに
 * 統一して解消した。`@resvg/resvg-wasm`のinitWasm()は引数がResponseでない場合
 * WebAssembly.instantiate(module, imports)（コンパイル済みモジュールのインスタンス化のみ）を
 * 呼ぶため、この経路は動的コード生成の禁止に抵触しない。
 * 実測: wrangler deploy --dry-runでビルド成功・gzip後約2.05MB
 * （Workers Free 3MB上限内、当初懸念したサイズ超過は実測では発生しなかった）。
 */

let _satoriReady = false;
let _satoriFn    = null; // satori(element, options) => Promise<string(svg)>

let _resvgReady = false;
let _Resvg      = null;

/** Satori本体 + Yoga（レイアウトエンジンWASM）を遅延ロードする */
export async function ensureSatori() {
  if (_satoriReady) return;
  const mod = await import("@cf-wasm/satori/workerd");
  await mod.initSatori.ensure();
  _satoriFn = mod.satori;
  _satoriReady = true;
}

export function getSatoriFn() { return _satoriFn; }

/** テスト用: Satoriのモックを注入する */
export function _setSatoriForTest(mockSatoriFn) {
  _satoriFn = mockSatoriFn;
  _satoriReady = mockSatoriFn !== null;
}

/** resvg（SVG→PNGラスタライザー）を遅延ロードする。WASMはビルド時に静的importでプリコンパイルする。 */
export async function ensureResvg() {
  if (_resvgReady) return;
  const mod = await import("@resvg/resvg-wasm");
  const { default: resvgWasm } = await import("@resvg/resvg-wasm/index_bg.wasm");
  await mod.initWasm(resvgWasm);
  _Resvg = mod.Resvg;
  _resvgReady = true;
}

export function getResvgClass() { return _Resvg; }

/** テスト用: resvgのモックを注入する */
export function _setResvgForTest(mockResvgClass) {
  _Resvg = mockResvgClass;
  _resvgReady = mockResvgClass !== null;
}

let _fontsReady = false;
let _fonts      = null; // [{name, data, weight, style}]

/**
 * カレンダーオーバーレイ用のカスタムフォント（Gloock・WorkSans、いずれもOFLライセンス）を
 * worker/assets/fonts/からArrayBufferとして遅延ロードする。wrangler.tomlの[[rules]]で
 * .ttfをDataモジュール（ArrayBuffer）としてimportできるよう設定済み。
 */
export async function ensureFonts() {
  if (_fontsReady) return;
  const [{ default: gloock }, { default: workSansRegular }, { default: workSansBold }] = await Promise.all([
    import("./assets/fonts/Gloock-Regular.ttf"),
    import("./assets/fonts/WorkSans-Regular.ttf"),
    import("./assets/fonts/WorkSans-Bold.ttf"),
  ]);
  _fonts = [
    { name: "Gloock", data: gloock, weight: 400, style: "normal" },
    { name: "WorkSans", data: workSansRegular, weight: 400, style: "normal" },
    { name: "WorkSans", data: workSansBold, weight: 700, style: "normal" },
  ];
  _fontsReady = true;
}

export function getFonts() { return _fonts; }

/** テスト用: フォントのモックを注入する */
export function _setFontsForTest(mockFonts) {
  _fonts = mockFonts;
  _fontsReady = mockFonts !== null;
}

/**
 * Satori要素ツリー（JSX形状のプレーンオブジェクト。ReactNode不要）をPNG（Uint8Array）に変換する。
 *
 * @param {object} element - { type, props: { style, children, ... } } 形式
 * @param {object} options - { width, height, fonts: [{name, data, weight, style}] }
 * @param {object} [deps] - テスト用の依存注入
 * @returns {Promise<Uint8Array>}
 */
export async function renderElementToPng(element, options, deps = {}) {
  const {
    ensureSatoriFn = ensureSatori,
    ensureResvgFn  = ensureResvg,
    getSatoriFnFn  = getSatoriFn,
    getResvgClassFn = getResvgClass,
  } = deps;

  await ensureSatoriFn();
  await ensureResvgFn();

  const satori = getSatoriFnFn();
  const Resvg  = getResvgClassFn();

  const svg = await satori(element, options);
  // font.loadSystemFonts: Satoriの出力はテキストが既にSVGパス化済みでresvg側のフォント探索が
  // 発生しないため無効化する（デフォルトtrueのままだと不要なシステムフォント走査が走りうる）
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: options.width }, font: { loadSystemFonts: false } });
  const rendered = resvg.render();
  return rendered.asPng();
}
