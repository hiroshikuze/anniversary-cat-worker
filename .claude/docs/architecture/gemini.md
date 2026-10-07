# アーキテクチャ詳細: Geminiモデル管理

> `.claude/rules/architecture.md`から移動した（2026-10）。毎セッション自動で読み込まれるファイルを軽くするため、詳細をこのファイルに分けた。本文は移動前のまま。

## Geminiモデル管理

### 画像生成モデル（`worker/index.js`の`KNOWN_IMAGE_CANDIDATES`）

```js
const KNOWN_IMAGE_CANDIDATES = [
  "gemini-2.5-flash-image",              // 2026-03現在のstable（メイン）
  "gemini-2.0-flash-exp",                // フォールバック
  "gemini-2.0-flash-preview-image-generation",  // 廃止済みの可能性あり
];
```

**全候補が404になったら（`KNOWN_IMAGE_CANDIDATES`全滅）:**

1. Discordに`🚨 画像生成モデル全滅`通知が届く（下記「自動切替・記憶」参照）。または Actionsタブでhealth-checkの失敗を確認（Cloudflareログで`unavailable(404)`を確認）
2. [Google AI for Developers](https://ai.google.dev/gemini-api/docs/models)で現行モデルを確認
3. `KNOWN_IMAGE_CANDIDATES`に新しいモデルを追記してpush → Actionsで確認

`scripts/health-check.js`は`KNOWN_IMAGE_CANDIDATES`と同期させた独立コピーを保持し、`checkImageModels()`で配列の先頭エントリをE2Eチェックする（配列が古い場合は`warn`のみでCI失敗にはしない）。下記の自動切替・記憶機構とは独立しており、実際にKVへ記憶されている稼働モデルではなく配列の静的な内容を見ている点に注意。

**現状確認（2026-10・Issue #204）:** `GET /usage`の直近30日分で`imageModel=gemini-2.5-flash-image`・`imageModelResolved=gemini-2.5-flash-image`が一貫しており、先頭候補が404にならず正常稼働中（モデル切替Discord通知も発生していない）。配列自体の更新は不要と判断。参考として、Discovery API（`GET /models`）には`gemini-3.1-flash-lite-image`という画像生成対応の新しい軽量モデルも存在することを確認した（`generateContent`対応）。現時点では**候補への追加・切替は行わない**（コスト・品質の実測比較をしていないため）。将来`gemini-2.5-flash-image`が廃止された場合の代替候補の当たりとして記録のみ残す。

### 画像生成モデルの自動切替・記憶（`_resolveImageModel()`・2026-06追加）

`tryGemini()`は`KNOWN_IMAGE_CANDIDATES`を毎回先頭から順に試すのではなく、`RATE_KV`（既存のレート制限用KVを再利用、新規namespaceは作成しない）のキー`image-model:active`に**現在有効なモデル名を記憶**し、次回以降はそのモデルを最優先で試す。

```js
export async function _resolveImageModel(kv, candidates, callModel) {
  const remembered = kv ? await kv.get(IMAGE_MODEL_KV_KEY) : null;
  const order = remembered && candidates.includes(remembered)
    ? [remembered, ...candidates.filter(m => m !== remembered)]
    : candidates;
  // order を順に callModel(model) で試行。
  // callModel が err.cascade=true を投げた場合のみ次の候補へ。
  // 成功したモデルが remembered と異なれば KV を更新する。
  // 成功したモデルが「今回最初に試したモデル」（order[0]。記憶値があればそれ、
  // なければ candidates[0]）と異なる場合のみ modelSwitch を返す（＝カスケードが
  // 実際に発生した場合のみ通知対象。KVが空の初回起動でcandidates[0]がそのまま
  // 成功した場合は通知しない）。
}
```

- `callModel(model)`内の404/"not found"/"not supported"判定のみが`err.cascade = true`としてカスケード対象になる。429（クォータ超過）・「画像パートなし」・その他のエラーは**従来通りカスケードしない**（即throw）。クォータ超過を自動切替対象にすると本来のクォータ問題を隠してしまうため意図的に対象外にしている
- モデルが切り替わった場合: Discordに`🔄 画像生成モデルを切替: {from} → {to}`を通知（`tryGemini()`内で直接`await notifyDiscord()`、`ctx.waitUntil()`化はしない。fal.ai運用通知等の既存パスと同じ規約）
- `KNOWN_IMAGE_CANDIDATES`の候補すべてが失敗した場合: Discordに`🚨 画像生成モデル全滅`を通知してからエラーをrethrowする（Pollinationsフォールバックは`_twoPhaseRace`側で従来通り機能する）
- **このKV記憶機構が解決しないこと**: `KNOWN_IMAGE_CANDIDATES`配列自体の更新（新しいモデル名の追記）は引き続き人間が行う。Discovery API（List Models）を`tryGemini()`のホットパスに追加することは過去に廃止した設計判断であり、本機構でも再導入しない（2フェーズレースのレイテンシ予算を侵害するため）
- 同時並行リクエストが同一の死活変化を同時に検知した場合、Discord通知が2〜3通程度重複する可能性がある。Workers KVにはCAS機構がなく、Durable Objects等の追加インフラなしには排他できないため、この程度の重複は許容している

### Researchモデル（テキスト用）・コスト最適化スコアリング（2026-06更新）

`selectBestModel(apiKey, kv, webhookUrl)`がスコアリングで自動選択。ログ: `[model-select] selected: gemini-xxx`

**スコアリング哲学**: このアプリの研究タスク（記念日をJSONで返す・Google Search grounding使用）は高度な推論を必要としない。コスト最小化を優先してスコア式を設計する。

**スコア計算式（`_selectFromCandidates()`・exportされた純粋関数）:**

```js
let score = 0;
if (name.includes("flash"))    score += 20;  // flash = 高速・低コストティア
if (!name.includes("preview")) score += 10;  // 安定版を優先
if (name.includes("lite"))     score +=  5;  // lite = 最安値ティア
const ver = name.match(/gemini-(\d+)\.(\d+)/);
if (ver) score -= parseInt(ver[1]) * 3 + parseInt(ver[2]);  // 低バージョン優先（低コスト）
```

**モデル別スコア例（2026-10時点・[公式料金ページ](https://ai.google.dev/gemini-api/docs/pricing)で直接確認済み・Issue #204での再検証）:**

| モデル | スコア | 有料出力/100万token | 備考 |
| --- | --- | --- | --- |
| `gemini-flash-lite-latest` | 35 | （「最新」を指すエイリアス。実体は下記`gemini-3.5-flash-lite`） | バージョン番号を含まないため`score -= ...`の減点を一切受けず、**常に他の全候補より高スコアになる**（下記「`-latest`エイリアスの優先」参照） |
| `gemini-3.1-flash-lite` | 25 | $1.50 | バージョン表記のある候補の中では最安・最高スコア |
| `gemini-2.5-flash-lite` | 24 | （不明・提供終了につき料金ページ未掲載） | 2026-10時点で新規ユーザーには提供終了（404）。Discovery APIには依然掲載されており候補に残る場合がある |
| `gemini-3.5-flash-lite` | 21 | $2.50 | 2026-10時点で`gemini-flash-lite-latest`の実体 |
| `gemini-2.5-flash` | 19 | $2.50 | flash-lite系が全滅した場合のfallback |
| `gemini-3.5-flash` | 16 | $9.00 | 思考トークン含む・高コスト |
| `gemini-2.5-pro` | -1 | $10.00 | flashでないため低スコア |

- Google Search grounding対応は`flash`/`flash-lite`系であれば世代を問わず利用可能（無料枠はモデルにより異なる）
- 旧スコア式（`score += major*3+minor`）は「高バージョン=高コスト優先」になっていたため修正した
- `-exp$`で終わるモデルは無料枠クォータが0のため除外フィルターを維持する

**`-latest`エイリアスの優先（2026-10・Issue #204で判明）:** スコア式の`ver`正規表現（`/gemini-(\d+)\.(\d+)/`）は`gemini-flash-lite-latest`のようなバージョン番号を含まないエイリアス名にはマッチしないため、このエイリアスだけは「低バージョン優先」の減点を一切受けない。結果として**バージョン表記を持つ候補が束で負ける**（`flash`+`lite`の基礎点35から、バージョンがあれば必ず10点以上減点されるため）。これは意図した設計ではなく、たまたまAPIが候補に`-latest`系の名前を含めていることによる副作用。

- **実害は確認されていない**: `-latest`は命名からしてGoogle側が「現時点での推奨・最新版」を指す意図のエイリアスのため、たまたま今は低コスト最適化の意図とも大きく矛盾していない（2026-10時点の実体は`gemini-3.5-flash-lite`で、最安の`gemini-3.1-flash-lite`より1世代新しいが極端に高コストではない）
- **本番確認（2026-10・`GET /usage`で実測）**: `textModel=gemini-flash-lite-latest`・`textModelResolved=gemini-3.5-flash-lite`が直近30日分すべてで一致して記録されており、動的選択自体は安定して機能している（Issue #204の確認事項1に対応）
- 将来`-latest`エイリアスの実体がさらに高コストな世代に進んだ場合、このスコアリング式は追従できない（エイリアスが常に勝つため）。コスト最小化を厳密に保証したい場合は、エイリアス名に対しても`textModelResolved`相当の実体解決を行ってから評価する改修が必要だが、`selectBestModel()`のホットパス（2フェーズレースのレイテンシ予算内）にその追加呼び出しを入れる余地があるかは未検討

**KV記憶・Discord通知（`TEXT_MODEL_KV_KEY = "text-model:active"`）:**

- 選択されたモデルを`RATE_KV`の`text-model:active`キーに保存（既存namespaceを再利用）
- 前回の記録と異なるモデルが選ばれた場合: Discordに`🔄 テキストモデルを切替: {from} → {to}`を通知
- 通知条件:「前回記録値≠今回選択値かつ前回記録値が存在する」（記録なし→初回設定は通知しない）
- KV操作は`selectBestModel()`内でtry/catchし、失敗してもモデル選択自体はブロックしない
- 同時並行リクエストで通知が数通重複する可能性がある（画像モデルと同じ設計判断・許容）

**Discovery API呼び出し自体が失敗した場合の最終フォールバック（2026-08修正）:**

`selectBestModel()`はDiscovery API（`GET /models`）へのfetch自体がネットワークエラー・タイムアウト等で失敗した場合、`catch`節で`_modelCache.name ?? FALLBACK_TEXT_MODEL`を返す。KVキャッシュ（1時間TTL）が空のコールドスタート直後にDiscovery API呼び出しが失敗するという稀なケース限定の保険。`_selectFromCandidates([])`（候補が0件の場合）も同じ定数を返す。

- この定数は`FALLBACK_TEXT_MODEL`としてモジュールスコープに切り出し、2箇所で共有する（sale-check.jsのGeminiモデル404障害の調査で、この保険用の値自体も廃止済みモデルを指していたと判明したため。`.claude/archive/revision_log_2026-08.md`参照）
- **通常運用ではこの保険には到達しない**（Discovery API呼び出しが成功する限り、動的スコアリングが常に現行モデルから選ぶため、廃止されたモデルが再度選ばれることはない）。この保険はあくまで「動的選択アルゴリズム自体が動かせない」という別の障害モードに対するものであり、次回モデル廃止時に自動更新される仕組みではない点に注意

**`handleResearch()`シグネチャ更新:**

```js
export async function handleResearch(body, apiKey, env = null)
```

- `env`を第3引数として追加（省略可能・nullのときKV/Discord通知なしで動作）
- `selectBestModel(apiKey, env?.RATE_KV, env?.DISCORD_WEBHOOK_URL)`を内部で呼ぶ
- 呼び出し元: fetchハンドラー・`bot.js runBot()`・`generateResearchPool()`いずれも`env`を渡す

**プレーンテキストフィールドのサニタイズ（`stripHtmlTags()`・2026-07追加・Bug#30）:**

Geminiが`theme`/`description`/`themeEn`/`descriptionEn`/`themeHook`/`themeHookEn`（プレーンテキスト前提のフィールド）に、本来`themeKana`/`descriptionKana`用のruby HTMLを誤って混入させることがある（実測: 10並列生成中1件で発生）。Gemini JSONレスポンスをパースした直後にこれらのフィールドへ`stripHtmlTags()`（`<[^>]*>`除去）を適用し、`themeKana`/`descriptionKana`（ruby HTML必須）は対象外とする。`themeHook`/`themeHookEn`は2026-10追加（`.claude/docs/architecture/bot-posting.md`の「投稿フォーマットの選択（short/full）」参照）。副次効果として、タグ除去後は文字列表現が揃うため`filterAndDedupePool()`の重複除去も正しく機能するようになる。

**トークン使用量記録（`usageMetadata`・2026-06追加、モデル解決名の記録は2026-07追加）:**

GeminiのAPIレスポンスに含まれる`usageMetadata.totalTokenCount`を取得し、日次集計をKVに保存する。

- KVキー: `usage:YYYY-MM-DD`（UTC基準・TTL=32日）
- 集計フィールド: `textCalls`（回数）・`textTokens`（累計トークン数）・`textModel`・`textModelResolved`・`imageCalls`・`imageTokens`・`imageModel`・`imageModelResolved`
- `/usage` GETエンドポイントで直近30日分をJSON返却（認証なし・統計のみ）
- `scripts/health-check.js`の末尾でエンドポイントを呼び、CIログに出力する（将来のClaude CodeセッションがCIログからモデルとトークン数を確認できる）

**CPU時間のステップ別記録（`incrementCpuTimeKv()`・2026-08追加・Bug#32）:**

`/usage`（トークン使用量）と同じパターンで、CPU時間が心配な実行パスのステップ別所要時間をKVに日次集計し、APIで取得できるようにする。GitHub Actionsのログ経由でClaude CodeセッションがCPU時間の実測データを直接確認できるようにする目的。

- KVキー: `cpu-time:YYYY-MM-DD`（UTC基準・TTL=32日、`usage:`と同じ命名パターン）
- 集計フィールド: ステップ名をキーとしたオブジェクト（例: `research`・`generate`・`generate-jsonParse`・`generate-autoCrop`・`shrinkImage`・`suzuriCreate-backTextureDecode`）。各ステップは`{calls, totalMs, maxMs}`
- `/cpu-usage` GETエンドポイントで直近30日分をJSON返却（認証なし・統計のみ）
- `scripts/health-check.js`の末尾でエンドポイントを呼び、CIログに出力する

**計測チェックポイントの共通化（`recordCpuCheckpoint()`・2026-08追加）:**

各チェックポイントで`console.log`とKV集計を個別に書くと同じ2行パターンが重複するため、`recordCpuCheckpoint(step, ms, kv = null)`に共通化した。`console.log`は常に行い、`incrementCpuTimeKv(kv, step, ms)`は無条件に呼ぶ（`kv`が`null`の場合は`incrementCpuTimeKv()`自身が既に持つnullガードで安全に何もしない。呼び出し側で`if (kv)`のような分岐を重ねる必要はない）。

- KV集計が必要な経路（`research`・`generate`・`shrinkImage`・`suzuriCreate-backTextureDecode`）: `recordCpuCheckpoint(step, ms, env?.RATE_KV)`
- 壁時計時間・レート制限のない高頻度経路等、KV集計対象外の経路: `recordCpuCheckpoint(step, ms)`（`kv`省略）
- `worker/index.js`に定義し、`worker/bot.js`からimportして使う（既存の`pickFromPool`と同じ循環import許容パターン）。`worker/r2-storage.js`は`index.js`から先にimportされている側のため、逆方向のimportで循環参照を新設することを避け、単独の`console.log`のまま共通化の対象外とした

**KV書き込みの`ctx.waitUntil()`背景化（2026-08追加・Bug#32追加調査）:**

`/cpu-usage`稼働後の実測で、`research`ステップが`maxMs=94ms`（Free プランCPU時間上限10msの約9倍）という値を示した。原因は、計測区間（`tCpuStart`〜`recordCpuCheckpoint()`）に`incrementUsageKv()`のKV `get`→`put`往復（ネットワークI/O）が含まれていたためで、実際のCPUバウンドな同期処理（JSON.parse・正規表現等）自体は軽量だった。

- **計測精度の是正**: `performance.now() - tCpuStart`の計算を`incrementUsageKv()`呼び出しより*前*に移動し、KV往復を計測区間から除外した。この修正は`ctx`の有無に関わらず適用される
- **クリティカルパスからの分離**: `handleResearch(body, apiKey, env, ctx = null)`・`handleGenerate(body, apiKey, env, ctx = null)`が末尾に`ctx`（Workers `ExecutionContext`）を受け取るようになった。`ctx`が渡された場合、`incrementUsageKv()`・`recordCpuCheckpoint()`の呼び出しは`ctx.waitUntil()`に渡され、KV書き込みの完了を待たずに関数が結果を返す。`ctx`が渡されない場合（テスト等）は従来通り`await`する後方互換動作
  - Cloudflare Workersは1 invocationにつき単一のV8アイソレートで動作し、真のマルチスレッドは利用できない。`ctx.waitUntil()`はI/Oバウンドな処理（KV書き込み等）を応答後もバックグラウンドで完了させるための仕組みであり、CPU時間の予算そのものを増やすものではない（CPU時間課金・上限はinvocation全体に対して適用され、`waitUntil()`で登録した背景処理も含む）
  - `/suzuri-create`のfal.aiキュー処理（`ctx.waitUntil()`でバックグラウンド処理）と同じ設計パターン
- **`ctx`の伝播経路**: `fetch(request, env, ctx)`の`/research`・`/generate`ハンドラー → `handleResearch()`/`handleGenerate()`に直接渡す。Cron側は`scheduled(event, env, ctx)` → `generateResearchPool(env, ctx)`（10並列の各`handleResearch()`呼び出しに渡す）・`runBot(env, handleResearch, handleGenerate, ctx)`（`worker/bot.js`、内部の`handleResearch()`/`handleGenerate()`呼び出しに渡す）
- `handleGenerate()`内部の`callModel()`クロージャは`ctx`を追加の引数受け渡しなしにクロージャ経由でそのまま参照する
- **`/suzuri-create`ハンドラーへの横展開**: `suzuriCreate-backTextureDecode`計測（`incrementUsageKv()`とのペアはなく`recordCpuCheckpoint()`単体呼び出し）にも同じパターンを適用した。この箇所は`fetch()`ハンドラー内にインラインで書かれておりexportされた関数がなかったため、`_recordBackTextureDecodeCpu(cpuMs, env, ctx)`としてexport・テスト可能な形に切り出した（`_pollFalAndGetTexture()`と同じ「依存関数を引数で受け取る」切り出しパターン）。`fetch(request, env, ctx)`内なので`ctx`は常に存在するが、他の箇所と実装を揃えるため同じ`if (ctx) { ctx.waitUntil(...) } else { await ... }`分岐を踏襲する
- **共通ヘルパー`_deferOrAwait(promise, ctx)`への集約**: 上記「`ctx`があれば`ctx.waitUntil()`・なければ`await`」という同一パターンが4箇所（`handleResearch()`・`handleGenerate()`・`_recordBackTextureDecodeCpu()`・`runBot()`の`shrinkImage`計測）に重複したため、`worker/index.js`に`_deferOrAwait(promise, ctx)`として抽出しexportした。4箇所すべてこのヘルパー経由に統一している
- **`runBot()`の`shrinkImage`計測**: `worker/bot.js`の`recordCpuCheckpoint("shrinkImage", ..., env.RATE_KV)`も同じKV書き込みブロッキングパターンだったが、`ctx`導入時に見落としていた。`runBot(env, handleResearch, handleGenerate, ctx = null)`が受け取る`ctx`を`_deferOrAwait()`経由でこの呼び出しにも適用する
- **ネットワークI/O待ちはCPU時間に計上されない（[Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)で確認済み）**:「Waiting on network requests (such as fetch() calls, KV reads, or database queries) does not count toward CPU time」と明記されている。CPU時間は実際にコードを実行している時間のみを測定し、fetch・KV等のI/O待ちは「Duration」（壁時計時間）には含まれるがCPU時間には計上されない。`ctx.waitUntil()`はこのI/O待ち部分をクリティカルパスから外す（応答速度を改善する）手段であり、CPU時間の予算そのものを増やすものではない点に注意

**`generate-jsonParse`: JSON.parse()単体の切り分け計測（2026-08追加）:**

`generate`ステップはKV往復除去後も高い値（実測`maxMs=666ms`）を示すことがあり、原因が「Gemini画像生成レスポンス（base64画像データを含む大きめのJSON）の`JSON.parse()`自体が重い」のか別要因かを推測ではなく実測で切り分けるため、`JSON.parse(resText)`単体の所要時間を`generate-jsonParse`という別ステップとして`handleGenerate()`内に追加計測する。`generate`（全体）と`generate-jsonParse`（`JSON.parse()`のみ）を`/cpu-usage`で比較することで、`JSON.parse()`が支配的コストかどうかを実測で判断できる。

**同一KVキーへの並行書き込み race の回避**: `generate`と`generate-jsonParse`はどちらも同じKVキー（`cpu-time:YYYY-MM-DD`）にGET→PUTするため、2つのPromiseを先に生成してから並行して`ctx.waitUntil()`/`_deferOrAwait()`に渡すと、read-modify-writeが競合し一方の更新が失われる（`incrementCpuTimeKv()`はアトミックインクリメントではない）。実装時にこの競合を作り込みテストで検出したため、同じKVキーに書き込む2つのチェックポイントは1つの非同期関数にまとめて内部で直列に`await`し、`_deferOrAwait()`には単一のPromiseとして渡す（`usagePromise`は別キー`usage:YYYY-MM-DD`のため引き続き並行実行してよい）。同じ日次ドキュメントに複数ステップを記録する箇所を追加する際は、既存の書き込みとキーが重複していないか確認し、重複する場合は直列化する。

**`generate-autoCrop`（自動トリミング計測）の扱い**: この計測は`handleGenerate()`の外側（`/generate`ハンドラー、`handleGenerate()`が返った後）で行うため、`handleGenerate()`内部の`cpuPromise`（`generate`/`generate-jsonParse`をまとめて書き込む背景タスク）へは呼び出し元からアクセスできず直列化できない。そのため`_recordAutoCropCpu()`は`ctx`を渡さず常に同期`await`し、少なくとも自分自身の書き込みは単発化することで競合の可能性を下げている。それでも`handleGenerate()`側の背景書き込みとの完全な排他は保証されない（診断用の集計値のため、稀な取りこぼしは許容している）。

**KV書き込み回数の制約による対象範囲の線引き（2026-08追加）:**

Workers KV Free プランは書き込み1日1,000回までという厳しい制限があるため、全経路にKV集計を入れるのではなく、既存のレート制限で書き込み量が自然に上限管理されている経路のみを対象にする。

| 経路 | KV集計 | 理由 |
| --- | --- | --- |
| Cron `generateResearchPool()` / `runBot()` / `checkForNewSale()` | 対象 | 1日3回のみ（`checkForNewSale()`のGemini抽出自体は新着セール記事検知時のみさらに稀） |
| `POST /research` / `POST /generate`（`handleResearch()`/`handleGenerate()`内部で計測） | 対象 | 既存レート制限（`/research` 10回/日/IP・`/generate` 3回/日/IP・50回/日グローバル）で書き込み量が有界 |
| `POST /suzuri-create` | 対象 | 生成1回につき数回程度、同様に有界 |
| `GET /image/:id`（`getImageFromR2()`） | **対象外**（`console.log`のみ） | レート制限がなく訪問のたびに呼ばれるため、KV書き込みすると1,000回/日の予算を圧迫しうる |

`research`/`generate`のCPU計測は`handleResearch()`/`handleGenerate()`自体の内部に実装する（呼び出し元の`runBot()`外側でラップしない）。これにより`generateResearchPool()`の10並列呼び出し・`runBot()`・`/research`・`/generate`エンドポイントのすべてを1箇所の実装で自動的にカバーする（DRY）。

**`textModel`/`imageModel` と `textModelResolved`/`imageModelResolved` の違い（2026-07追加）:**

`selectBestModel()`/`_resolveImageModel()`が選ぶモデル名（`textModel`・`imageModel`）は`gemini-flash-lite-latest`のような**エイリアス名**の場合があり、実際にどのバージョン（2.5・3.5等）が使われたかはこの文字列だけでは判別できない。GeminiのAPIレスポンス（`generateContent`）には`modelVersion`フィールド（実際に使用された解決済みモデル名を返す。[公式ドキュメント](https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse)で確認済み）が含まれるため、これを`textModelResolved`/`imageModelResolved`として追加保存する。

- `handleResearch()`と画像生成の`callModel()`はそれぞれ`data.modelVersion`を取得し、`incrementUsageKv(kv, kind, tokens, model, resolvedModel)`の第5引数として渡す
- `resolvedModel`が取得できない場合（レスポンスにフィールドが存在しない等）は該当日の`textModelResolved`/`imageModelResolved`を更新しない（前回値を保持）
- 画像生成モデルは以前`incrementUsageKv()`の`model`引数を受け取っていながらKVに保存していなかった（記録漏れ）。今回`imageModel`として保存するよう修正した
- 過去に記録済みの日次データ（`imageModel`/`textModelResolved`/`imageModelResolved`が存在しない古いエントリ）は再集計しない。新しい呼び出し分から順次記録される

### Gemini画像生成プロンプト（`handleGenerate()`・2026-05変更）

`themeEn`/`descriptionEn`が利用可能な場合は英語版を使用し、未取得の場合のみ日本語の`theme`/`description`にフォールバックする。

```text
Theme: {themeEn || theme}.
Context: {descriptionEn || description}.
Setting and surrounding atmosphere; the cat may naturally interact with theme-related items...: {visualHint}.
```

- altテキスト・SUZURI商品説明は**日本語のみ**（`theme`/`description`を使用。変更しない）
- `themeEn`/`descriptionEn`は`handleGenerate(body)`の`body`経由で受け取る（ボット: `research.themeEn`/`research.descriptionEn`から渡す。ユーザー生成: `/generate`リクエストボディに含めてもよいが必須ではない）
- プロンプト構築は`_buildGeminiPrompt()`としてexport済み（2026-06）。`_buildPollinationsPrompt()`と同じく純粋関数として切り出し、`handleGenerate()`から呼び出す

### Style行の季節カラー（`getSeasonalStyleTone()`・2026-06追加）

**背景（Bug#26）**: Style行が年間共通の固定文言`light pink and beige tones`だったため、テーマ・visualHintに花の言及がない日でもGeminiが桜の花びらを装飾として補完してしまう問題があった。

```text
Style: soft pastel colors, {getSeasonalStyleTone(today)}, gentle watercolor brushstrokes, white background, Japanese illustration style.
```

- `getSeasonalStyleTone(dateStr)`は`SEASONAL_FLOWERS`（既存の24エントリ・`startMd`/`endMd`境界）に追加した`style`フィールド（ASCII英語の色調記述）を返す。季節補充フォールバック専用だった`SEASONAL_FLOWERS`を「年間の色調テーブル」として再利用し、新しい日付テーブルは作らない
- `today`には`toJSTDateStringWorker(new Date())`を使用。季節補充フォールバック（`generateResearchPool()`）限定ではなく、**すべてのGemini画像生成**（ユーザー生成・ボット投稿問わず）に適用する
- 実際にピンク系の花が咲く時期（梅・彼岸桜・染井吉野・皐月・蓮・百日紅・秋桜）は`style`もピンク系トーンを維持する。季節と合致する桜表現は引き続き可能
- ネガティブ指示`Do not add cherry blossoms, falling flower petals, or other seasonal decorations that are not explicitly mentioned in the Theme, Context, or Setting above.`をStyle行の後に追加（保険・デフェンスインデプス）。Theme/Context/Setting欄に明示された場合（例: 春のvisualHintに桜が含まれる）は除外対象にならない
- **物理オブジェクト化・円形フレーム化の禁止（Bug#27・2026-07追加）**: 上記ネガティブ指示に続けて`Do not render the scene as if painted, printed, or mounted on a plate, dish, fan, tapestry, or any other physical object, and do not add a circular frame, border, or vignette around the subject.`を追加。生成画像が丸皿・団扇等の工芸品風にレンダリングされ、SUZURI連携（缶バッジ/アクキーの二重クロップ・Tシャツ/ステッカーの余白汚染）に悪影響を及ぼす問題への対処。**原因は未確定**（蓮エントリ`07-01`〜`07-15`のStyle行に唯一含まれていた`pond`語を疑ったが、報告事例のTheme/Context/Setting側には蓮・池を連想させる語がなく断定できなかった）のため、原因非依存で効果のあるネガティブ指示を主策とした。蓮エントリの`style`からは`pond`語を除去し他エントリと同じ「色調＋抽象的雰囲気語」パターンに統一済み（`"soft pink and deep green tones, tranquil summer calm"`）。詳細は`bugs-history.md`のBug#27参照

### 構図の余白削減指示（2026-08追加）

**背景**: ユーザーから「くり抜く構図自体は良いが、被写体の周囲の余白が多い」と指摘（無料版Geminiでの手動テストで象の日テーマの生成画像を確認）。`Style:`行の`white background`指示のみでは、Geminiが被写体を小さく中央に配置し周囲を白背景で埋める構図になりやすい問題があった。`white background`自体はSUZURI缶バッジ/アクキーの円形クロップに必要なため維持し、余白の「量」だけを削る構図指示を追加した。

```text
Setting and surrounding atmosphere...: {visualHint}.
Composition: fill the frame with the cat and scene elements, leaving only a small, even margin around the edges. Avoid large empty corners or a distant, isolated subject floating in excess white space — the illustration should feel full and immersive, not small or shrunken.
Style: soft pastel colors, {getSeasonalStyleTone(today)}, gentle watercolor brushstrokes, white background, Japanese illustration style.
...
Do not render the scene as if painted, printed, or mounted on a plate, dish, fan, tapestry, or any other physical object, and do not add a circular frame, border, or vignette around the subject. Do not leave large blank margins or empty corners around the subject.
```

- `_buildGeminiPrompt()`: `Setting`行の直後・`Style`行の直前に`Composition:`行を追加。末尾の否定指示（Bug#27の円形フレーム禁止文）に続けて「余白を残さない」念押しの否定指示を1文追加（Bug#27と同じ「構図指示＋念のための否定指示」の二段構え）
- `_buildPollinationsPrompt()`: keyword列挙形式のため、`parts`配列の末尾（`"pastel colors, white background"`の後）に`"full frame composition, minimal empty space"`を追加。フルセンテンスではなくキーワードで同じ意図を伝える
- **効果は未確定な部分あり**: ユーザーの手動テスト（無料版Gemini・象の日テーマ）では「完璧ではないが前より余白が減った」という結果。プロンプトのみでの完全解決は保証されない。2026-08時点でBot投稿（`bot/2026-08-26`）で再び余白過多が確認され、プロンプト指示だけでは不安定と判明した

### 猫以外への顔・擬人化の禁止（Bug#33・2026-09追加）

**背景**:「草の日」テーマの生成画像で、メインの猫（白いラグドール）とは別に、草むらの中に猫の顔がもう1つ描かれる事象が発生した。実際のプロンプトを確認したところ、`visualHint`が`cute green cat, lush grass field, tiny wildflowers, sunny morning, soft fur, playful expression`となっており、先頭の主役名詞がGeminiによって「草」を擬人化した「かわいい緑の猫」になっていた。2026-07の既知の未対応バグ（「visualHintで食材が主役名詞になると猫の絵に直接合成されて不気味になる」＝半夏生でタコの足が猫に生えた件）と同じ原因の類型で、対象が食材から植物に広がったケース。

Bug#27（丸皿画像・原因未確定）と同じ考え方で、**原因が確定していても効果を確実にするため、対症療法（常時ネガティブ指示）を主策、根本原因への対処（visualHint生成プロンプトの調整）を補助策として両方実施**した。

**主策: 常時ネガティブ指示（`_buildGeminiPrompt()`）**

従来`eatingAction`が真のときのみ付与していた「食べ物には顔をつけない」指示を、常時・全要素対象に汎用化した。

```text
Only the cat(s) described above should have a face, eyes, or expression. Do not depict grass, plants, flowers, food, or any other scenery element with a face, eyes, or anthropomorphized expression.
```

- 末尾のネガティブ指示群（Bug#27の丸皿・円形フレーム禁止、余白禁止に続く）に追加し、`eatingAction`の有無にかかわらず常に含まれる
- 旧来の`eatingAction`専用文言（`Only the cat has a face and expressions; all food items must be depicted as ordinary objects without faces or eyes.`）はこの汎用指示に統合し廃止（重複指示を避けるため）
- `_buildPollinationsPrompt()`はkeyword列挙形式のため、`parts`配列末尾に`"only the cat has a face, no faces on other objects"`を追加

**補助策: visualHint生成プロンプトの調整（`handleResearch()`）**

主役名詞の抽出指示に「テーマ自体を動物・猫として擬人化しない」旨の制約を追加（詳細は下記「visualHintの役割」参照）。

### 生成後の自動トリミング（コード側補正・2026-08追加・計測フェーズ）

プロンプト指示が不安定なため、Photon（WASM画像処理ライブラリ、`worker/bot.js`の`shrinkImageIfNeeded()`ですでに使用）でコード側から余白を検出・トリミングする機能を追加した。

**重要な前提**: Bot投稿（`runBot()`）は生成〜R2保存〜Bluesky/Mastodon投稿まで**フロントエンドを一切経由しない**（`frontend/index.html`のCanvas処理が動くのは訪問者がSUZURI登録するときだけ）。そのためBot投稿画像の余白を直すには**Worker側（サーバー側）でのコード補正が必須**で、フロントのCanvas処理だけでは解決しない。

**アルゴリズム（`worker/image-utils.js`）:**

1. Photonで画像をデコードし、64×64程度に縮小（`resize`）
2. 縮小画像のピクセル（`get_raw_pixels()`）をJSでスキャンし、各辺から内側に向かって「ほぼ白」の行・列を探索して被写体のバウンディングボックスを検出（`_detectCropBox()`・WASM非依存の純粋関数）
3. 検出した比率（0〜1）をフル解像度の座標に換算し、フル解像度画像を`crop()`
4. 安全策: 検出した余白が閾値未満ならトリミングしない（`minMarginRatio`）、1辺あたりの最大クロップ率に上限（`maxMarginRatio`）、被写体ギリギリまで詰めない安全パディング（`paddingRatio`）

**CPU時間の実測結果（Node.js環境・1024×1024画像・2026-08計測）:**

| 処理 | 所要時間 |
| --- | --- |
| デコード | 約3ms |
| 64×64縮小 | 約10ms |
| 縮小画像のピクセル取得＋余白スキャン（JS） | 1ms未満 |
| フル解像度クロップ | 約12〜20ms |
| PNG再エンコード | 約22〜27ms |
| **合計** | **約45〜60ms** |

余白検出のJSスキャン自体は想定通り軽量（1ms未満）だが、**Photonネイティブのcrop/エンコード処理自体が支配的コスト**であることが判明。`shrinkImageIfNeeded()`（Bluesky上限超過時のみ発動する条件付き処理）と異なり、この処理は生成のたびに無条件で発生するため、Workers Freeプランの公式CPU上限（10ms/リクエスト）は大きく超過する。Bug#32で観測された非公式な猶予（243〜297ms）の範囲内ではあるが、その猶予自体が2026-08に一度枯渇して障害化した経緯があるため、無条件に本番投入するのは危険と判断した。

**ロールアウト方針（2026-08時点）**: リスクを抑えるため、**まず`/generate`（ユーザー生成・レート制限あり: IP 3回/日・グローバル50回/日）のみ**に適用し、`runBot()`（平日Cron・1日1回・失敗時のリカバリー手段なし）には組み込まない。`recordCpuCheckpoint("generate-autoCrop", ms, env.RATE_KV)`で実際のCloudflare Workers（`workerd`）上のCPU時間を`/cpu-usage`から確認し、安全と判断できてから`runBot()`への適用を検討する（Node.js計測はあくまで目安で、実際のWorkersランタイムとは特性が異なる可能性がある）。**2026-09に`runBot()`へも適用済み（下記「`runBot()`への適用」参照）。**

**CPU計測は機能しないことが判明（2026-08）**: 実際に`/generate`を実行し`/cpu-usage`を確認したところ、`generate-autoCrop`は常に`0.0ms`だった（エラーなし・機能自体は正常動作）。原因はCloudflare Workersの仕様で、`performance.now()`は**I/Oが発生したときしか進まない**（Spectre対策。[公式ドキュメント](https://developers.cloudflare.com/workers/runtime-apis/performance/)で確認済み）ため。`autoCropImage()`はPhotonのデコード・縮小・crop・エンコードがすべて同期処理でI/Oを挟まず、区間内で`performance.now()`が一切進まないため差分が原理的に常に0になる。`recordCpuCheckpoint()`ベースの計測はこの種の純粋同期処理には使えないと判明した。実CPUコストの確認にはCloudflareダッシュボードの分析画面（アカウント所有者のみ閲覧可能）等、JSコードから観測できない経路が必要。詳細は`.claude/archive/revision_log_2026-08.md`参照

**`runBot()`への適用（2026-09追加）**: CPU実測は上記の理由で未確認のままだったが、実際の本番投稿画像（`bot/2026-09-03`）に対して`_detectCropBox()`を実データで検証したところ、余白（上10.5%・下12.1%・左右5.8%）を正しく検出できることを確認した。Node.js実測（約45〜60ms/回）とBug#32で観測された非公式CPU猶予（243〜297ms実績）を踏まえ、ユーザーの承認を得て`runBot()`にも適用した。`worker/bot.js`の`runBot()`が`handleGenerate()`の直後、R2保存の前に`autoCropImage()`を呼ぶ（`/generate`ハンドラーと同じ「常に同期await・ctx未使用」パターン。理由は同じKVキーへの並行書き込みraceを避けるため）。失敗時は元の未トリミング画像にフォールバックし、投稿自体は失敗させない

- 失敗時（Photon読み込み失敗・例外等）は元の未トリミング画像にフォールバックし、生成自体は失敗させない
- 出力は常にPNG（`get_bytes()`）に統一し、`mimeType`もそれに合わせて上書きする

**季節補充フォールバックのkana/英語フィールド（`getSeasonalFlowerKana()`/`getSeasonalFlowerEn()`・2026-07追加・Bug#31）:**

`generateResearchPool()`の季節補充フォールバック（当日のリサーチプールが3件未満のときに`SEASONAL_FLOWERS`から直接組み立てるエントリ）は、Geminiを呼ばないため通常エントリが持つ`themeKana`/`descriptionKana`/`themeEn`/`descriptionEn`が欠落しており、かなモード・英語モードで日本語表示にフォールバックしていた。

- `SEASONAL_FLOWERS`の各エントリに`kana`（花の名前のruby HTML、例: 桔梗→`<ruby>桔梗<rt>ききょう</rt></ruby>`）・`en`（花の英語名、例: `Balloon Flower`）フィールドを追加。`visual`/`style`と同じ人手管理パターンで、Gemini API呼び出しは追加しない
- `getSeasonalFlowerKana(dateStr)`/`getSeasonalFlowerEn(dateStr)`を`getSeasonalFlowerVisual()`と同じ形で新設
- 季節補充フォールバックのオブジェクトは`theme`/`description`の固定テンプレート（「の季節」「今の季節を彩る」）部分のふりがなと組み合わせて以下を組み立てる:
  - `themeKana`: `${flowerKana}の<ruby>季節<rt>きせつ</rt></ruby>`
  - `descriptionKana`: `<ruby>今<rt>いま</rt></ruby>の<ruby>季節<rt>きせつ</rt></ruby>を<ruby>彩<rt>いろど</rt></ruby>る${flowerKana}`
  - `themeEn`: `${flowerEn} Season`
  - `descriptionEn`: `${flowerEn} is the highlight of this season.`（苔・紅葉・銀杏・千両等「花が咲かない」季節要素にも使えるよう「bloom」等の開花表現は避ける。Bug#25と同じ配慮）
- `themeKana`/`descriptionKana`は`<rp>`フォールバック括弧を付けない。Geminiが生成する`themeKana`の既存例（プロンプト内サンプル・`handleResearch()`のテスト用フィクスチャ）と表記を揃えるため

### visualHintの役割（2026-05変更）

旧役割: テーマが日本語のみのときPollinationsプロンプトのASCII化で内容が失われる問題を補完（「日本語回避」）。

新役割: テーマに依存せず**ビジュアル演出**に特化。`themeEn`で英語テーマが確保されるため、visualHintは主役名詞＋背景・小物・雰囲気の提示に集中する。

**`handleResearch()`のvisualHint生成指示（2026-05更新）:**

```text
今日の記念日テーマから主役となる名詞（動物・物・人物）を1〜2語で先頭に抽出し、
続いて関連する背景・小物・雰囲気を3〜6語で続ける。ASCII英語、計5〜8語。
主役名詞はテーマそのものの実際の姿で表現し、テーマを猫や他の動物に擬人化しない
（例:「草の日」→ 草はそのまま "grass" と表現し、"green cat" のような猫化はしない）。
例: 図書館記念日 → library books, warm reading nook, wooden bookshelves, soft lamplight
例: 象の日 → large friendly elephant, Kyoto imperial garden, pine trees, stone lanterns
```

**Bug#33（2026-09追加）**: 上記「テーマを猫や他の動物に擬人化しない」制約を追加。「草の日」でGeminiが草を「かわいい緑の猫」として擬人化し、画像内にメインの猫とは別の猫顔が描画される事象への対処（詳細は上記「猫以外への顔・擬人化の禁止」参照）。

**Pollinationsでのvisualの使い方（安全網ロジック）:**

`_buildPollinationsPrompt`の`usedVhAsSubject`ロジックは`themeEn`が空の稀なフォールバック用に残存する。`themeEn`が存在する場合は`usedVhAsSubject=false`となり、visualHint全体がビジュアル演出として使われる。
