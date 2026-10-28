# アーキテクチャ詳細: Bluesky Bot

> `.claude/rules/architecture.md`から移動した（2026-10）。毎セッション自動で読み込まれるファイルを軽くするため、詳細をこのファイルに分けた。本文は移動前のまま。

## Bluesky Bot

### 設計方針

- Botアカウント: `@nyanmusu.bsky.social`
- 投稿スケジュール: 月〜金 7:00 JST（UTC 22:00 前日）、Cron式: `0 22 * * 1-5`（2026-05-01より。変更前: `0 10 * * 2-6`（19:00 JST））
- ハッシュタグ: テーマ由来の動的タグ1件を先頭に置き、固定タグ`#AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー`を後続（Instagramで末尾タグを省略しやすくするため）
- エラー時: リトライなし（`/generate`内部にPollinationsフォールバックあり）
- Mastodon同時投稿: `Promise.allSettled`で並列実行。Mastodon失敗はBluesky投稿に影響しない。シークレット未設定時はスキップ
- **Mastodon設定エラー検出**: `MASTODON_INSTANCE_URL`が`https://`で始まらない場合は`throw new Error(...)`でPromise.allSettledに拒否を返し、Discordの`mastoLine`に`❌ Mastodon投稿失敗: 設定エラー`として表示する（旧: `return null`でスキップしていたが、Discordに何も出ず原因不明になるため変更）。投稿後にstatus=401/403が返った場合も「設定エラー（認証失敗）」として`console.error`に分類して出力する
- **Mastodon未設定時**: `mastoLine`に`⏭️ Mastodon未設定・スキップ`を表示し、`console.log`でCloudflareログにも記録する（旧: Discord通知から行ごと省略していたため処理状態が不明だった）
- **R2保存キーのスロット方式（`bot/YYYY-MM-DD-n`）**: 同日に複数回`runBot()`が実行された場合（意図的・偶発的を問わず）、既存のR2キーを上書きせず`bot/YYYY-MM-DD-2`、`bot/YYYY-MM-DD-3`…とスロットをずらして保存する。`findAvailableR2Id(bucket, jstDateISO)`がmeta.jsonの存在確認で次のスロットを決定する（最大`-9`まで、超過時は`-9`を上書き）。ギャラリー・RSSは`bot/YYYY-MM-DD`（1スロット目）のみ参照。2スロット目以降のBluesky共有URLは`?id=bot/YYYY-MM-DD-2`形式で有効。削除は`listExpiredIds()`がスロット単位で自然に処理する（変更不要）

### `scheduled()`のCron明示チェック（2026-09追加・Bug#40）

`worker/index.js`の`scheduled()`は、`"0 15 * * *"`・`"0 16 * * *"`のいずれにも一致しない`event.cron`をすべてBot Cron分岐（実投稿）に流す設計だった。この設計上、Cloudflareダッシュボードの「コード編集画面→HTTP→Scheduled→送信」で手動テストした際に想定と異なる`event.cron`値が渡ると、無条件に本番投稿が実行されてしまう問題があった（2026-09、実行者不明のまま本番投稿が2重発生。Cronイベントログ・監査ログのいずれにも記録が残らず原因特定不能だった。詳細は`.claude/bugs-history.md`のBug#40参照）。

修正: Bot Cron分岐に入る条件を`event.cron === "0 22 * * 1-5"`の明示一致チェックに変更した。一致しない値（未知のcron・ダッシュボードでの誤操作等）の場合は投稿処理を実行せず`console.warn`でログのみ出力する。ただしこれは「ダッシュボードでダミーの/未知のcron値が送られた場合」のみを防ぐ多層防御であり、仮に正しい`"0 22 * * 1-5"`をダッシュボードから明示的に選んで送信された場合までは防げない。**本命の対策はダッシュボードのScheduled手動送信機能自体を使わない運用への切替**（下記「手動実行エンドポイント」参照）。

### 手動実行エンドポイント（`POST /bot/manual-run`・2026-09追加・Bug#40）

Cloudflareダッシュボードの手動Scheduled送信は、Cronイベントログにも監査ログにも記録が残らず「誰が・いつ発火させたか」を事後追跡できない（Bug#40で実際に発生し、実行者を特定できなかった）。この方法を廃止し、既存の`BYPASS_TOKEN`で保護されたHTTPエンドポイント経由に統一した（`/monthly-wallpaper/regenerate`と同じ設計パターン）。

- `worker/index.js`: `POST /bot/manual-run`。`isBypassed(request, env)`で403チェック後、`runBot(env, handleResearch, handleGenerate, ctx, { dryRun })`を呼ぶ。`dryRun`はクエリパラメーター`?dryRun=false`のときのみ`false`（それ以外・省略時は`true`）。**安全側をデフォルトにする**ことで、誤って叩いても実投稿されない
- `worker/bot.js`: `runBot(env, handleResearch, handleGenerate, ctx = null, deps = {})`に`deps.dryRun`（デフォルト`false`）を追加。`true`のとき以下をスキップする:
  - R2保存（`saveToR2()`。`pageUrl`は`SITE_URL`のまま）
  - Bluesky投稿（`createBlueskySession()`/`uploadBlob()`/`createPost()`）
  - Mastodon投稿（`uploadMediaToMastodon()`/`postStatusToMastodon()`）
  - セール告知リプライ
  - `research`/`generate`（Gemini API呼び出し）は`dryRun`時も実行される（生成内容そのものの確認が目的のため）。Discord通知は`🧪 テスト実行（投稿は行われていません）`を明記したうえで、実際に投稿されるはずだった`buildPostText()`/`buildMastodonText()`の出力をプレビューとして送信する
- 戻り値: `runMonthlyWallpaperPost()`と同じパターンで`{ dryRun, bskyOk, mastoOk, theme }`（またはエラー時`{ error }`）を返すよう`runBot()`をvoidから変更した
- Cron本番実行（`scheduled()`からの呼び出し）は`deps`省略のため`dryRun: false`扱いで、従来と完全に同じ挙動（後方互換）
- **パラメーターは大文字小文字を区別する**: `dryRun`が本番投稿になるのは`?dryRun=false`と完全一致したときだけ。`False`・`dryrun`等は`true`（テスト実行）のまま（安全側）。2026-10-21、iPhoneからの本番実行で「テストが続く」事象があり、原因はURLの入力違いの可能性があるが特定できていない（サーバー側の解釈はローカルで確認済み）。大文字小文字に依らず受け付ける改善は未実装（`.claude/future-ideas.md`の「運用改善（2026-10-21の事象から）」参照）
- **同日に本番実行を2回以上行うと**、`findAvailableR2Id()`により保存先が`bot/YYYY-MM-DD-2`〜`-9`になり、投稿のリンクは新しい保存先を指す。一方、ギャラリー・RSSは基本の保存先（`bot/YYYY-MM-DD`）しか参照しないため、手動で再生成した日は朝の古い絵が出る可能性がある（未対応）
- Discord通知には`🤸 ポーズ: ...`行が出る（ポーズ指定なしの場合は出ない。`.claude/rules/architecture.md`の「猫のポーズ」参照）

### 再投稿モード（`POST /bot/manual-run?mode=repost`・2026-10追加）

**背景**: 2026-10-21、Bluesky APIが`502`を返してBluesky投稿だけが失敗した（Mastodonは成功）。Bluesky・Mastodon投稿は二重投稿を避けるため意図的にリトライしない設計のため、失敗した側だけを後から投稿し直す手段が必要になった。ただし`502`・タイムアウトは「サーバー側では投稿が作られていた」可能性があるため、**再投稿の前に必ず投稿済みかを確認する**。

```bash
# 確認のみ（デフォルト）: 投稿済みかどうかをプラットフォーム別に調べて報告する。投稿はしない
curl -X POST "https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run?mode=repost&date=2026-10-21" \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"

# 未投稿と確認できたSNSにだけ実際に投稿する
curl -X POST "https://anniversary-cat-worker.hiroshikuze.workers.dev/bot/manual-run?mode=repost&date=2026-10-21&platform=bluesky&dryRun=false" \
  -H "X-Bypass-Token: <BYPASS_TOKENの値>"
```

- クエリ: `date`（必須・`YYYY-MM-DD`。同日の2件目以降は`YYYY-MM-DD-2`〜`-9`）・`platform`（`bluesky`/`mastodon`/`both`・省略時`both`）・`dryRun`（省略時`true`）。`date`を省略可にしない（誤って別の日を再投稿しないため）
- 実装: `worker/index.js`の`POST /bot/manual-run`が`mode=repost`のとき`worker/bot.js`の`repostBot(env, { date, platform, dryRun }, deps)`を呼ぶ。`mode`省略時は従来どおり`runBot()`

#### 投稿済みの判定

| プラットフォーム | 取得方法 | 備考 |
| --- | --- | --- |
| Bluesky | `GET {BLUESKY_API}/com.atproto.repo.listRecords?repo={BLUESKY_IDENTIFIER}&collection=app.bsky.feed.post&limit=30`（認証不要） | 2026-10に実機で認証なしで取得できることを確認済み。PDSを直接読むためAppViewのインデックス遅延がない |
| Mastodon | `GET /api/v1/accounts/verify_credentials`でIDを取得（認証あり）→`GET /api/v1/accounts/{id}/statuses?limit=30&exclude_replies=true`（**認証なし**・公開投稿の取得） | 本文HTMLの`href`にページURLが含まれる。投稿一覧に`Authorization`を付けない理由は下記 |

- **投稿一覧は認証なしで取得する（2026-10-29・Bug#50）**: Botのトークンのスコープは`write:statuses`＋`write:media`（＋アカウント確認の`profile`）だけで、`read:statuses`を持たない。このトークンを付けたまま`/accounts/{id}/statuses`を呼ぶと`403 This action is outside the authorized scopes`になり、確認が`unknown`（投稿しない）に倒れて再投稿できなかった。Botの投稿は公開のため、認証なしでも取得できる。トークンに`read:statuses`を足す案は、漏えい時の影響が大きくなるため採らない
- 非公開（フォロワー限定・ダイレクト）の投稿は認証なしでは見えない。Botは公開投稿のみのため問題ない

- 判定は「本文に`?id={id}`を含むか」（`containsPostMarker()`）。**`?id=bot/2026-10-21`が`?id=bot/2026-10-21-2`にも前方一致して誤判定しないよう**、直後が英数字・`_`・`-`以外であることを要求する
- 結果は3値: `exists`（投稿済み・投稿しない）・`missing`（未投稿と確認・投稿対象）・`unknown`（確認用APIの失敗。**投稿しない**。迷ったときは二重投稿を避ける側に倒す）。Mastodon未設定は`skipped`
- `limit=30`の範囲外（約30件より古い投稿）は確認できないため`missing`と判定されうる。直近の失敗の復旧を想定した用途のため許容する

#### 再投稿の内容

- 新しいリサーチ・画像生成は行わない。R2の`{id}/meta.json`と`web.png|jpg`を使う（R2に無ければエラー）
- R2メタに`themeHook`/`themeHookEn`・ゲストSNSタグは保存されていないため、**常にfull形式**で組み立てる（`buildPostText()`/`buildMastodonText()`・CTAは`pickCta()`で再抽選）。元の投稿とは文面が変わりうる
- 戻り値: `{ dryRun, id, bluesky, mastodon }`。各値は`{ status, posted?, error? }`。Discordにもプラットフォーム別の確認結果と投稿結果を通知する

### 投稿フォーマットの選択（short/full・2026-10追加）

**背景**: 毎回「説明文＋CTA＋サイトURL」のフル構成だと、(1) 絵と説明だけでSNS上で満足されクリックスルーに繋がっていない、(2) 毎回CTA＋紹介URLが付くことで「宣伝ポストっぽさ」が強まりフォロー動機を阻害している、という2つの懸念がユーザーから指摘された。対応として、投稿の大半をテーマ連動の短い一言＋URL＋ハッシュタグのみの**short版**にし、残りは効果比較・サービス再認知のため従来の**full版**を流す設計にした。

`worker/bot.js`に`pickPostFormat()`を`CAT_PERSONALITIES`等（`worker/index.js`）と同じ「重み付き配列＋pick関数」パターンで新設する。

| フォーマット | 重み | 確率 |
| --- | --- | --- |
| `short` | 80 | 80% |
| `full` | 20 | 20% |

- `pickPostFormat()`は`runBot()`内で`pickCta()`と同じタイミングで**1回だけ**呼び出し、Bluesky・Mastodon両方の生成に同じ結果を渡す（同じ投稿でBluesky版・Mastodon版の形式が食い違わないようにするため）
- `themeHook`（下記「themeHook/themeHookEnフィールド」参照）が取得できない場合（旧データ・Gemini取得失敗時等）は、`short`が選ばれていても`full`にフォールバックする（short版はthemeHookが必須のため）
- `#{theme正規化}`ハッシュタグはshort版でも**残す**（ユーザー判断:「URLを踏むまで何の日か分からない」という完全な伏せ字は行わない。タグ経由の流入が無視できないため）

#### themeHook/themeHookEnフィールド（`handleResearch()`）

テーマに絡めた、猫目線のウィットに富んだ一言。事実説明（`description`）の言い換えではなく問いかけ・つぶやき調にする指示をGeminiプロンプトに追加し、JSON出力に`themeHook`（日本語）・`themeHookEn`（英語）を含める。

- 本実装前に`scripts/test-theme-hook.mjs`（ワンオフ検証スクリプト。`GEMINI_API_KEY=xxx node scripts/test-theme-hook.mjs`で実行、npm testには含めない）で品質を検証済み（[Issue #203](https://github.com/hiroshikuze/anniversary-cat-worker/issues/203)）。同一テーマでも試行ごとに表現が変化し、問いかけ・ボケ調が安定して得られることを確認した
- 検証時に`gemini-2.5-flash-lite`が新規ユーザーに提供終了（404）していることが判明し、`gemini-3.1-flash-lite`/`gemini-3.5-flash-lite`で検証した（[Issue #204](https://github.com/hiroshikuze/anniversary-cat-worker/issues/204)で別途フォローアップ）。本番実装では固定モデル名を書かず、既存の`selectBestModel()`（Discovery API・コストスコアリング・KV記憶・モデル廃止時の自動フォールバック）を流用する
- `stripHtmlTags()`サニタイズ対象に追加済み（`.claude/docs/architecture/gemini.md`の「プレーンテキストフィールドのサニタイズ」参照）
- **季節補充フォールバック由来のエントリ（`generateResearchPool()`が当日のリサーチ結果3件未満時に`SEASONAL_FLOWERS`から組み立てる合成エントリ）は、当初`themeHook`を持たず常にfullへフォールバックしていた（2026-10・実機投稿2日連続でfullになり発覚）**。`_generateFallbackThemeHook()`（`.claude/docs/architecture/gemini.md`の「季節補充フォールバックの`themeHook`/`themeHookEn`は例外的にGemini呼び出しで生成する」参照）で解消済み
- **short版が正しく選ばれても、投稿内のURLが個別作品URL（`pageUrl`）ではなく常にトップページ（`SITE_URL`）になっていた（2026-10・実機投稿で発覚・Bug#43）**。`buildPostText()`/`buildMastodonText()`のshort分岐が`pageUrl`引数を使わず`SITE_URL`を直書きしていた実装漏れが原因。下記「投稿テキスト形式」のshort版に修正済みの仕様を記載

### 投稿テキスト形式

#### Bluesky（`buildPostText()`・日本語のみ）

**full版:**

```text
今日は「{theme}」の日！🐱       ← theme が「の日」で終わる場合は「の日」を省略。「の季節」で終わる場合は「今は「{theme}」！🐱」
{description}

📸 {artworkUrl}                  ← R2保存成功時のみ挿入（?id=bot/YYYY-MM-DD）

{cta.ja}                         ← pickCta()で選択されたCTA行（下記「CTA行のローテーション」参照）
https://hiroshikuze.github.io/anniversary-cat-worker/

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー #{guestSnsTag}
```

- `{guestSnsTag}`はゲスト登場時のみ末尾に追加（例: `#dog` `#rabbit`）。伴侶猫・子猫は`#cat` `#kitten`と重複するため追加しない
- `artworkUrl`は`pageUrl !== SITE_URL`のとき（R2保存成功）のみ追加される。失敗時はCTAのみ（~210 grapheme）
- 300 grapheme以内に収まる設計（`artworkUrl`あり時の実測 ~270 grapheme・ゲストタグ追加後も余裕あり）。テーマタグを先頭にすることでInstagram手動投稿時に末尾タグを省略しやすくしている。

**short版（2026-10追加）:**

```text
{themeHook}
{pageUrl}                         ← R2保存成功時は?id=bot/YYYY-MM-DD付き個別作品URL、失敗時はSITE_URL

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #にゃんバーサリー #{guestSnsTag}
```

- 説明文・CTA行は**含めない**（CTA文言を毎回付けないことで宣伝ポストっぽさを下げる）
- URLは`pageUrl`（full版の📸行と同じ変数）を使う。**2026-10当初実装ではここが`SITE_URL`固定にハードコードされており、short版の投稿リンクが常にトップページになってしまうバグがあった（Bug#43）**。full版は📸行＋CTA行の2URL構成だが、short版はURL行が1本しかないため、その1本を`pageUrl`にする（`SITE_URL`には戻さない）
- `{guestSnsTag}`はfull版と同様に残す（2026-10・ユーザー確認済み: テーマタグで既に「何の日か」が明示される前提のため、ゲスト動物タグの有無による「URLを踏むまで分からない」性への影響は小さいと判断）
- `themeHook`が空の場合はfull版にフォールバックする（上記「投稿フォーマットの選択」参照）

#### Mastodon（`buildMastodonText()`・英語優先・日英二言語）

英語を先に置くことで海外ユーザーへのリーチを優先する。英語セクションには英語版直リンク（`?lang=en`）を、日本語セクションには日本語版直リンクをそれぞれ掲載する。500文字制限の都合上、英語CTAのサイトトップURL（`?lang=en`）は省き、英語直リンクに一本化する。

**short版（2026-10追加）:**

```text
{themeHookEn}
{pageUrl}&lang=en                 ← pageUrl=SITE_URLのまま（R2保存失敗時）は"?lang=en"（区切り文字が異なる点に注意）

{themeHook}
{pageUrl}                         ← R2保存成功時は?id=bot/YYYY-MM-DD付き個別作品URL、失敗時はSITE_URL

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #Nyaniversary #にゃんバーサリー #{guestSnsTag}
```

- Blueskyのshort版と同じ方針（説明文・CTA行を省略）を英日二言語に適用する
- URLは`pageUrl`（full版の📸行と同じ変数）を使う。**2026-10当初実装ではここも`SITE_URL`固定にハードコードされており、英語・日本語どちらのURL行も個別作品URLにならないバグがあった（Bug#43・Bluesky側と同一原因）**
- 英語URL行の区切り文字は`pageUrl`がすでに`?id=...`を持つかどうかで変わる（full版`enArtworkLine`と同じロジック）: `pageUrl !== SITE_URL`なら`${pageUrl}&lang=en`、`pageUrl === SITE_URL`（R2保存失敗時のフォールバック）なら`${SITE_URL}?lang=en`
- `themeHookEn`が空の場合は`themeHook`＋`pageUrl`のみ（Blueskyと同一テキスト）にフォールバック。`themeHook`自体が空の場合はfull版にフォールバックする（上記「投稿フォーマットの選択」参照）

**full版:**

```text
Today is "{themeEn}"!
{descriptionEn}

📸 {artworkUrl}&lang=en          ← R2保存成功時のみ挿入（?id=bot/YYYY-MM-DD&lang=en）

{cta.en}                         ← 同じpickCta()結果の英語版（Blueskyと同一トーンで対になる）

今日は「{theme}」！🐱
{description}

📸 {artworkUrl}                  ← R2保存成功時のみ挿入（?id=bot/YYYY-MM-DD）

{cta.ja}
https://hiroshikuze.github.io/anniversary-cat-worker/

#{theme正規化} #AIart #cat #kitten #ほのぼの #猫 #Nyaniversary #にゃんバーサリー #{guestSnsTag}
```

- `themeEn`・`descriptionEn`は`handleResearch()`がGeminiから取得する英語フィールド
- `themeEn`が空の場合は英語セクション全体を省略し、Blueskyと同一テキスト（`buildPostText()`）にフォールバック
- `descriptionEn`が空の場合は英語説明行のみ省略
- `artworkUrl`は`pageUrl !== SITE_URL`のとき（R2保存成功）のみ英語・日本語の両方に挿入。失敗時は両方省略
- 想定文字数: ~450文字（artworkUrlあり時・Mastodon標準上限500文字以内）
- altテキスト・SUZURI商品説明は**日本語のみ**（変更しない）

**投稿文字数の実行時安全網（2026-07追加・Bug#30）:**

`theme`/`description`が想定外に長い・破損している場合（Gemini出力の異常等）でも、Bluesky/Mastodonの上限超過で投稿自体が失敗しないよう実行時チェックを追加した。

- `buildPostText()`: header（`今日は「{theme}」の日！🐱`）とfooter（artworkUrl・CTA・SITE_URL・ハッシュタグ）を必ず保持し、300 grapheme予算から残りを`description`に割り当てて超過分を切り詰める。header・URL・タグが削られることはない
- `buildMastodonText()`: 最終的な組み立て文字列全体を500 graphemeで切り詰める（Mastodonは英日二言語で構成が複雑なため、Bluesky版のような部分ごとの予算配分ではなく全体の末尾切り詰めで対応）
- `Intl.Segmenter`でgrapheme数を計測する既存のテストパターン（`scripts/test-bot.mjs`）と同じ方式を本番コードにも適用
- Bluesky投稿は二重投稿防止のため意図的にリトライしない設計（「意図的にリトライ対象外の箇所」参照）なので、一度の投稿失敗でその日の投稿機会が失われる。この安全網は根本原因（Bug#30のHTMLタグ混入等）の修正とは独立した多重防御

**CTA行のローテーション（`pickCta()`・2026-07追加）:**

CTA行（Bluesky版`{cta.ja}`・Mastodon英語版`{cta.en}`）は固定文言ではなく、`worker/bot.js`の`CTA_VARIANTS`配列（重み付き5パターン）から`pickCta()`が毎回ランダムに1件選ぶ。テーマ・説明文・ハッシュタグ・URL等の必須情報は変更しない。目的は同一文言の反復による「Bot感」の低減（過去の投稿が毎回一字一句同じCTAだったため）。

- 設計は`CAT_PERSONALITIES`/`CAT_EMOTIONS`（`worker/index.js`）と同じ「重み付き配列 + pick関数」パターン
- `pickCta()`は`runBot()`内で**1回だけ**呼び出し、`buildPostText()`と`buildMastodonText()`の両方に同じ結果を渡す（同じ投稿でBluesky版・Mastodon版のCTAトーンが食い違わないようにするため）
- `CTA_VARIANTS[0]`（現行の固定文言・weight 40%）が`buildPostText()`/`buildMastodonText()`双方の`cta`引数のデフォルト値。デフォルト値のまま呼び出した場合は従来と完全に同一の文言を返す（後方互換）
- 各バリアントは日本語版（`ja`）・英語版（`en`）をペアで保持し、トーンを揃える

**セール告知リプライ（2026-08追加）:**

`worker/sale.js`の`getActiveSaleInfo()`が現在有効なセール情報を返す場合（`_currentSale`の期間内）のみ、本体投稿（Bluesky/Mastodon）が成功した媒体に対してスレッドへのリプライ形式でSUZURIショップ（`https://suzuri.jp/nyanmusu`）への告知を追加投稿する。

- **フック位置**: 本体投稿の`Promise.allSettled`（`bskyOk`/`mastoOk`判定）の直後、Discord通知ブロックより前。**本体投稿の成否と独立したbest-effort**（本体投稿が失敗した媒体にはリプライを送らない。物理的にreply先のuri/cid・ステータスIDが存在しないため）
- Bluesky: `createReplyPost(accessJwt, did, text, parentRef, rootRef = parentRef)`。`com.atproto.repo.createRecord`の`record`に`reply: { root: {uri, cid}, parent: {uri, cid} }`を含める（単発リプライのためroot=parent）。本体投稿IIFEの`accessJwt`/`did`はローカルスコープに閉じているため、リプライ用に`createBlueskySession()`を再取得する
- Mastodon: `postStatusToMastodon(instanceUrl, accessToken, text, mediaId, inReplyToId)`に第5引数`inReplyToId`を追加（省略時`null`・既存呼び出し箇所は4引数以下のままで後方互換）。指定時は`in_reply_to_id`パラメータを付与する
- リプライ文言: `buildSaleReplyTextJa(sale)`（Bluesky・日本語のみ、`buildPostText()`と同じ方針）・`buildSaleReplyTextBilingual(sale)`（Mastodon・英語優先→日本語、`buildMastodonText()`と同じ方針）。URLのfacet化には既存の`buildUrlFacets()`を再利用する
- 失敗時は`console.warn`のみで投稿全体を失敗させない
- Discord通知（1通目）に`🛍️ セールリプライ: Bluesky✅ / Mastodon✅`のような1行を、セール対象時のみ追加する（既存の「値がなければnullを入れて`.filter(Boolean)`で除去」パターンを踏襲）

**「の日」重複防止ロジック（`buildPostText`）:**

- `theme.endsWith("の日")` が true の場合 → `今日は「{theme}」！🐱`（重複なし）
- false の場合 → `今日は「{theme}」の日！🐱`（通常通り付与）
- 例: `"大仏の日"` → `今日は「大仏の日」！🐱` / `"お花見"` → `今日は「お花見」の日！🐱`

**「の季節」の見出し（`buildHeaderJa()`・`buildHeaderEn()`・2026-10-28追加）:**

季節の花補充エントリ（テーマ名が`{花}の季節`）は特定の1日の記念日ではなく、季節全体を指す。「今日は〜の日！」だと1日限定に読めるため、`theme.endsWith("の季節")`のとき見出しを現在形にする。

- 日本語（Bluesky full版・Mastodon日本語部分・themeEn空のフォールバック）: `今は「{theme}」！🐱`（例: `今は「秋桜の季節」！🐱`）
- 英語（Mastodon full版）: `It's "{themeEn}" now!`（例: `It's "Cosmos Season" now!`）。判定は日本語のテーマ名で行う
- 上記以外のテーマ（「の日」を含む）の見出しは変更しない
- 3箇所（`buildPostText()`・`buildMastodonText()`の2経路）に重複していた見出し生成を共通関数に集約する。再投稿（`repostBot()`）も同じ関数経由のため同じ見出しになる
- short形式（`themeHook`＋URL）は見出しを使わないため影響しない

### テーマタグ正規化（`buildThemeTag`）

`research.theme`から記念日テーマをハッシュタグ文字列へ変換する。

- Unicode文字・数字・アンダースコア以外（空白・句読点・記号等）を除去
- 空文字になる場合は`null`を返し、タグ行に追加しない
- 最大30文字でトリム
- 例: `"世界猫の日"` → `#世界猫の日`、`"ロールプレイング・ゲームの日"` → `#ロールプレイングゲームの日`

### 画像altテキスト形式

```text
にゃんバーサリー - 「{theme}」の日！{description}（AIが生成した水彩画風の猫イラスト）
```

- descriptionが空の場合は従来形式: `にゃんバーサリー - 「{theme}」をテーマにAIが生成した水彩画風の猫イラスト`
- テーマと記念日説明を含めることで、スクリーンリーダーユーザーへの情報提供と検索流入の両立を図る

### Discord通知（`notifyDiscord()`）

**制約・動作（2026-04）:**

- Discord Webhook `content` フィールドは**2,000文字上限**（超過するとHTTP 400）
- `notifyDiscord()`は先頭ヘッダー（`{emoji} にゃんバーサリーBot\n`）を確保したうえで本文を上限内に切り詰め、末尾に`\n...`を付加する
- 送信後は`res.ok`を確認し、失敗時は`console.warn`でログを出力する
- タイムアウト: `AbortSignal.timeout(10_000)`（10秒）
- `webhookUrl`が未設定の場合は即座にreturnしてスキップ

**3通構成（2026-10-27変更。旧: 2通構成〔2026-04追加・2026-05再編〕）:**

平日朝のBot投稿（`runBot()`）のDiscord通知は、`buildBotDiscordMessages()`（`worker/bot.js`・純粋関数）が組み立てた3通を`notifyDiscord()`で順次送信する。

- **1通目** (`✅`/`❌`。dryRun時は`🧪`): **投稿成否（SNSの投稿結果）** + テーマ情報 + Geminiプロンプト（採用/不採用いずれも表示。1通に入るだけ）
- **2通目** (`📋`): 1通目に入りきらなかった**Geminiプロンプトの続き**（ある場合のみ。`（Geminiプロンプトの続き）`と明記）+ Pollinationsプロンプト
- **3通目** (`📣`): 転載用テキスト（Bluesky投稿テキスト + Mastodon投稿テキストまたは注記）
  - `themeEn`あり（日英二言語）: `📣 Mastodon投稿テキスト（二言語・転載用）:\n{mastoText}`
  - `themeEn`なし（日本語のみ）: `⚠️ themeEn未取得のためMastodon投稿テキストはBlueskyと同一（日本語のみ）`
- **2〜3通目にはSNSの投稿結果（✅/❌/⏭️の成否行）を書かない**。成否は1通目の先頭だけに置く
- **文字数**: Discordの上限（1通2,000字）に収める。各通の本文は`DISCORD_BODY_LIMIT`（2,000字からヘッダー分を引いた値）以内で、超える分は文の区切り（改行→`。`/`. `→空白→強制）で分割して次の通へ送る。1通目→2通目の繰り越し以外で2,000字を超える場合（極端に長いプロンプト等）は、同じ絵文字の続きの通を追加する（通常は3通）。**どの通でも切り捨てない**（旧`notifyDiscord()`の`...`切り詰めは最後の安全網として残す）

**旧方式（2通構成）を変えた理由（2026-10-27）**: (1) 旧2通構成は、1通目に成否＋テーマ情報＋Geminiプロンプトを入れていたため、Geminiプロンプトが長い日は末尾が切られていた（ポーズ軸の追加でプロンプトが約260字増え、代表的な値で約28%→約42%が切れた）。(2) 2通目に成否を再掲していた理由は「1通目が文字数で省略されても結果を確認できる」だったが、成否は1通目の先頭にあり切り捨てられるのは末尾（プロンプト）なので、実際には役に立っていなかった（月替わり壁紙の通知は、はじめから再掲しない設計）。

**投稿URLの記載（2026-09追加）**: 投稿成功時、Discord通知の成否行に実際の投稿URLを付与する。目的は、テスト投稿・本番投稿を問わず、Discordを見るだけで実際に何が投稿されたか確認・削除できるようにするため（従来はCloudflare Workers Logsを検索してAT URI/ステータスIDから手動でURLを組み立てる必要があった）。

- Bluesky: `buildBlueskyPostUrl(uri, identifier)`（`worker/bot.js`・純粋関数）が、`createPost()`の戻り値`uri`（AT URI形式`at://{did}/app.bsky.feed.post/{rkey}`）末尾のrkeyを抽出し、`https://bsky.app/profile/{identifier}/post/{rkey}`を組み立てる。`identifier`には`env.BLUESKY_IDENTIFIER`（ハンドル、例: `nyanmusu.bsky.social`）を渡す。didではなくハンドルを使うことでURLが人間にも読みやすくなる
- Mastodon: `postStatusToMastodon()`の戻り値（Mastodon Status API）に含まれる`url`フィールドをそのまま使う（Mastodon API仕様上Status entityは常に投稿ページの正規URLを`url`として返すため、独自に組み立てる必要がない）
- 失敗時・未設定時はURLを付与しない（そもそも投稿が存在しないため）

### Discord成功通知フォーマット

平日朝のBot投稿完了後に送る通知（3通構成・2026-10-27変更）。

**1通目:**

```text
✅ にゃんバーサリーBot
✅ Bluesky投稿完了 {dateStr} {blueskyPostUrl}   ← Bluesky失敗時は ❌ Bluesky投稿失敗: {エラー}（URLなし）
✅ Mastodon投稿完了 {mastodonPostUrl}           ← 設定済みの場合。失敗時は ❌ Mastodon投稿失敗: {エラー}（URLなし）。未設定時は ⏭️ Mastodon未設定・スキップ
🛍️ セールリプライ: Bluesky✅ / Mastodon✅       ← セール期間中のみ
🎲 フォーマット: short/full       ← pickPostFormat()の選択結果（2026-10追加）
📅 テーマ: {theme}
📝 説明: {description}           ← descriptionがある場合のみ
🎨 視覚ヒント: {visualHint}      ← visualHintがある場合のみ
💬 一言: {themeHook}             ← themeHookがある場合のみ（2026-10追加）
🐱 毛柄: {persona}               ← personaがある場合のみ
😺 性格: {personality}           ← personalityがある場合のみ（子猫ゲスト時は保護者修飾を含む）
💭 感情: {emotion}               ← emotionがある場合のみ
🤸 ポーズ: {pose}                ← ポーズ指定がある場合のみ（2026-10追加）
🍴 食べ物アクション: {eatingAction} ← eatingActionがある場合のみ
🐾 ゲスト外見: {guest.appearance}   ← ゲスト登場時のみ
🐾 ゲスト性格: {guest.personality}  ← ゲスト登場時のみ
🈁 裏面漢字: {kanjiChar}（採用）    ← 常に表示（無効値は「なし→🐾」）
🖼 ソース: {source}

📋 Geminiプロンプト（採用）:     ← Gemini採用時は「（採用）」付き
{prompt}                         ← promptがある場合のみ。1通に入らない分は2通目へ続く
```

**2通目（Geminiプロンプトの続きがある場合・Pollinationsプロンプトがある場合）:**

```text
📋 にゃんバーサリーBot
（Geminiプロンプトの続き）        ← 1通目に入りきらなかった場合のみ
{プロンプトの続き}

📋 Pollinationsプロンプト:       ← Pollinations採用時は「（採用）」付き
{pollinationsPrompt}             ← pollinationsPromptがある場合のみ
```

**3通目（themeEnあり）:**

```text
📣 にゃんバーサリーBot
📣 Bluesky投稿テキスト（X・Instagram等に転載用）:
{buildPostText()の出力全文}      ← 日本語のみ・ハッシュタグ・URL含む

📣 Mastodon投稿テキスト（二言語・転載用）:
{buildMastodonText()の出力全文}  ← 日英二言語・ハッシュタグ・URL含む
```

**3通目（themeEn未取得）:**

```text
📣 にゃんバーサリーBot
📣 Bluesky投稿テキスト（X・Instagram等に転載用）:
{buildPostText()の出力全文}

⚠️ themeEn未取得のためMastodon投稿テキストはBlueskyと同一（日本語のみ）
```

**設計意図**: 1通目は「結果とテーマ情報、採用プロンプト」、2通目は「プロンプトの残りと、採用されなかった方のプロンプト（手動比較検証用）」、3通目は「X・Instagram等への転載用テキスト一式」と役割を分離した。成否は1通目だけに書き、2〜3通目はプロンプト・転載用テキストの確認と、コピーに専念する。

### Bluesky AT Protocolエンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 認証 | `POST https://bsky.social/xrpc/com.atproto.server.createSession` |
| 画像アップロード | `POST https://bsky.social/xrpc/com.atproto.repo.uploadBlob` |
| 投稿作成 | `POST https://bsky.social/xrpc/com.atproto.repo.createRecord` |

### Mastodon APIエンドポイント

| 用途 | エンドポイント |
| --- | --- |
| 画像アップロード | `POST {MASTODON_INSTANCE_URL}/api/v2/media` |
| 投稿作成 | `POST {MASTODON_INSTANCE_URL}/api/v1/statuses` |

**認証**: `Authorization: Bearer {MASTODON_ACCESS_TOKEN}` ヘッダー

**画像アップロード**: `multipart/form-data`。`file`フィールドに画像、`description`フィールドにaltテキスト（最大1500文字）。

**投稿作成**: `application/x-www-form-urlencoded`。`status`フィールドにテキスト、`media_ids[]`フィールドにmediaId。重複投稿防止のため`Idempotency-Key: {uuid}`ヘッダーを付与。

**タイムアウト（Bluesky）**: 認証・画像アップロード・投稿作成それぞれ`AbortSignal.timeout(10_000)`（各10秒）。

**タイムアウト（Mastodon）**: アップロード・投稿ともに`AbortSignal.timeout(10_000)`（各10秒）。Workerのwall-clock制限内で収めるため30秒から短縮（2026-04）。

**テキスト**: `buildMastodonText()`で生成した**英語優先・日英二言語テキスト**を使用（`pageUrlEn`含む）。Mastodonはハッシュタグを自動認識するためAT Protocol facetsは不要。`themeEn`未取得時は`buildPostText()`（日本語）にフォールバック。

**シークレット設定**:
```bash
wrangler secret put MASTODON_INSTANCE_URL   # 例: https://mstdn.jp（末尾スラッシュなし）
wrangler secret put MASTODON_ACCESS_TOKEN   # Mastodon設定→開発→アプリ→アクセストークン
```
必要スコープ: `write:statuses` + `write:media`

**未設定時の動作**: `MASTODON_INSTANCE_URL` または `MASTODON_ACCESS_TOKEN` が未設定の場合、Mastodon投稿をスキップして`Promise.resolve(null)`を返す。Bluesky単体で動作継続。
