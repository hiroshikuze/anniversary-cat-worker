# アーキテクチャ詳細: 月替わり壁紙プレゼント機能（`worker/bot.js` `runMonthlyWallpaperPost()`・2026-09追加）

> `.claude/rules/architecture.md`から移動した（2026-10）。毎セッション自動で読み込まれるファイルを軽くするため、詳細をこのファイルに分けた。本文は移動前のまま。

## 月替わり壁紙プレゼント機能（`worker/bot.js` `runMonthlyWallpaperPost()`・2026-09追加）

### 背景

集客診断（Umami/Bluesky/Mastodon実データ）で、ボトルネックはSUZURI導線や価格ではなく「SNS上での露出（リーチ）」だと判明した（詳細は`.claude/future-ideas.md`の「集客・マーケティング診断」参照）。サイト機能・SUZURI化には投資せず、まず「毎月の壁紙プレゼント」という新しいコンテンツ形態がフォロワー増・エンゲージメント増に効くかをSNS単体（Bluesky/Mastodon自動投稿）で安く検証する。X/Instagram/Facebook/mixi2への展開は、Discord通知に含まれる転載用テキストを使った手動コピペ運用とする。

### 月テーマの決定（新規データテーブルなし）

**「対象月」＝JST基準で「今日」が属する月の翌月**（`worker/bot.js` `resolveTargetYearMonth()`）。月末チェック（`"0 15 * * *"`の分岐内で`isLastDayOfMonthJST()`が月末日のみ発火させる。下記「Cron（月末自動生成）」参照）は「今月末に来月分の壁紙を配る」設計のため、例えば9/30発火時は10月の壁紙を生成する。手動再生成エンドポイントも同じ関数を使うため、月初〜月末のどのタイミングで手動実行しても常に「次に来る月」の壁紙になる（当月分を作りたい場合は月初に手動実行する）。

対象月の**末日**の日付文字列（`YYYY-MM-DD`）を既存の`getSeasonalFlower()`/`getSeasonalFlowerVisual()`/`getSeasonalStyleTone()`/`getSeasonalFlowerEn()`（`worker/index.js`）にそのまま渡し、`SEASONAL_FLOWERS`（24エントリ・半月区切り）の該当後半エントリを月テーマとして流用する。全月の末日は必ず後半エントリ（`16日〜末日`区切り）に一致する設計のため、常に安定して選ばれる（例: 10月末日→「金木犀」）。新規の月別テーブルは作らない。

### 画像生成: 既存`handleGenerate()`の拡張利用

新しい生成パイプラインは作らず、既存の2フェーズレース（Gemini→Pollinationsフォールバック）・モデル自動切替・CPU計測をそのまま利用する。

- `handleGenerate()`呼び出し時の`body`: `{ theme, description, visualHint, themeEn, descriptionEn, jstDateISO: <対象月の末日>, reserveCalendarSpace: true }`
- `jstDateISO`を対象月の末日で明示的に渡すことで、手動再生成が別の日に実行されても季節カラー・花テーマが対象月とズレない（内部の`getSeasonalStyleTone()`は「今日の日付」がデフォルトのため）
- **ゲストキャラクター（`pickGuestAnimal()`・10%出現）は除外しない**（意図的な仕様判断。「たまに違う動物が混ざる意外性も味」とユーザーが判断）
- `body.foodItem`を渡さないため`eatingAction`は発生しない（対応不要）
- `_buildGeminiPrompt()`/`_buildPollinationsPrompt()`に新しい引数`reserveCalendarSpace = false`を追加。`true`のとき以下を構図指示に追加する:
  - 縦長9:16のアスペクト比指定（日次プロンプトには元々なし。SUZURI用の正方形寄り想定だったため）
  - 画像下部30%程度を、カレンダー格子を重ねるための平坦で明るい余白帯として残す指示
  - 画像左上の一角を、月名ラベルを重ねるための平坦な余白として残す指示
  - 禁止事項に「文字・数字を含めない」を強化（カレンダー数字・月名バッジとの視覚的衝突回避）
  - AIの構図指示遵守は完全ではない（実測で指示した30%に対し実際は46%の余白ができた例あり）ため、余白の実際の量には依存しない設計にしている。Satoriのオーバーレイパネル自体が半透明背景で可読性を担保するため、ランタイムでの空白帯検出は行わない（下記「設計簡略化」参照）

### カレンダー・月名の合成（`worker/image-utils.js` `compositeMonthlyWallpaper()` + `worker/svg-render.js`）

**設計変更（2026-09）**: 当初はPhotonの`draw_text()`（Roboto固定・色指定不可）＋事前生成バッジPNGのハイブリッド方式で実装しかけたが、ユーザーから「ビットマップテキストは解像度変更等の柔軟性を下げるので避けたい」と明確な差し戻しを受けた。調査の結果、色付き・カスタムフォントのベクターテキストをCloudflare Workersで動的生成する標準パターンとして**Satori（要素ツリー→SVG）+ `@resvg/resvg-wasm`（SVG→PNGラスタライズ）**を採用した（OGP画像生成等で広く使われる組み合わせ）。事前生成の月名バッジPNG（`worker/assets/month-badges/`）は廃止・削除済み。

- `worker/svg-render.js`が共有ローダー（`worker/image-utils.js`のPhotonローダーと同じ「遅延ロード＋`_setXForTest()`」パターン）: `ensureSatori()`（Satori本体＋レイアウトエンジンYoga）、`ensureResvg()`（resvgのWASM本体、約2.4MB）、`renderElementToPng(element, options, deps)`
- **生の`satori`パッケージではなく`@cf-wasm/satori`（`/workerd`エントリポイント）を使う（2026-09・重要な設計判断）**: 素の`satori`（v0.30以降）はharfbuzzjs（Emscripten生成JS）に依存し、Node専用の`require("fs")`分岐を静的に含むため、`wrangler deploy --dry-run`の時点でビルドが失敗する（`Could not resolve "fs"`）。実機動作の検証以前にデプロイ自体が不可能な状態だった。Cloudflare Workers向けにこの問題を解決済みの`@cf-wasm/satori`（fineshopdesignのcf-wasmモノレポ）に切り替えて解消した。Yoga（レイアウトエンジン、71KB）はこのパッケージが内部でバンドル・import時に自動初期化するため、明示initは不要
- **resvgのWASM（約2.4MB）はPhotonと同じ「ビルド時ESM静的import」でバンドルする（2026-09・R2実行時fetchから変更・Bug#36）**: 当初はスクリプトサイズ上限（gzip後3MB）を懸念しR2（既存`IMAGE_BUCKET`）に配置して実行時に`fetch()`し`WebAssembly.instantiate(bytes)`でコンパイルする設計だったが、実際に本番デプロイ後の`POST /monthly-wallpaper/regenerate`実行で`WebAssembly.instantiate(): Wasm code generation disallowed by embedder`エラーが発生した。Cloudflare Workersは実行時の動的WASMコンパイル（生バイト列からのコンパイル）をセキュリティ上禁止しており、この設計は原理的に動作しないと判明した（投稿自体は`compositeMonthlyWallpaper()`のフォールバック設計により未加工画像で継続していたため実害は「カレンダー合成なし」にとどまった）。修正はPhoton（`worker/image-utils.js`）が実際に本番稼働している`import wasm from "パッケージ名/xxx.wasm"`（ビルド時に`WebAssembly.Module`としてプリコンパイルされる）と同じ静的import方式に統一した。`@resvg/resvg-wasm`の`initWasm()`は引数が`Response`でない場合`WebAssembly.instantiate(module, imports)`を呼ぶ実装（`node_modules/@resvg/resvg-wasm/index.mjs`で確認）で、これはコンパイル済みモジュールのインスタンス化のみのため動的コード生成の禁止に抵触しない
- **実測**: `wrangler deploy --dry-run --outdir=...`でビルド成功・Total Upload 6076.36 KiB / gzip 2096.70 KiB（約2.05MB）を確認済み（2026-09・resvg静的バンドル後）。Workers Freeプランのgzip 3MB上限に対し引き続き余裕がある（当初懸念していたサイズ超過は実測では発生しなかった）
- **`ensureResvg()`はシングルフライトパターンで並行呼び出しに対応する（2026-09・Bug#36追記）**: `compositeMonthlyWallpaper()`がカレンダー版・署名版を`Promise.all()`で並行生成するため`ensureResvg()`も並行に呼ばれる。`@resvg/resvg-wasm`の`initWasm()`は2回目の呼び出しで`Already initialized`例外を投げる一度きりのAPIのため、`_resvgReady`真偽値フラグの早期returnだけでは競合を防げない（静的import化の1回目の修正デプロイ後に実機で発覚）。進行中の初期化`Promise`を共有し実際の`initWasm()`呼び出しを1回に限定する。WASMロード処理自体は`_loadResvg()`として切り出し、`ensureResvg(deps = {})`の`deps.loadResvgFn`で注入可能にすることで、このレースコンディション自体を`scripts/test-bot.mjs`でユニットテスト可能にしている
- Satoriが描画するのはテキスト・図形のオーバーレイ（カレンダー格子・月名・年・署名）のみで透過PNGとして出力する。**AI生成した猫写真自体をSatoriの要素ツリーに埋め込まない**（SatoriのWorkers上での画像fetchは動作しないことが既知のため）。写真の切り抜き・リサイズ・最終合成（オーバーレイの`watermark()`貼り付け）は引き続きPhotonが担当する
- カスタムフォント（Gloock・WorkSans、いずれもGoogle FontsのOFLライセンス）は`worker/assets/fonts/`にTTF形式でリポジトリ管理し、Satoriの`options.fonts`にArrayBufferとして渡す

**設計簡略化（2026-09・ランタイム空白帯検出は行わない）**: 当初案は画像下部の空白帯を`_detectCropBox()`同系統のロジックでランタイム検出する想定だったが、Satoriのオーバーレイ自体に半透明の背景パネル（カレンダー帯・左上バッジそれぞれに）を常時描画することで、被写体がどこにあっても可読性を保証できると判断し、検出ロジックは実装しない（旧・月名バッジ案で採用した「バッジPNGにソフトグローを焼き込み、実行時判定を省く」という簡略化と同じ考え方をSatori版にも踏襲）。可動部を減らすことで壊れ方が減り、フォールバックの分岐も単純になる。

**祝日ライブラリの選定**: `@holiday-jp/holiday_jp`（npm、依存パッケージなし・Node組み込みAPI不使用・`isHoliday(date)`が祝日名または`false`を返す純粋な日付テーブル方式）を採用。比較検討した`japanese-holidays`より依存が少なく、内蔵テーブルが2050年まで事前計算済みでランタイムの祝日計算ロジックを持たない点を評価した。

**関数設計**:

- `_buildCalendarOverlayElement(year, month, options)`（`worker/image-utils.js`・純粋関数）: 指定年月のカレンダー格子（曜日見出し・日付数字・日曜/祝日=赤・土曜=青・`@holiday-jp/holiday_jp`で祝日判定）＋左上の月名・年バッジ（月番号を大きく＋月名・年を並べて表示。詳細は下記「月名バッジの構成」参照）を含むSatori要素ツリー（JSX形状のプレーンオブジェクト）を返す。`options`にキャンバスサイズ・フォント名を渡す。**「© nyanmusu」署名はBug#39で事前生成PNGアセット化されたため、この要素ツリーには含まれない（下記「署名を事前生成PNGアセット化」参照）**
- `compositeMonthlyWallpaper(imageData, year, month, deps = {})`（`worker/image-utils.js`）: `autoCropImage()`と同じ「依存関数を引数で受け取る」テストパターンを踏襲

**月名バッジの構成（2026-09修正）**: 当初の実装は`monthBadge`が月名（`October`）と年（`2026`）のみを描画しており、事前生成バッジPNG時代の元デザイン（「October」＋大きな「10」の月番号を並べる構成）にあった月番号が抜け落ちていた。実機投稿で発覚（ユーザー指摘）し修正した。現在は`monthBadge`を横並び（`flexDirection: "row"`）にし、大きな月番号（`String(month)`・Gloock・大サイズ）を左に、月名＋年を縦積みにしたブロックを右に配置する。

**カレンダーなし版の被写体センタリング（2026-09追加・実機投稿で発覚）**: 当初の実装はカレンダーあり版・なし版とも同一のcover-crop画像を共有していた。`reserveCalendarSpace`のプロンプト指示で画像下部に余白（実測30〜46%）を空けさせているため、カレンダーあり版はカレンダー帯でその余白を覆えるが、カレンダーなし版は覆うものがなく被写体が上寄りに見え、下に不自然な空白が残っていた（ユーザー指摘）。

修正は既存の`_detectCropBox()`（`/generate`の自動トリミング機能・`autoCropImage()`と共通のWASM非依存ロジック）を再利用する。

**設計変更（2026-09・実機でCloudflare error 1102＝Worker強制終了を検知）**: 当初案は検出領域を切り出してから`coverCrop()`（cover-fit：アスペクト比を保って拡大しはみ出た分を対称にクロップする処理）で改めて1080×1920へ**ズームイン**して再フィットする方式だった。デプロイ直後の実機検証で`POST /monthly-wallpaper/regenerate`が`error 1102`を返しDiscord通知も届かない障害が発生した。`query-worker-logs.mjs`で実ログを確認すると、`generate 完了`ログの直後・`カレンダー合成失敗`警告すら出ないまま途切れており、JS例外（`try/catch`で捕捉可能）ではなくCloudflare基盤側の強制終了（CPU/メモリ上限超過）と判明した。Satori×2レンダリング＋resvgラスタライズ×2＋Photon合成×2という元々重い処理に、ズームイン方式が追加の高品質リサイズ（`SamplingFilter.Lanczos3`）を丸ごともう1回加えたことがCPU予算を超過させたと判断し、**リサイズを伴わない「同一スケール内でのシフトのみ」の軽量な再センタリング**に設計変更した:

1. 生成画像をこれまで通りcover-fitで1080×1920のベース画像（`baseImg`/`baseBytes`）を作る際、その手前で使うスケール済み画像（`scaledImg`。目標サイズより一回り大きい）を`compositeMonthlyWallpaper()`のスコープ内に保持しておく（従来は`baseImg`生成直後に解放していたが、なし版のシフトに再利用するため解放を遅らせる）
2. `baseImg`を64px幅（アスペクト比維持）にダウンサンプルし`_detectCropBox()`で被写体のバウンディングボックスを検出。`maxMarginRatio`は`/generate`用デフォルトの`0.2`ではなく`0.5`を指定する（実測30〜46%の余白量を正しく検出するため）
3. 検出できた場合、被写体の垂直方向の中心位置を計算し、`scaledImg`内でのクロップ開始位置（`y1`）を「被写体が新しい窓の中心に来る」ようシフトさせる。シフト量は`scaledImg`の余剰分（`scaledImg`の高さ − 1080×1920の高さ）の範囲でクランプする。**リサイズは一切行わず、`scaledImg`から窓をずらして`crop()`するだけ**（ズームなし・平行移動のみ）
4. シフト量が小さい（4px未満）・検出できない・`scaledImg`に余剰分がなく実質シフトできない場合は`baseImg`をそのまま使う（安全策・`autoCropImage()`と同じ設計方針）
5. この再センタリング処理全体を個別の`try/catch`で囲み、失敗時は`baseImg`にフォールバックする（カレンダーあり版の生成自体には影響させない。`compositeMonthlyWallpaper()`全体の外側`try/catch`とは別のより狭いフォールバック）

この方式は「AIが生成した画像に元々十分な縦方向の余剰（`scaledImg`が目標サイズより大きい分）がある場合」にのみ被写体を動かせるトレードオフがある（プロンプトが9:16ちょうどで生成させているため余剰が小さいケースでは効果が限定的）。ただしCPU予算超過でリクエストごと失敗する（Discord通知すら届かない）よりは、被写体の位置調整が部分的にとどまる方が実害が小さいと判断した。詳細は`.claude/bugs-history.md`のBug#37追記参照。

**合成処理の流れ**:

1. 生成画像を1080×1920（スマホ壁紙・フルHD縦。実際のデフォルト出力解像度は下記「最終拡大の撤回」参照）へcover-cropでリサイズ（Photon）
2. `_buildCalendarOverlayElement()`でカレンダー版の要素ツリーを組み立て、`renderElementToPng()`（`worker/svg-render.js`）でオーバーレイPNGを生成
3. オーバーレイPNGをPhotonの`watermark()`で生成画像に貼り付け、続けて署名アセット（`worker/assets/signature.png`）も`watermark()`で貼り付ける（カレンダー版・Bug#39）
4. 「カレンダーなし」版も同時に生成する: 上記「カレンダーなし版の被写体センタリング」で得た画像に署名アセットのみを`watermark()`で貼り付けたもの（full-bleed、カレンダー帯・月名バッジなし。Bug#39以前はSatoriの署名オーバーレイを使用していた）
5. 失敗時（Photon/Satori/resvg読み込み失敗等）は既存`autoCropImage()`と同様、未加工画像にフォールバックし処理全体は失敗させない

**実装状況（2026-09時点）**: `worker/svg-render.js`（`@cf-wasm/satori`ベースのローダー・フォントローダー`ensureFonts()`・`renderElementToPng()`）、`worker/image-utils.js`（`_buildCalendarOverlayElement()`/`compositeMonthlyWallpaper()`/署名アセットローダー`ensureSignatureAsset()`。Bug#39以前は`_buildSignatureOnlyElement()`も存在したが廃止済み）、`worker/index.js`（プロンプト拡張・`isLastDayOfMonthJST()`・Cron分岐・`/monthly-wallpaper/regenerate`）、`worker/bot.js`（`runMonthlyWallpaperPost()`・`createMonthlyWallpaperPost()`・投稿文言関数）まで実装済み。`wrangler.toml`にCron追加済み。ユニットテスト（`scripts/test-bot.mjs`、モック経由）含め`npm test`全件成功。`wrangler deploy --dry-run`でのビルド成功・バンドルサイズ確認済み（上記「実測」参照）。スマートフォン実機でのセーフエリア調整（Bug#38・上記「スマートフォン実機でのセーフエリア調整」参照）も実装済み。署名の可読性修正（Bug#39・上記「署名を事前生成PNGアセット化」参照）はローカルユニットテスト・`wrangler deploy --dry-run`のビルド確認済みだが、実機での可読性確認は次回の手動再生成実行時にユーザーが確認する（本ドキュメント執筆時点で未デプロイ）。

**実機検証の結果（2026-09・2ラウンド実施済み・3ラウンド目待ち）**: デプロイ後、ユーザーが`POST /monthly-wallpaper/regenerate`を`X-Bypass-Token`ヘッダー付きで手動実行。

- **1ラウンド目**: Bluesky/Mastodonへの投稿自体は成功したが、`compositeMonthlyWallpaper()`が失敗し未加工画像にフォールバックしていた（`composited: false`）。`query-worker-logs.mjs`で実ログを確認し、上記「resvgのWASM」項に記載の`Wasm code generation disallowed by embedder`エラーを特定・修正しデプロイ（Bug#36本体）
- **2ラウンド目**: 修正後に再実行しても依然`composited: false`。再度`query-worker-logs.mjs`で確認したところ、今度は別のエラー`Already initialized. The initWasm() function can be used only once.`に変わっていた。上記「`ensureResvg()`はシングルフライトパターン」項に記載の並行呼び出し競合を特定・修正（Bug#36追記）。**この修正はPR #182として作成済みだが、本ドキュメント執筆時点で未マージ・未デプロイ**
- **3ラウンド目**: PR #182マージ・デプロイ後に`composited: true`を確認（resvg関連の障害は解消）。ただしBluesky投稿の目視確認で新たに2件の見た目の問題が判明: (1) 月名バッジに月番号「10」が表示されていない、(2) カレンダーなし版で被写体が上寄りになり下に不自然な余白が残る。いずれも上記「月名バッジの構成」「カレンダーなし版の被写体センタリング」で修正済み
- **4ラウンド目**: PR #183マージ・デプロイ後に`/monthly-wallpaper/regenerate`を再実行したところ`error 1102`（Cloudflare Workers強制終了・CPU/メモリ上限超過）が返りDiscord通知も届かなかった。`query-worker-logs.mjs`でログを確認すると`generate 完了`直後・`カレンダー合成失敗`警告すら出ないまま途切れており、JS例外ではなく基盤側の強制終了と判明。カレンダーなし版センタリング（3ラウンド目の修正）が追加した「検出領域をズームインして再フィット」処理（追加のLanczos3リサイズ）がCPU予算を超過させたと判断し、リサイズを伴わない軽量なシフト方式に設計変更した（Bug#37追記。詳細は上記「カレンダーなし版の被写体センタリング」の「設計変更」参照）
- **5ラウンド目**: PR #184マージ・デプロイ後、ユーザーが`POST /monthly-wallpaper/regenerate`を2回連続で手動実行。**1回目は`error 1102`が再発、2回目は`composited: true`で完走**（Bluesky/Mastodon投稿・Discord通知とも成功）。`query-worker-logs.mjs`で1回目のログを確認すると、`再センタリング判定完了`の直後で途切れておりオーバーレイ描画（`Promise.all([applyOverlay(カレンダー版), applyOverlay(カレンダーなし版)])`＝Satori×2＋resvg×2＋Photon合成×2）の区間で強制終了していたと判明。Bug#37追記のシフト方式への変更で以前より先まで進むようにはなったが、**真のCPUボトルネックはSatori/resvgのオーバーレイ描画そのもの**（未着手）であり、生成画像の内容による処理時間のばらつき次第で成否が分かれる不安定な状態が続いていた
- **6ラウンド目（未実施・PR #185）**: 下記「カレンダーなし版のSatori/resvg排除」（error 1102対策）と「スマートフォン実機でのセーフエリア調整」（Bug#38・見切れ対策）の両方をまとめて含むPR #185をデプロイ後、再度`/monthly-wallpaper/regenerate`を複数回実行し、(a) `error 1102`の再現率が実際に下がったか、(b) iPhone/Androidの実機で月名バッジ・カレンダー帯・署名が見切れなくなったかの2点を確認する必要がある（(a)は完全に0%になる保証はない。カレンダー版のSatori/resvgは維持しているため）

**CPU時間の計測追加（2026-09・Bug#37追記の再発防止・PR #184に含む）**: 軽量化の効果を推測ではなく実測で確認できるようにするため、`runMonthlyWallpaperPost()`の`compositeMonthlyWallpaperFn()`呼び出しを`recordCpuCheckpoint("monthly-wallpaper-composite", ..., env.RATE_KV)`で計測しKV集計する（`/cpu-usage`で確認可能。月次1回・手動再生成時のみの低頻度経路のためKV書き込み予算への影響は無視できる）。ただし**この計測値がそのまま信頼できるとは限らない**: `generate-autoCrop`の計測（上記「CPU計測は機能しないことが判明」参照）と同様、`compositeMonthlyWallpaper()`内部はPhoton・Satori・resvgいずれも同期的なWASM呼び出しでI/Oを挟まないため、`performance.now()`が計測区間内で一切進まず差分が0msになる可能性がある。この計測値がゼロや不自然に小さい値を示した場合でも「処理が軽い」と早合点せず、`compositeMonthlyWallpaper()`内部に追加した詳細な`console.log`（下記）とCloudflare側が記録する実タイムスタンプ（`query-worker-logs.mjs`で確認）を併用し、どのステップまで到達してから終了したかで実態を判断する。

`recordCpuCheckpoint()`は`worker/index.js`で定義されており、`worker/image-utils.js`は`worker/index.js`にimportされる側（逆方向importは循環参照になる。`worker/r2-storage.js`と同じ制約）のため、`compositeMonthlyWallpaper()`内部には`recordCpuCheckpoint()`を直接呼ばず、素の`console.log()`（`[monthly-wallpaper-composite]`プレフィックス）を主要ステップ（開始・ベースクロップ完了・再センタリング検出/シフト判定・カレンダー版/カレンダーなし版オーバーレイ描画それぞれの完了）の直後に追加した。計測（`recordCpuCheckpoint`）は呼び出し元の`runMonthlyWallpaperPost()`（`worker/bot.js`、既に`recordCpuCheckpoint`をimport済み）側で全体時間のみラップする。

**カレンダーなし版のSatori/resvg排除（2026-09・5ラウンド目で1102の再発を確認して追加対応）**: 5ラウンド目の実機検証で、シフト方式への軽量化後も`error 1102`が（毎回ではないが）再発することを確認した。`query-worker-logs.mjs`で失敗ログを見ると、`再センタリング判定完了`の直後・`オーバーレイ描画完了`の手前で途切れており、真のCPUボトルネックは`Promise.all([applyOverlay(カレンダー版), applyOverlay(カレンダーなし版)])`区間（Satori×2＋resvgラスタライズ×2＋Photon合成×2）にあると判明した。

カレンダー版は日付ごとの色分け（日曜/祝日=赤・土曜=青）とカスタムフォントが必須のためSatori/resvgを維持するしかないが、**カレンダーなし版（「© nyanmusu」署名のみ）はSatoriの表現力を必要としない**。3案を比較した:

1. **署名をPhotonの`draw_text_with_border()`に置き換える（採用）**: Satori render・resvgラスタライズ・オーバーレイ用のPhoton合成（`watermark()`＋PNGデコード2回）を丸ごと1セット削除できる。削減効果が最も大きく確実
2. カレンダー要素数（日付セル等）を削減してSatoriのレイアウト計算コストを削る: resvgのラスタライズ（解像度依存）が支配的コストである可能性が高く効果が不確実。カレンダー版は引き続き必要なため実装リスクの割に効果が薄い
3. オーバーレイの出力解像度を下げてPhotonで拡大: ラスタライズコストは下がるが追加のリサイズで一部相殺し、カレンダーの文字視認性が落ちるリスクがある

1を採用し、`compositeMonthlyWallpaper()`はSatori/resvgをカレンダー版の1回のみ呼び出す（従来の2回から半減）。カレンダーなし版は`noCalendarBaseBytes`をデコードしたPhoton画像に`draw_text_with_border(img, "© nyanmusu", x, y, fontSize)`を直接描画し（オーバーレイPNGの生成・合成が不要になる）、そのまま`get_bytes()`する。

**署名の黒背景パネルは削除（2026-09・ユーザー指摘で判明した実装ミス）**: `_buildSignatureOnlyElement()`は当初から`backgroundColor: "rgba(0,0,0,0.35)"`の半透明黒背景パネルを描画していたが、これは最初から不要という指定だったにもかかわらず実装時に反映されていなかった（`.claude/bugs-history.md`の別機能・フロントエンドCanvas watermarkの黒背景仕様と混同したとみられる）。`_buildSignatureOnlyElement()`から背景パネルを削除し、白文字のみにした。この時点ではカレンダー版（Satori継続使用）・カレンダーなし版（Photon `draw_text_with_border()`）の両方に適用されたが、この対応は後にBug#39で置き換えられている（下記「署名を事前生成PNGアセット化」参照）。

### 署名を事前生成PNGアセット化（2026-09・Bug#39）

上記の「黒背景パネル削除」後、実機投稿の目視確認で署名（© nyanmusu）が判読できない問題が2種類見つかった（詳細は`.claude/bugs-history.md`のBug#39参照）。

1. **カレンダー版（Satori描画）**: 背景パネルを削除した結果、白文字のみ（縁取りなし）になっており、明るい背景色の上では文字が完全に溶けて見えなくなっていた
2. **カレンダーなし版（Photon `draw_text_with_border()`）**: 本セッションでPhotonの実際のWASMをローカルで動かして検証したところ、`draw_text_with_border()`の「縁取り」は文字の輪郭に沿ったストロークではなく、**文字からわずかにずれた位置に描かれる塗りつぶし矩形（実装上の癖/バグ）** であることが判明した。フォントサイズが小さい（540×960化に伴い13px相当まで縮小済み）とこの矩形が文字を覆い尽くし、黒い塊にしか見えなくなる

**根本原因**: Photonの文字描画API（`draw_text()`＝色固定（白）・縁取りなし、`draw_text_with_border()`＝縁取り部分に上記の癖がある）はどちらも色や縁取りの見た目を自由に制御できない。Satori側も白文字色のみで縁取りの仕組みを使っていなかった。**背景（AI生成イラスト）の明暗を問わず安定して読ませるには、色や縁取りを自在にデザインできる方法が必要**だった。

**採用した方式**: 「© nyanmusu」は**内容が変化しない固定テキスト**である（カレンダーの日付・月名のように月ごとに変わらない）。月替わり壁紙のカレンダー部分をSatori動的描画にした理由（`CLAUDE.md`の「変えてはいけない設計判断」参照）は「内容が変わるものを事前生成PNGにすると柔軟性を失う」というものだったが、これは固定テキストの署名には当てはまらない。そこで**署名だけを事前に1枚の透過PNG（白文字＋柔らかいドロップシャドウ）として作成し、`worker/assets/signature.png`にコミット**した。実行時はSatori/resvgでの動的テキストレンダリングを一切行わず、既存の`watermark()`（カレンダーオーバーレイの合成に使っているPhoton関数と同一）で画像に貼り付けるだけにする。

- **デザイン検討**: ユーザーとPython/PILでのシミュレーションを繰り返し、単色（縁取り・影なし）→縁取り（複数の太さ・不透明度）→ドロップシャドウの順で比較した。「ウォーターマークらしい控えめさ」の観点から、最終的に**柔らかいドロップシャドウ**（白文字・不透明度235/255、影は黒・不透明度140/255・オフセット1px・ガウスぼかし1.2px）を採用した
- **フォントウェイトをBoldに変更（2026-09追加）**: 初版はWorkSans-Regular 18pxで作成したが、ユーザーから「目立つ必要はないが読みにくい」と指摘を受けた。カレンダー本体（月番号・曜日見出し等）で既に使っている`worker/assets/fonts/WorkSans-Bold.ttf`（新規アセット追加不要）に差し替え、他のパラメータ（フォントサイズ18px・不透明度・ドロップシャドウの設定）は変更しなかった。実際に合成した画像でPIL比較を行いユーザー承認済み。文字のバウンディングボックスに対する内側パディング（左端約8px・上端約7px、旧Regular版は左9px・上8px）はほぼ変わらないため、`SIGNATURE_X_OFFSET_PX`（下記参照）の再計測・変更は不要と判断した
- **実装**: `_buildCalendarOverlayElement()`からSatoriの`signature`子要素を削除し、`_buildSignatureOnlyElement()`自体を廃止した（もう呼び出し元がないため）。`compositeMonthlyWallpaper()`は`worker/assets/signature.png`を`watermark()`でカレンダーあり版・なし版の両方に貼り付ける共通処理に統一した（従来は描画方式が2種類に分かれていたが、1種類に統一されたことでコードもシンプルになった）
- **アセットの読み込み**: フォント（`.ttf`）と同じ「ビルド時ESM静的importをData型としてArrayBuffer化する」パターンを踏襲する。`wrangler.toml`の`[[rules]]`に`**/*.png`のglobを追加し、`worker/image-utils.js`内で遅延importする（Photon/フォントローダーと同じ「`_setXForTest()`」パターンでテスト時に差し替え可能にする）
- **既知の制約**: PNGアセットは`compositeMonthlyWallpaper()`の出力解像度（現状540×960）を前提に固定サイズでデザインしている。将来`width`/`height`を1080×1920へ戻す場合（例: Workers Paidプランへの移行時）、このアセットは自動的にはスケールしない（Satoriの`elementScale`とは異なる仕組みのため）。解像度を変更する際はアセットを再生成する必要がある

**署名の左端インデントがカレンダー・月名バッジとズレていた問題（2026-09・実機投稿で発覚）**: 上記デプロイ後の実機投稿画像をユーザーが目視確認したところ、署名（© nyanmusu）のテキストがカレンダー帯・月名バッジ（10 October）の文字開始位置より左に寄って見えることが判明した。

- **原因**: `calendarPanel`・`monthBadge`（Satori要素）はいずれも`padding`（`px(28)`・`px(26)`、`elementScale = width / 1080`でスケールする）を内側に持つため、ボックスの左端と実際に見える文字の開始位置がキャンバス幅に応じて一定の比率でズレる。一方、署名PNG（`worker/assets/signature.png`）は`stampSignature()`内で`x = Math.round(width * CALENDAR_MARGIN_RATIO)`（＝`calendarPanel`のボックス左端と同一）にそのまま貼り付けており、画像自体に焼き込まれた内側余白（デザイン時の固定ピクセル値でキャンバス幅に応じてスケールしない）が`calendarPanel`のスケールする`padding`より小さいため、署名の可視テキストがカレンダーの可視テキストより左に寄って見えていた
- **1回目の修正とその不備（2026-09）**: 当初、`calendarPanel`の`padding`（スケール後）とPNGアセット単体の内側余白（実測約9px）の**差分のみ**（約5px）を補正量として実装したが、実際に合成済みの出力画像（`540×960`）をユーザーがPaint.NETで直接ピクセル計測し、目視でも約22px程度ズレて見えると指摘を受けた。実際に合成画像をPythonで直接解析したところ、カレンダー「sun」の可視テキスト開始位置は`x=96`、署名の可視テキスト開始位置は`x=75`で、**実際のズレは21px**だった。理論値の5pxとの乖離は、**WorkSansフォント自体が持つ左サイドベアリング（文字の輪郭がテキストボックスの内側からさらに内側にある分。パディングの計算だけでは考慮できない）**を見落としていたため
- **修正（実測ベース）**: パディングの理論計算をやめ、実際に合成した出力画像を直接ピクセル解析して得た実測差分をそのまま補正量の定数として使う方式に変更した。`SIGNATURE_X_OFFSET_PX = 21`（`width=540`の実機出力で計測。カレンダー「sun」の可視開始位置`x=96`と署名の旧可視開始位置`x=75`の差）を新設し、`stampSignature()`のx座標に`Math.round(width * CALENDAR_MARGIN_RATIO) + SIGNATURE_X_OFFSET_PX`として加算する。`CALENDAR_PANEL_PADDING_PX`・`SIGNATURE_ASSET_PADDING_PX`という理論値ベースの2定数は削除した（フォントのside-bearingまで含めた実測値1つに統合した方がシンプルかつ正確なため）
- **この修正が解決しないこと**: `SIGNATURE_X_OFFSET_PX`は`width=540`の実際の出力画像を直接計測して得た値であり、フォント・アセットを変更した場合や、キャンバス幅（`width`）を1080に戻した場合（上記「既知の制約」参照）は、実際に出力画像を生成し直して再計測する必要がある（理論計算では正確な値を導けないことが今回判明したため、次回変更時も必ず実機/実出力画像での直接計測を行うこと）

- **投稿URLのDiscord通知記載（2026-09追加・PR #182に含む）**: 上記の実機検証を繰り返す過程で、投稿の成否確認・テスト投稿の手動削除のたびにログからURLを手動組み立てる手間が発生したため、`buildBlueskyPostUrl()`とMastodon Status APIの`url`フィールドを使い、Discord通知の成否行に投稿URLを直接記載するようにした（日次Bot・月替わり壁紙の両方に適用。詳細は「Discord通知」節の「投稿URLの記載」参照）

**スマートフォン実機でのセーフエリア調整（2026-09・iPhone 17 Pro実機テストで発覚・Bug#38）**: 実際に投稿された壁紙画像をiPhone 17 Proの待受に設定したところ、左上の月名バッジ・下部のカレンダー帯・署名が、画面の曲面（ディスプレイ端の湾曲）やシステムUI（時計・ホームインジケーター等）に隠れて見切れることが判明した（ユーザーが実機で目視確認）。それまでの配置（`monthBadge`は`top: 56`・`calendarPanel`は`left/right: 40, bottom: 64`・署名は`left: 32, bottom: 32`）は、Cloudflare Workers上の画像処理として動作確認はできても、実際のスマートフォン端末の画面形状までは考慮していなかった。

修正方針（Geminiとの壁打ちを経てユーザーが確定した数値仕様）: イラスト自体の構図（テイスト・フォント・解像度・被写体の位置）は変更せず、オーバーレイ要素（月名バッジ・カレンダー帯・署名）の配置のみを画面中央寄りに調整する。背景側の左右マージン（キャラクターの登場位置に影響する余白）はこの調整の対象外（ユーザーが明示的に許容）。

- **上下セーフエリア**: 全高の約9%を上下それぞれの余白として確保する（`SAFE_AREA_RATIO = 0.09`・1080×1920基準で約173px）。`monthBadge`の`top`をこの値に、`calendarPanel`・署名の`bottom`基準をこの値に変更し、オーバーレイ全体をわずかに中央寄りにシフトする
- **カレンダー帯の横幅・左右マージン**: カレンダーブロックの横幅を全幅の約75.5%に収め、左右に均等なマージンを確保して中央に配置する。ユーザーが提示した2つの数値（横幅75.5%・左右マージン各11%）はそのままでは合計97.5%になり厳密には矛盾するため、より安全側（マージンが広くなる側）の解釈を採用し、横幅75.5%を厳密値として左右マージンを逆算した（`CALENDAR_MARGIN_RATIO = 0.1225`・約132px、約12.25%）。指定の11%よりマージンが広がる方向の丸めなので、要求された「スマートフォンのバー等と干渉しない浮き」の意図には反しない
- **署名の左端をカレンダー帯の左端に揃える**: 従来署名は`left: 32`とカレンダー帯の左端（旧`left: 40`）と微妙にずれていた。`CALENDAR_MARGIN_RATIO`を`calendarPanel`・署名で共有することで左端が自動的に揃うようにした
- **月名バッジの位置は実機フィードバックの具体的な座標指定を優先する（2026-09追加）**: 当初`monthBadge`も`calendarPanel`と同じ`CALENDAR_MARGIN_RATIO`/`SAFE_AREA_RATIO`（左132px・上173px相当）を暫定的に適用していたが、ユーザーから「160px, 260pxの位置に置く」という具体的な座標指定を受けたため、`monthBadge`のみ`MONTH_BADGE_LEFT_RATIO`（160/1080）・`MONTH_BADGE_TOP_RATIO`（260/1920）という独立した比率定数に切り替えた。`calendarPanel`・署名の左端とは意図的に完全一致しない（バッジは実機の曲面・カメラアイランド等を避けるためカレンダー帯よりもやや内側・下に配置する方が安全という判断）
- **カレンダー帯と署名の縦の余白**: 署名（コピーライト）を画面最下部のセーフエリア境界（`SAFE_AREA_RATIO`基準）に配置し、カレンダー帯はその上に既存デザインと同じ32pxの間隔を保って浮かせる（`calendarPanel`の`bottom`＝署名の`bottom` + 32px）。底面ギリギリに張り付かない設計は従来から踏襲済みだったため、セーフエリアの基準点を「画面下端」から「セーフエリア境界」に置き換えるだけで対応できた

**実装箇所（2026-09時点）**: `worker/image-utils.js` `_buildCalendarOverlayElement()`（`monthBadge`・`calendarPanel`）・`compositeMonthlyWallpaper()`内の`stampSignature()`（署名の貼り付け位置、同じ比率を独立に計算）。いずれも同一の`SAFE_AREA_RATIO`・`CALENDAR_MARGIN_RATIO`定数（`width`/`height`引数から動的に計算する比率であり固定px値ではない）を参照するため、キャンバスサイズを変更しても比率は保たれる。**当初は`_buildSignatureOnlyElement()`・`drawSignature()`の2関数がこの役割を担っていたが、Bug#39で署名が事前生成PNGアセット化されたことに伴い両関数は廃止され、`stampSignature()`に統一されている（詳細は上記「署名を事前生成PNGアセット化」参照）。**

**未検証（2026-09時点）**: この修正はローカルのユニットテスト（要素ツリー・Photon描画呼び出しの数値アサーション）でのみ検証済み。実際のiPhone/Android実機での見切れ解消は、次回`POST /monthly-wallpaper/regenerate`実行後にユーザーが目視確認する。

**低解像度合成＋Photon Lanczos3での最終拡大（2026-09追加・error 1102の追加対策）**: PR #186（カレンダーなし版のSatori/resvg排除）デプロイ後も、`query-worker-logs.mjs`で実機ログを確認すると`error 1102`が断続的に再発していた。失敗地点は毎回`再センタリング判定完了`の直後〜`カレンダー版オーバーレイ描画完了`の前後に集中しており、**カレンダー版1回分のSatori/resvg描画＋Photonでの複数回の画像デコード/エンコードだけでも、Workers Free上限のCPU予算を超過しうる**ことが判明した（詳細は`.claude/bugs-history.md`のBug#37追記参照）。

resvgのラスタライズコスト・Photonのデコード/エンコードコストはいずれも処理するピクセル数にほぼ比例する。そこで、**カレンダー合成のパイプライン全体（ベースクロップ・再センタリング・Satori/resvg描画・Photon合成）を縮小解像度（`RENDER_SCALE = 0.5`・540×960相当、面積で1/4）で実行し、最後にPhotonの`resize()`（`SamplingFilter.Lanczos3`）で目標解像度（1080×1920）へ拡大**する方式に変更した。

**なぜfal.ai（ESRGAN）ではなくPhotonのLanczos3を使うか**: 当初「fal.aiで最後に高解像度化する」案も検討したが却下した。fal.aiのESRGAN 2xは「AIが生成した猫イラスト（写真的な質感）の高精細化」を想定して選定したモデルであり（`CLAUDE.md`の「変えてはいけない設計判断」参照）、月替わり壁紙の最終画像はそこに**Satori/resvgで描いたフラットなベクター文字（カレンダーの数字・月名）が重なった合成物**である。AI超解像モデルを平坦な色面上のシャープな文字に適用すると、エッジのぼやけ・歪み・ノイズ（ハルシネーション）が生じやすく、カレンダーの可読性という本機能の核心を損なうリスクが高いと判断した。Photonの`Lanczos3`は単純な補間拡大でハルシネーションが起きないため、多少のソフト化はあっても文字が破綻しにくい。事前にPython/PILで簡易シミュレーション（低解像度描画→Lanczos拡大 vs フル解像度ネイティブ描画の比較）を行い、ユーザーが劣化度合いを確認したうえで採用した。

**実装**:

- `_buildCalendarOverlayElement(year, month, options)`・`_buildSignatureOnlyElement(options)`内の固定px値（フォントサイズ・パディング・角丸・マージン等）を、基準幅1080に対する`width`の比率（`scale = width / 1080`）でスケールするよう変更した。`width=1080`指定時は`scale=1`となり従来と完全に同じ値になるため、既存の呼び出し・テストへの後方互換を保っている
- `compositeMonthlyWallpaper(imageData, year, month, deps = {})`は、`renderWidth = Math.round(width * RENDER_SCALE)`・`renderHeight = Math.round(height * RENDER_SCALE)`を算出し、ベースクロップ・再センタリング判定・`_buildCalendarOverlayElement()`/`_buildSignatureOnlyElement()`の呼び出し・Satori/resvg描画・Photon合成のすべてを`renderWidth`/`renderHeight`基準で行う。カレンダーあり版・なし版それぞれの合成が完了した最後の1ステップとして、Photonの`resize(img, width, height, SamplingFilter.Lanczos3)`で目標解像度へ拡大してから`get_bytes()`/base64エンコードする
- 診断用の`console.log`（`[monthly-wallpaper-composite]`プレフィックス）に拡大ステップの完了ログを追加する

**実機再検証（2026-09・撤回）**: デプロイ後にユーザーが`POST /monthly-wallpaper/regenerate`を3回実行したところ**3回とも`error 1102`**という結果になった。`query-worker-logs.mjs`でログを相関させると、(1) カレンダー版オーバーレイ描画（Satori/resvg＋Lanczos3拡大）は完走したがその直後で失敗、(2) 合成・R2保存まで完全に成功（`composited=true`）したにもかかわらずその後（Bluesky/Mastodon投稿またはDiscord通知の段階と推測）で失敗、(3) 合成開始直後に失敗、という3パターンが混在していた。このプロジェクトの過去の記録（Bug#37: 「追加のLanczos3リサイズを1回上乗せしただけでCPU予算を超過させた」）に照らすと、**今回追加したカレンダーあり版・なし版それぞれ1回ずつ計2回のLanczos3拡大呼び出しが、縮小解像度化で浮いた分を相殺・悪化させた可能性が高い**と判断し、この最終拡大ステップ自体を撤回した（詳細は下記「最終拡大の撤回」参照）。

### 最終拡大の撤回・540×960のまま配信（2026-09追加）

上記の実機再検証結果を受け、**Lanczos3による目標解像度（1080×1920）への最終拡大処理を撤去し、縮小解像度（540×960）のまま2版を返す**方式に変更した。

- `compositeMonthlyWallpaper()`の`width`/`height`デフォルト値を`1080`/`1920`から`540`/`960`へ変更し、`renderWidth`/`renderHeight`・`RENDER_SCALE`・`upscaleToTarget()`は廃止して、ベースクロップから合成・エンコードまで単一の`width`/`height`基準で行う（PR #186時点の実装に戻す形だが、目標解像度の値だけが540×960に変わっている）
- `_buildCalendarOverlayElement()`/`_buildSignatureOnlyElement()`のフォントサイズ等のスケーリング機構（`elementScale = width / 1080`）は維持する（`width=540`指定時に自動的に半分のフォントサイズになるため、追加のスケーリング計算は不要）
- **画質とのトレードオフ**: 540×960はフルHD（1080×1920）の1/4の画素数であり、高精細ディスプレイでは壁紙としてのシャープさが劣る。ただし「文字が読めないほどではないがフル解像度よりは粗い」という許容範囲と判断し、確実にCPU予算内へ収める方を優先した。将来Workers Paidプラン（CPU上限引き上げ）へ移行する場合は、`width`/`height`のデフォルトを1080/1920へ戻すだけで元の解像度に復帰できる
- **実機再検証の結果（2026-09・解消確認）**: デプロイ後、ユーザーが`POST /monthly-wallpaper/regenerate`を3回実行し、**3回とも成功**（`error 1102`の再現なし）を確認した。低解像度合成パイプライン自体（540×960・拡大処理なし）に絞ったことで、error 1102は解消したと判断する。Satori/resvgの処理コストがピクセル数に強く依存するという仮説（Bug#37の記録）、および「追加のLanczos3リサイズが逆効果になる」という過去の教訓が、今回もそのまま当てはまる結果となった

### 投稿本体（`worker/bot.js` `runMonthlyWallpaperPost(env, handleGenerate, ctx = null, deps = {})`）

`runBot()`と同じ構造を踏襲する。`deps.compositeMonthlyWallpaperFn`（省略時`compositeMonthlyWallpaper`）はSatori/resvgという重いWASM処理を伴うためテスト時に必ずモック可能にしている（`_pollFalAndGetTexture()`と同じ「依存関数を引数で受け取る」パターン）。

1. `resolveTargetYearMonth()`で対象年月（翌月）を決定 → 月テーマ取得 → `handleGenerate()` → `compositeMonthlyWallpaperFn()`でカレンダーあり・なし2版を生成
2. R2保存: `monthly-wallpaper/YYYY-MM/calendar.png` + `no-calendar.png` + `meta.json`。**手動再生成は同一年月のキーを上書きする**（Bot投稿の`bot/YYYY-MM-DD-n`スロット方式とは異なり、意図的な再実行が主目的のため上書きでよい）
3. Bluesky投稿: **カレンダーあり・なし2枚を同一投稿に添付**する。既存`createPost()`は単一画像専用のため、新規関数`createMonthlyWallpaperPost()`（`worker/bot.js`内・同一モジュールスコープの既存プライベート関数`createBlueskySession()`/`uploadBlob()`を再利用）で`app.bsky.embed.images`の画像配列（2件・altテキストをそれぞれ設定）を組み立てる
4. Mastodon投稿: 既存`uploadMediaToMastodon()`を2回呼び、`postStatusToMastodon()`の`media_ids[]`に2件渡す
5. 投稿文言: `buildMonthlyWallpaperPostText()`（Bluesky・日本語のみ、既存`buildPostText()`と同じ方針）・`buildMonthlyWallpaperMastodonText()`（Mastodon・英語優先の日英二言語、既存`buildMastodonText()`と同じ方針）。ハッシュタグ例: `#壁紙 #猫壁紙 #AIart #cat #にゃんバーサリー`（Bluesky）・`#wallpaper #cat #AIart #にゃんバーサリー`（Mastodon）
6. Discord通知（`notifyDiscord()`流用・2通構成）: **成否ステータスは1通目のみに記載し、2通目では再掲しない**（日次Botと異なる点）。月次は頻度が低く「1通目が届かない」こと自体が異常のシグナルになるため、再掲の必要性が薄いと判断した
   - 1通目: 成否ステータス（投稿URL付き。日次Botと同じ`buildBlueskyPostUrl()`/Mastodon Status APIの`url`フィールドを使う）＋テーマ＋Geminiプロンプト全文
   - 2通目: Bluesky投稿テキスト＋Mastodon投稿テキスト（いずれもX/Instagram/Facebook/mixi2等への手動転載用）

### 手動再生成エンドポイント

`POST /monthly-wallpaper/regenerate`。`X-Bypass-Token`ヘッダーを既存`BYPASS_TOKEN`シークレットと照合（不一致は403）。一致したら`runMonthlyWallpaperPost(env, handleGenerate, ctx)`を呼び出し結果をJSONで返す。Cron発火時と全く同じ関数を呼ぶため実装・テストは1箇所に集約される。自動のバックアップCronチェックは今回実装しない（ユーザー判断・手動再生成のみで信頼性を担保する）。

### Cron（月末自動生成）

**設計変更（2026-09・デプロイ後に判明）**: 当初は独立Cron`"0 3 * * *"`（03:00 UTC = 12:00 JST）を新設する設計だったが、実際にデプロイしたところCloudflare APIが`10072`エラー（Cron Trigger上限超過）で拒否した。原因はCron Triggerの上限が**Worker単位ではなくCloudflareアカウント単位**（Workers Freeは5本/アカウント）であり、同一アカウント内の別プロジェクト（`yobiko`・`yobiko-staging`、各1本使用）と本Workerの既存3本を合わせてすでに5本に達していたため。ステージング環境も本番と同一のCron挙動を維持する必要があるとの理由で`yobiko-staging`側の削減は見送り、代わりに独立Cronを新設せず**既存の`"0 15 * * *"`に相乗り**させる設計に変更した。

これにより実行時刻はユーザー当初希望の12:00 JST頃から**0:00 JSTへ変更**になっている（`"0 15 * * *"`は元々リサーチプール生成用の毎日Cron）。`scheduled()`の`"0 15 * * *"`分岐:

```js
if (event.cron === "0 15 * * *") {
  ctx.waitUntil(generateResearchPool(env, ctx));
  ctx.waitUntil((async () => {
    const jstDateISO = toJSTDateStringWorker(new Date());
    if (!isLastDayOfMonthJST(jstDateISO)) return; // 月末以外は即return
    await runMonthlyWallpaperPost(env, handleGenerate, ctx);
  })());
  return;
}
```

`generateResearchPool()`・月末チェックはどちらも`ctx.waitUntil()`に個別登録され、互いに待ち合わせない（片方が遅延・失敗してももう片方に影響しない）。

`isLastDayOfMonthJST(dateStr)`は新規の小さな純粋関数（翌日の日付を計算し、月が変わっていれば月末と判定）。大半の日はここで即returnするため、既存Cronへの負荷影響はごく僅か。

### 公開後フォローアップ（運用ルール）

初回投稿から5日後を目安に、Bluesky/Mastodonの公開API（`public.api.bsky.app`・対象Mastodonインスタンスの`/api/v1/accounts/.../statuses`、いずれも認証不要）で反響（いいね・リポスト・返信）を確認し、簡単な総括と次月に向けた改善案をまとめる。手順は集客診断セッションで実施した手法と同じ（`.claude/future-ideas.md`の「集客・マーケティング診断」参照）。
