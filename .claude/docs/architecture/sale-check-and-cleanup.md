# アーキテクチャ詳細: SUZURIセール自動検知Cron（`worker/sale-check.js`・2026-08追加）

> `.claude/rules/architecture.md`から移動した（2026-10）。毎セッション自動で読み込まれるファイルを軽くするため、詳細をこのファイルに分けた。本文は移動前のまま。

## SUZURIセール自動検知Cron（`worker/sale-check.js`・2026-08追加）

### 背景

`worker/sale.js`の`_currentSale`は「セール開催をユーザーがClaudeに伝える」→Claude Codeセッションが手動で編集、という運用だった。SUZURIはニュース一覧（<https://suzuri.jp/media/category/news/>）にセール告知記事を掲載するため、これを1日1回自動チェックし、新しいセール記事を検知したらDiscordに通知することで、ユーザーからの都度の指示を待たずに準備を始められるようにした。

### 方針: 自動検知はするが「本番反映は自動化しない」

- セール情報のHTML構造は毎回微妙に異なる（2026-08「ニンニンSALE」は商品カテゴリー別の階層的な割引で、単純な1商品1金額ではなかった）
- このショップが扱う4商品（t-shirt/sticker/can-badge/acrylic-keychain）のうち**どれが対象でどれが対象外か**の判断は、過去に実際にユーザーと相談して決めた経緯がある（例: ステッカーがニンニンSALE対象外だった件）
- 抽出ミスがそのまま本番のセールバナー・Bot投稿に自動反映されるのはリスクが高い

→ **Cronジョブは「候補を検知し、Discordに通知する」までを担当し、`worker/sale.js`の`_currentSale`への反映は引き続き人間（またはレビューするClaude Codeセッション）が行う。**

### Worker側`fetch()`のsuzuri.jp疎通確認（実装前の検証結果）

`.claude/future-ideas.md`に記載していた「suzuri.jpはWAFでWebFetchを403で弾く」は、Claude CodeのWebFetchツールに対する制約であり、Cloudflare Worker自身の`fetch()`が同様にブロックされるかは別問題として未検証だった。実装前にBashの`curl`から`https://suzuri.jp/media/category/news/`へ直接アクセスしたところ200 OKで取得でき、実際のHTML内に`journal_ninnin-sale_202608`（現行セールの記事URL）が一覧の最上部（＝新着順で先頭）に含まれることを確認した。

ただしこれはこのセッションのサンドボックス環境からの疎通確認であり、**Cloudflare Workersのエッジネットワークからの`fetch()`が同様に成功するかは、実際にデプロイしてCronを発火させるまで確定しない**（WAFがCloudflare WorkersのIPレンジを特別扱いしている可能性は理論上残る）。そのため`checkForNewSale()`は取得失敗時にDiscordへ「⚠️ SUZURIセールチェック失敗（ニュース一覧取得エラー）」を通知する設計にしており、初回のCron発火（またはダッシュボードから`event.cron === "0 16 * * *"`に一致する手動Scheduled発火。`"0 16 * * *"`は明示的に一致する値のため投稿を伴わず、`testing.md`のBug#40対応後も引き続き使用可）で疎通の成否がDiscord通知として可視化される。ブロックされていた場合はこの通知が「自動検知不可・手動確認が必要」のシグナルとして機能する。

### Cronトリガー

`wrangler.toml`の`crons`に`"0 16 * * *"`（1:00 JST）を追加。既存の`"0 15 * * *"`（リサーチプール生成）の直後、Bot Cron（`"0 22 * * 1-5"`）とは独立した`scheduled()`invocationとして実行される（同一invocation内で実行されるBot Cronの負荷とは合算されない）。

### 期限切れR2/SUZURIエントリのクリーンアップ（2026-09移設）

`cleanupExpiredEntries(env, ctx)`（`worker/index.js`）を`checkForNewSale()`と同じ`"0 16 * * *"`分岐に`ctx.waitUntil()`として同居させている。当初はBot Cron（`"0 22 * * 1-5"`）の一部として、`runBot()`の直前に逐次実行していた。

**移設した理由（2026-09・実障害）**: cleanupは期限切れ1件につき「R2メタ取得(1) → SUZURI API DELETE(materialId数分) → R2オブジェクト削除(1)」を行う。Cloudflare Workersの「サブリクエスト」はfetch()だけでなくR2/KV等のバインディング呼び出しも含めてカウントされ、削除件数が多い日（実測141件）は最低でも282件以上のサブリクエストが発生する計算になる。これが`runBot()`の`handleGenerate()`（Gemini1本+Pollinations4本の計5本を同時fetch）と同一Cron・同一event・同一サブリクエスト予算を共有していたため、cleanupの逐次実行（1件ずつawait）で長時間・大量の外部通信を終えた直後に`generate()`が開始する構造になっており、実際にGeminiとPollinations両方が同時にタイムアウトする障害（`[generate] ALL SOURCES FAILED`）が発生した。

**検討した代替案とその却下理由**:

- 同一Cron内でcleanupと`runBot()`を別々の`ctx.waitUntil()`に分離する案 → サブリクエスト予算はevent単位で共有されるため根本解決にならない。さらに並行実行にすると「cleanup 1本+generate() 5本＝同時6本」でCloudflareの同時接続数上限（6）にちょうど当たる新たなリスクを生むため却下
- `"0 15 * * *"`（リサーチプール生成Cron）へ移設する案 → 月末は同じCron内で`runMonthlyWallpaperPost()`（Satori/resvg/PhotonによるCPU予算が極めて逼迫する処理、過去に`error 1102`を繰り返し発生させた経緯あり。詳細は「月替わり壁紙プレゼント機能」参照）が動くため、月末に限ってcleanupが同じ問題を再発させるリスクがあり却下

`"0 16 * * *"`は`checkForNewSale()`が大半の日はKV比較のみで即returnする軽量な設計のため、cleanupと安全に同居できる。移設に伴い、cleanupの実行頻度が実質的に改善する副次効果もある（従来はBot Cronの一部だったため平日のみの実行だったが、`"0 16 * * *"`は毎日発火するため週末に期限切れになったエントリも即日処理される）。

### Tシャツ背面画像マテリアルの一括削除（`cleanupOrphanBackTextureMaterials()`・2026-10追加・Bug#42）

Tシャツの`sub_materials`がSUZURI側に作る背面画像マテリアル（「/suzuri-createエンドポイント仕様」参照）は`materialIds`に記録されないため、`cleanupExpiredEntries()`の末尾で別途削除する。

- **方式**: `GET /api/v1/materials`で自アカウントの素材一覧を取得し、以下をすべて満たすものを削除する（判定は`worker/suzuri.js`の純粋関数`isOrphanBackTextureMaterial(mat, nowMs)`）
  - `user.name`が`SUZURI_USER_NAME`（`"nyanmusu"`）と一致する（一覧APIが他ユーザーの素材を返した場合の誤削除防止）
  - `title`が空（`null`・空文字）
  - `published`が`false`
  - `uploadedAt`から`ORPHAN_BACK_TEXTURE_MIN_AGE_MS`（15日）以上経過している（販売期間14日＋1日の余裕。販売中のTシャツの背面画像を消さないため）
- **採用理由**: `POST /materials`のレスポンスに背面素材のIDが含まれるかは未確認で、レスポンス形式に依存せず、過去の取りこぼしも拾える方式を選んだ（比較した案: レスポンスからIDを取得して`materialIds`に記録する案／メイン素材と作成時刻が近い素材を探す案）。このアカウントでタイトルなし素材を作るのは背面画像のみのため、判定条件での誤削除リスクは低い
- **サブリクエスト上限への配慮（Bug#41）**: 一覧取得は最大`maxPages=2`ページ（1ページ50件・新しい順）、削除は1回あたり最大`maxDeletes=10`件に制限する。定常状態では毎日1件程度の削除になる
- **未検証の前提**: `GET /api/v1/materials`（`user_id`指定なし）が認証ユーザー自身の素材を新しい順に返すことを前提にしている（公式ドキュメントPDFからの抜粋〔`.claude/docs/suzuri-api-unused-features.md`の「`GET /api/v1/materials`」〕に「自分のマテリアル一覧」とある。並び順は未確認。`scripts/audit-suzuri-materials.mjs`も同じ前提）。他ユーザーの素材が返る場合は`user.name`の一致判定で何も削除されず安全側に倒れる。初回Cron発火後に`query-worker-logs.mjs --grep "cleanup-backtexture"`で取得件数・削除件数を確認する
- 失敗（一覧取得・個別削除）は`console.warn`のみで、`cleanupExpiredEntries()`本体（R2/メイン素材の削除）には影響させない

### 処理フロー（`checkForNewSale(env, ctx, notifyFn)`）

1. ニュース一覧を`fetchWithRetry()`で取得。失敗時はDiscordに手動確認要の通知を送って終了（KVは更新しない＝翌日また自然にリトライされる）
2. `extractLatestSaleArticleUrl(html)`（純粋関数）で、一覧中の`/media/journal_*`リンクのうちスラッグに`sale`を含む最初の1件（＝新着順で最初に見つかったセール関連記事）のURLを抽出。見つからなければ通常運用としてログのみで終了
3. KV（`sale-check:last-notified`）に保存済みのURLと比較。**同一なら即return**（Gemini呼び出しを行わない。大半の日はここで終了しCPU時間はごく僅か）
4. 新しい記事の場合のみ、記事本文を取得しGeminiへ構造化抽出を依頼（`responseMimeType: "application/json"`）。対象商品4種それぞれの`included`/`discountYen`をGeminiに判定させる（ステッカー対象外のような過去の判断パターンをプロンプトで委ねる）。**使用モデルは固定文字列で書かず、`worker/index.js`の`selectBestModel()`（export済み）で動的に選択する**（2026-08追加・下記「初回Cron発火で判明した問題」参照）
5. 抽出結果が`isSale: true`の場合、`buildSaleCandidateMessage()`（純粋関数）でDiscord通知文を組み立てて送信。**Discord通知を先に送り、KVへの「通知済みURL」書き込みはその後**（notify→mark-seenの順）。理由: 途中でCPU時間切れ・強制終了が起きても、KVが未更新なら翌日また同じURLで再試行される自己修復的な設計。逆の順序だと「検知したのに誰にも知らされない」まま次回スキップされてしまう
6. `isSale: false`と判定された記事（値上げ告知等、セール以外のニュース）もKVに記録し、翌日以降の無駄な再抽出を防ぐ

### テスト・実装上の注意

- `extractLatestSaleArticleUrl()`・`buildSaleCandidateMessage()`はhandleResearch()と同じ「fetchモック・純粋関数切り出し」パターンでテスト（`scripts/test-bot.mjs`）。`extractLatestSaleArticleUrl()`のテストには実際に取得したニュース一覧HTMLの実データ（記事URLパターン）を使用し、机上の推測パターンでテストしない
- `worker/sale-check.js`は`worker/index.js`から`recordCpuCheckpoint`・`_deferOrAwait`をimportする（既存の循環import許容パターン）。`notifyDiscord`は`worker/bot.js`が持つため、`worker/index.js`の`scheduled()`から関数として注入する形にし、`sale-check.js`が`bot.js`への新規importを持たないようにしている（循環importを増やさない設計判断）
- Gemini抽出フェーズ（記事取得〜構造化抽出）の所要時間は`recordCpuCheckpoint("sale-check-extract", ms, env.RATE_KV)`で計測する。この区間はfetch・KV操作というI/Oを挟むため、`performance.now()`の「I/Oがない同期区間では進まない」制約（自動トリミング機能の計測時に判明・`.claude/archive/revision_log_2026-08.md`参照）には該当せず、ある程度実測可能と見込んでいるが、正確な値になるかは`/cpu-usage`の実測で確認する

### 初回Cron発火で判明した問題（2026-08・修正済み）

デプロイ後の初回Cron発火（`0 16 * * *`）で実際にセール記事（ニンニンSALE）を検知し、Gemini構造化抽出を試みたところ`status=404`で失敗した（Discordに「⚠️ SUZURIセール候補を検知しましたが構造化抽出に失敗しました」の安全な通知が届いた）。`query-worker-logs.mjs`で実ログを確認した結果:

- **フェーズ1（Worker側`fetch()`のsuzuri.jp疎通）は成功と確認できた**（`[sale-check] 新しい記事を検知 url=...`のログが出力されており、ニュース一覧取得〜記事URL抽出〜KV比較までは正常に完走していた）。「suzuri.jpはWAFでWebFetchを403で弾く」という制約はやはりClaude CodeのWebFetchツール固有のものであり、Cloudflare Worker自身の`fetch()`はブロックされないことが実際のCron発火で確定した
- **実際の失敗原因**: 実装時に固定文字列で書いた`gemini-2.5-flash-lite`が「新規ユーザーには提供終了」というエラーで404になっていた（`.claude/archive/revision_log_2026-08.md`参照）。`worker/index.js`には既にこの種のモデル廃止に対応する`selectBestModel()`（Discovery API・スコアリング・KV記憶・切替時Discord通知）が存在していたが、実装時に見落として固定文字列を書いてしまっていた
- **修正**: `selectBestModel()`を`worker/index.js`からexportし、`sale-check.js`の`extractSaleInfoWithGemini()`が固定モデル名の代わりにこれを呼ぶよう変更した。これにより将来同種のモデル廃止が起きても`handleResearch()`と同じ自動フォールバック・Discord通知が働く
- **設計した安全網が実際に機能した点**: KVへの「通知済みURL」書き込みをDiscord通知の後に行う設計（notify→mark-seenの順）だったため、この404失敗時点ではKVは更新されておらず、翌日以降のCronで同じ記事URLに対して自動的に再試行される状態を保っていた
