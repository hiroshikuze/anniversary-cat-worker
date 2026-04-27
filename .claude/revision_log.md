# revision_log.md

セッション開始時にこのファイルを読み、過去のミスパターンを把握してから作業を始める。

---

## ミスパターン記録

### 2026-04 | 複数エージェントによる引数順ずれ（createSuzuriProducts）

- **状況**: 別エージェントが`createSuzuriProducts()`に`backTexture`引数を5番目に追加。rebase後、私の呼び出し箇所2か所（`resume-hires`・centerグループ）で`description`が`backTexture`に、`r2Id`が`description`にずれた
- **原因**: リベース後に他エージェントが変更したシグネチャとの整合性を確認しなかった
- **教訓**: 複数エージェントが同じ関数を変更する可能性がある場合、rebase後は必ず該当関数の全呼び出し箇所を`grep`で確認する。引数が多い関数はオブジェクト引数（`{description, r2Id, backTexture}`）に変えて順序依存を排除することも検討する

---

### 2026-03 | ドキュメントの記載ミス（SUZURI API招待制）
- **状況**: 調査不足のままCLAUDE.mdに「SUZURI APIは招待制」と記録した
- **実態**: SUZURIアカウントがあれば即時利用可能だった
- **教訓**: 未確認の情報を断言しない。「〜の可能性がある」「要確認」と明記する

### 2026-03 | 外部APIレスポンスのマッピングに文字列名を使用

- **状況**: SUZURIの`POST /api/v1/materials`レスポンスを`p.item.name`（文字列スラッグ）でMapにし、自前のスラッグキーと照合した
- **ミス**: APIが返す`item.name`（例: `"StandardTshirt"`）が想定スラッグ（`"t-shirt"`）と一致せず、全商品が`available: false`になった
- **教訓**: 外部APIレスポンスをMapにするときは**整数IDをキーにする**。文字列名はAPIバージョン・ロケールで変化するリスクがある。回帰テストを先に書けばリリース前に検出できた

### 2026-03 | 誤った要約（ユーザー機能の有無）
- **状況**: SUZURIグッズ連携の説明で「ユーザーが自分で記念日を選べる→パーソナライズされたグッズ」と説明したが、現状そのような機能は未実装
- **実態**: 記念日は事前に用意された候補から選ぶ形のみ（自由記載は未実装・保留）
- **教訓**: 未実装の将来構想と現在の実装状況を混同しない。「現状」「将来的には」を明確に区別する

### 2026-04 | Cronトリガーがbest-effortで稀に未発火になる（運用知見）

- **状況**: 2026-04-02（木）19:00 JSTにBotが投稿せず、Discordにもエラー通知なし
- **原因**: Cloudflare Workersの公式仕様として「Cron Triggerはbest-effort（保証なし）」。Cronが発火しなかった場合は`runBot()`に到達しないためDiscord通知も出ない。Cloudflareステータスページに障害表示もなく、コードのバグでもない
- **対処**: Cloudflareダッシュボード → コードを編集する → Scheduled → 送信 で手動発火。翌日以降は自動回復
- **教訓**: Cron未発火はコードバグと区別するため、まずCloudflareのトリガーイベント履歴（設定タブ）を確認する。エントリ自体が存在しない場合はインフラ側の問題

### 2026-04 | fal.ai AuraSRアップスケールがタイムアウトし続ける → ctx.waitUntil()で解決

- **状況**: `POST /suzuri-create`でfal.ai AuraSRを同期呼び出しすると毎回タイムアウト。SUZURI登録は元画像で継続されUXが悪化
- **原因1**: fal.aiのバランス残高不足（初期エラー: status=403 "Exhausted balance"）
- **原因2**: Cloudflare WorkersのWall-clock時間制限（約30秒）により同期ハンドラ内では完了できない
- **最終解決**: `ctx.waitUntil()`を使った非同期アーキテクチャに移行
  - t-shirt+stickerグループ: バックグラウンドで処理、即座に`{ queued: true }`を返す
  - can-badge+acrylic-keychainグループ: 従来通り同期処理
  - フロントエンドが`GET /meta/:id`を5秒ごとにポーリングしてSUZURI URL完成を待つ
- **追加修正**: fal.ai CDN URL（`v3b.fal.media`）を直接SUZURIに渡すと0バイトエラー。R2にバイナリ保存→`GET /hires/:id`経由でSUZURIに渡す方式で解決（動作確認済み）
- **教訓**: 同期Workerハンドラ内で外部API（画像処理系）を直列呼び出しする設計はWall-clock制限に引っかかる。`ctx.waitUntil()`はI/O待ちにCPU時間が計上されないため有効。外部CDN URLを第三者APIに直接渡すのも避ける

### 2026-04 | fal.ai Queue API移行（wall-clock超過でcatchも動かない問題の根本解決）

- **状況**: `ctx.waitUntil()`内でfal.run（同期）を呼ぶと、Cloudflare WorkersのWall-clock予算（~28秒）が尽きる前にAbortSignal（30秒）が発火せず、catchブロックも実行されずWorkerが強制終了
- **証拠**: Cloudflareログで`[suzuri-create] bg 開始`は出るが`[fal] AuraSR 完了`も`アップスケール失敗`も出ない
- **原因の構造**: レスポンス送信後のctx.waitUntil()のwall-clock予算は約28秒。fal.ai（fal.run）は30秒タイムアウト設定だが、Workerが28秒で強制終了するためfetchのAbortSignalも発火しない
- **解決**: `fal.run`（同期）→`queue.fal.run`（Queue API）に移行
  - ジョブ投入（<1秒）でrequest_idを取得し、ctx.waitUntil前にR2へ保存
  - ctx.waitUntil()内で5秒×3回ポーリング（計15秒）→ 未完了はbase64フォールバック
  - フロントの60秒ポーリングタイムアウト後、`meta.falRequestId`があれば`GET /resume-hires/:id`を呼ぶ（安全網）
- **教訓**:
  - `ctx.waitUntil()`のwall-clock予算はレスポンス送信後の残り時間（≒28秒）。fal.run 30秒タイムアウトはこれを超える
  - Cloudflareログでcatchブロックのログが出ない＝強制終了（コードのバグではない）
  - Queue APIはジョブIDで後から結果を参照できるため、Wall-clock超過に本質的に強い
  - request_idの保存はctx.waitUntil()より前に行うことで「IDだけでも確実に残る」保証を得る

### 2026-04 | fal.ai → R2 → `/hires/:id` → SUZURI パイプライン動作確認完了

- **状況**: ctx.waitUntil()方式に移行後、Cloudflareログで`[suzuri-create] right グループ完了 slugs=t-shirt,sticker`が確認され、Tシャツ画像が高解像度（AuraSR 4倍アップスケール）でSUZURIに登録されることを本番環境で確認
- **完了確認ログ**:
  - `[suzuri] POST /materials 完了 materialId=... products=[17,147]`（缶バッジ・キーホルダー即時）
  - `[suzuri-create] right グループ完了 slugs=t-shirt,sticker`（バックグラウンド完了）
- **追加修正（同セッション）**:
  - `GET /hires/:id`: `obj.body`→`arrayBuffer()`化＋`Content-Length`ヘッダー追加（SUZURIからのfetchで不明サイズになることを防止）
  - `/suzuri-create`バックグラウンドタスク: 詳細ログ追加（開始・CDN status・byteLength・texture type）
  - CDN fetch結果0バイト時のbase64フォールバックガード追加
- **教訓**: `Content-Length`を省くと一部のAPIクライアントがサイズ不明のストリームを正しく処理できないことがある。R2 objectのbodyをそのまま返す場合も`arrayBuffer()`で実体化してヘッダーを明示するのが安全

### 2026-04 | AuraSR 4x PNG がSUZURI 20MB上限を超過（422エラー）

- **状況**: fal.ai AuraSR 4xアップスケール後のPNGをSUZURIに送ると`status=422 画像must be in between 0バイト and 20メガバイト`
- **原因**: 1024px入力→4096px PNG は~24MBになりSUZURIの20MB上限を超過する
- **修正**: CDNから取得したbyteLengthが20MB超の場合はR2保存をスキップしてbase64フォールバックへ（`buf.byteLength <= 20_000_000`チェックを追加）
- **場所**: `worker/index.js` `/suzuri-create`バックグラウンドタスクと`/resume-hires`の両方

### 2026-04 | fal.aiモデル実測比較（400px入力・scripts/test-fal-models.mjs）

- **目的**: AuraSR 4xが20MB超過するため、代替モデル・パラメータを調査
- **実測結果**（入力: 400px JPEG → 出力推定1024px入力時を括弧内に記載）:

| モデル | 出力解像度 | ファイルサイズ | 1024px入力推定 | 速度 |
| --- | --- | --- | --- | --- |
| AuraSR 4x | 1600px（4x） | 3.74 MB | ~24 MB ❌ | 3.2秒 |
| AuraSR `upscaling_factor=2` | 1600px（**4x**） | 3.74 MB | ~24 MB ❌ | 3.2秒 |
| ESRGAN | 800px（2x） | 0.99 MB | **~6 MB ✅** | **3.2秒** |
| Clarity Upscaler | 800px（2x） | 1.01 MB | ~6 MB ✅ | 9.6秒（遅い） |

- **確定事項**:
  - `upscaling_factor: 2`は**完全に無視**される。AuraSRは4x固定モデル
  - ESRGANはデフォルト2x（800px出力）・AuraSRと同速度・ファイルサイズ1/4
  - Clarityは2xだが約3倍遅いため不採用候補
  - fal.aiはURL直接指定だとWikipedia等の画像を取得できない（Bot制限）→base64 data URI形式で送る必要あり（本番も同方式）
- **決定**: ESRGANに切り替え実施（`worker/fal.js` の `FAL_QUEUE_BASE` を `fal-ai/esrgan` に変更）
  - AuraSRはほぼ毎回20MB超→base64フォールバックになるため実質アップスケールなし
  - ESRGANは2048px/6MBで安定してSUZURIに高解像度登録できる
  - 目標は「4x厳密」ではなく「Tシャツ印刷品質の向上」のためESRGAN 2xで十分

### 2026-04 | fal.ai運用イベントのDiscord通知追加

- **対応内容**: 以下の4イベントでDiscordに通知するよう実装
  - 403（残高不足）: `fal.js`の`submitFalJob()`内で検出 → `notifyFalDiscord()`
  - ジョブFAILED: `fal.js`の`getFalResult()`内で検出 → `notifyFalDiscord()`
  - ポーリング3回未完了→base64フォールバック: `index.js`の`ctx.waitUntil()`内 → `notifyDiscord()`
  - 出力20MB超→base64フォールバック: `index.js`の`/suzuri-create`と`/resume-hires`両方 → `notifyDiscord()`
- **制約**: 残高$0.5以下の「事前通知」はfal.aiのREST APIが非公開のため未実装。残高0（403）になって初めて通知が届く
- **補完策**: fal.aiダッシュボード（`fal.ai/dashboard/billing`）でメール通知を設定しておくことを推奨

### 2026-04 | Bot投稿内容のDiscord通知・visualHint・Pollinations修正

- **Bot投稿完了通知**: Bluesky投稿成功後にDiscordへ通知を追加
  - テーマ・説明・視覚ヒント・猫の毛柄と性格・画像ソース・プロンプト全文・サイトURL
  - `handleGenerate()`の戻り値に`persona`/`personality`/`prompt`を追加
  - `notifyDiscord()`に`emoji`引数を追加（デフォルト`❌`、成功通知は`✅`）
- **visualHint機能追加**: `handleResearch()`のJSON出力に`visualHint`フィールドを追加
  - Geminiがテーマに合ったイラスト用英語キーワード5〜8語を返す
  - `handleGenerate()`の`"Visual elements to incorporate:"`としてプロンプトに挿入
  - Pollinationsフォールバック時も渡すよう`buildPollinationsUrl()`を更新
- **Pollinationsのvisualhint未反映バグ修正**:
  - **原因**: `buildPollinationsUrl()`に`visualHint`が渡されておらず、Pollinationsが勝った場合にvisualHintが完全に無視されていた
  - **追加修正**: theme/descriptionが全日本語で空になった場合、`visualHint`の先頭語を`subject`として使用
  - **場所**: `worker/index.js` `buildPollinationsUrl()`
- **visualHintの精度について**: Geminiは記念日の視覚的特徴を「知っている」わけではなく、テーマ名から推測・創作する。一般的な記念日は精度高い。固有IPアニメ等は創作が混じる可能性あり。Discord通知でvisualHintを毎日確認できるため運用上は問題ない

### 2026-04 | Cloudflare MCPサーバーのセットアップ試行

- **目的**: ClaudeCodeからCloudflare Workersのログに直接アクセスし、Gemini失敗かPollinationsが速かっただけかを確認したかった
- **設定**: `~/.claude.json`のプロジェクト設定に`@cloudflare/mcp-server-cloudflare`を追加（`claude mcp add`コマンドで追加）
- **結果**: 未完了。このWeb/サンドボックス環境ではブラウザOAuthが使えないため`wrangler login`がタイムアウト
- **解決策（未実施）**: CloudflareダッシュボードでAPIトークンを作成し、`~/.claude.json`の`mcpServers.cloudflare.env.CLOUDFLARE_API_TOKEN`に設定すれば使える
- **代替手段**: Cloudflareダッシュボード → Workers & Pages → `anniversary-cat-worker` → ログ で手動確認

### 2026-04 | 実測データなしで実装→ロールバックの繰り返し（Gemini/Pollinations競合設計）

- **状況**: Pollinationsが常に先着する問題の修正で、実測値なしに「5秒遅延→10秒遅延→直列方式」と複数回実装してはロールバックした
- **経緯**:
  1. 5秒遅延を実装 → ログで確認するとPollinationsがまだ勝っていた
  2. 直列方式（Gemini優先→失敗時Pollinations）に変更 → ユーザーから「タイムアウトが原因でレース方式にしたのでは？」と指摘。ロールバック
  3. `scripts/test-gemini-image-timing.mjs`でGemini実測（最小6363ms/最大10203ms/平均8361ms）→ 12秒ウィンドウの2フェーズ方式を実装
- **教訓**:
  - **外部APIの挙動に関わる設計値（タイムアウト・遅延）は必ず実測データから決める**
  - 実測スクリプト（`test-gemini-image-timing.mjs`）を先に書いてユーザーに実行してもらう段取りを踏む
  - 「数値を変えながら試す」ではなく「計測→設計→実装」の順序を守る

### 2026-04 | ドキュメント・テストより先にコードを変更した

- **状況**: eating action 機能の実装で「ドキュメントを更新し、テスト可能なら追加した上でコーディング開始してください」と指示された
- **ミス**: 指示を「要件リスト」として読み、コード変更 → テスト追加 → ドキュメント更新の順で実行した。指示に含まれる**実行順序**を無視した
- **教訓**: 「ドキュメント → テスト → コード」の順序は特別指示がない限り常に守る
  - ドキュメントを先に書くと設計の矛盾が実装前に見つかる
  - テストを先に書くと「何を実装すべきか」の仕様が確定する
  - 実装後にテストを書くとテストが実装に合わせて甘くなるリスクがある
- **防止策**: TodoWrite でタスクを並べる際、必ず「ドキュメント → テスト → コード」の順にする

### 2026-04 | ギャラリーとloadSharedImageの同時実行によるSUZURI重複登録

- **状況**: `?id=bot/YYYY-MM-DD` を開いたとき、同じページに表示されるギャラリーと `loadSharedImage()` が同じidに対して `createSuzuriFromImage()` を同時に呼び出し、SUZURIに同一マテリアルが2件登録されていた
- **ミス**: Worker側の重複防止チェック（R2メタ参照）で防げると考えていたが、両リクエストがほぼ同時にR2を読んだ場合（TOCTOUギャップ）はすり抜けることを見落としていた。ドキュメントにも「重複防止チェックが防ぐ」と誤った記述をしていた
- **教訓**: TOCTOUギャップ（チェックと更新の間に他のリクエストが入る）はCloudflare Workersの分散環境では常に起きうる。フロント側で「同じidに対する同時呼び出し自体を防ぐ」設計で根本回避するのが正しいアプローチ。ドキュメントの「防止できる」という記述も同時に修正する

### 2026-04 | sourceUrlKind の if ブロックが順次実行で上書きされ `vertexaisearch-skipped` が `google-search-fallback` に化ける

- **状況**: プール方式を実装後、30日シミュレーションを実行すると fallback除外率90%・季節補充100%という異常な結果が出た
- **原因**: `handleResearch()`の sourceUrlKind 分類を独立した複数の`if`ブロックで書いたため、上のブロックが`sourceUrlKind = "vertexaisearch-skipped"`と設定した後、下の`if (!result.sourceUrl && queries.length > 0)`ブロックが`sourceUrlKind = "google-search-fallback"`に上書きしていた。`vertexaisearch-skipped`ケースは`result.sourceUrl`を設定していなかったため、次のブロックの条件を満たしてしまった
- **症状**: groundingが存在する`vertexaisearch-skipped`エントリが全件`google-search-fallback`と判定され、フィルタリングで除外されていた。7日シミュレーションで74.3%が誤除外
- **修正**: 独立した`if`ブロック群を`if-else if`チェーンに書き直し、最初にマッチしたケースで処理を終える。`vertexaisearch-skipped`ケースにもGoogle検索URLを`result.sourceUrl`に設定して後続ブロックが発火しないようにした
- **教訓**: sourceUrlKind のような「排他的分類」には必ず`if-else if`チェーンを使う。順次`if`ブロックは「後のブロックが前の結果を上書きする」バグを起こしやすい。シミュレーション（実測スクリプト）を先に実行したことで異常を即検出できた

---

### 2026-04 | 実在の速報ニュースをハルシネーションと誤判断

- **状況**: `scripts/test-gemini-research-batch.mjs`の出力に`2026年三陸沖地震`が含まれており、「架空イベントのハルシネーション」とユーザーに報告した
- **実態**: 前日（2026-04-21）に実際に発生した地震の速報ニュースだった。Geminiが最新ニュースをgroundingして返した正常な動作
- **真の問題**: ハルシネーションではなく「実在するがにゃんバーサリーに不向きな時事災害情報」。現行の`google-search-fallback`フィルタでは除外できない（正規URLでgroundingされるため）
- **対処**: `handleResearch()`プロンプトに「速報ニュース・災害・事故・訃報は除く」を明示追記することで根本対策。プール方式に限らず現行Botにも即時適用が必要
- **教訓**: AIの出力が「おかしい」と感じたとき、ハルシネーションと即断する前に「最近の実際の出来事でないか」を確認する。特に時事的な名称（年号+地名+事象）は実在の可能性が高い

### 2026-04 | 定義・exportした関数を実際の処理フローで呼び出し忘れ（normalizeKanjiChar）

- **状況**: `normalizeKanjiChar()`をexportし、ドキュメントにも「Workerはnormalizeした後に返す」と記載していたが、`handleResearch()`の`return result`前に呼び出すコードを書いていなかった。Geminiが`kanjiChar: null`を返すとフロントへnullが渡り、Tシャツ背面印刷が生成されなかった
- **ミス**: 「関数を定義してexportした」ことと「実際の処理フローで呼び出した」ことを混同した。ドキュメントに意図を書いたことで実装済みと錯覚した
- **教訓**: exportしただけでは処理に組み込まれない。ドキュメントに「〜でバリデーション後に返す」と書いたら、その行が実際にコードに存在するか必ず確認する。テストで「`handleResearch()`がnullを返さない」ことを先に書いていれば実装忘れをすぐ検出できた

### 2026-04 | サブエージェントが一次ソース未確認のまま確定情報として報告

- **状況**: Wikipedia MediaWiki APIの利用規約・レート制限・レスポンス内容を調査させたところ、サンドボックスからja.wikipedia.orgへのfetchが全件403でブロックされた。エージェントは「公式ドキュメントと複数の信頼できる情報源から」と述べながら、実態は学習データとサードパーティ実装の調査のみで一次ソースを確認できていなかった
- **類似ミス**: 2026-03の「SUZURI API招待制」と同じパターン（未確認情報の断言）
- **教訓**: サブエージェントに外部API調査を依頼した場合、「実際にURLをfetchできたか」「公式ドキュメントのURLを明示できているか」を結果レポートで確認する。「公式ドキュメントを参照した」という記述だけでは不十分。特にサンドボックス環境では外部fetchがブロックされることが多いため、実装前に自分で一次ソースを確認する
- **対処**: architecture.mdの当該調査メモに「情報の一次ソース未確認」と明記した

### 2026-04 | 共有URLの日付バッジが常に「今日」を表示していた

- **状況**: `?id=user/...` 形式の共有URLを翌日以降に開くと、日付バッジが生成日ではなく「今日」を表示し、記念日の内容と矛盾していた
- **原因**: `updateDateDisplay()`が常に`new Date()`（現在時刻）を使っており、`loadSharedImage()`がR2から取得した`data.createdAt`を日付表示に反映していなかった
- **修正**: `updateDateDisplay(date = null)`にオプション引数を追加。`loadSharedImage()`成功時に`updateDateDisplay(new Date(data.createdAt))`を呼ぶ。また`timeZone: "Asia/Tokyo"`を追加しユーザーのブラウザ環境に関わらず常にJSTで表示するよう修正（副次的なタイムゾーンバグも解消）
- **教訓**: R2から日時メタデータを取得する画面では、表示に使う日時も必ずそのメタデータから引く。「今日の日付を表示する」関数を共有ビューでもそのまま流用するのは危険

### 2026-04 | 共有URLのスピナー中も日付バッジを正しく表示すべき

- **状況**: `loadSharedImage()`が`/image/:id`のfetch完了後に日付を更新していたため、スピナー（🎨）表示中は「今日の日付」が見えていた
- **修正方針**:
  - `bot/YYYY-MM-DD` ID: IDから直接日付を取得（`id.slice(4)`）してfetch前に`updateDateDisplay()`を呼ぶ
  - `user/{uuid}` ID: 軽量な`/meta/:id`をバックグラウンドfetchしてcreatedAtを先行取得する（`.then()`チェーン・エラーは無視）
  - `/image/:id`完了時の`updateDateDisplay()`も残す（確定値による最終更新）
- **教訓**: ロード中に「今日の日付」が見えるとユーザーは混乱する。日付のような表示情報は最速で確定できるタイミングで更新する

### 2026-04 | SUZURI `sub_materials.texture` がbase64 data URIを受け付けない

- **状況**: Tシャツ背面に漢字または🐾を印刷するため、`createSuzuriProducts()`の`sub_materials[0].texture`にbase64 data URI（`data:image/jpeg;base64,...`）を渡していた
- **症状**: Tシャツは作成されるが背面は完全に白（printが入らない）。SUZURI APIは200を返すのでエラーが検出できない
- **原因推定**: SUZURIの`sub_materials.texture`はURLのみ受け付け、base64を渡すと黙って無視する可能性が高い。メインの`texture`フィールドはbase64対応を確認済みだが、`sub_materials.texture`の仕様は公式ドキュメント（PDFを直接確認済み）に明示されていなかった
- **修正**: `/suzuri-create`ハンドラで、backTextureをR2に`${r2Id}/back.jpg`としてアップロードし、`${workerOrigin}/back/${r2Id}`というWorker URLをSUZURIに渡す。Worker URLはSUZURIから安定してアクセスできる（`/hires/:id`で動作確認済みの方式と同一）。`r2Id`がない場合はbase64フォールバック（現状維持）
- **教訓**: 第三者APIの`texture`フィールドにbase64が使える場合でも、ネストした`sub_materials.texture`では非対応の可能性がある。エラーが返らないAPIでのデバッグは「成功しているのに結果が反映されない」パターンになる。URLが使える場合は常にURLを優先する

### 2026-04 | フロントエンドDOMに依存する関数はunit testが書けない

- **状況**: `resetToInitial()`・`updateDateDisplay()`はDOM APIに依存しているため、`test-bot.mjs`（Node.js環境）ではテストが書けなかった
- **制約**: 現行テストは`jsdom`等を使わずNode.js標準で動く設計。DOM依存コードのテストには`jsdom`の導入が必要だが、軽微な修正に対してオーバーエンジニアリングになる
- **対応**: 純粋な計算ロジックのみ切り出してテスト対象にする方針（`_calcWatermarkLayout()`の先例と同じ）。DOM操作部分はCI上でテストできない旨をコメントしない（コードの自己説明で十分）
- **教訓**: 新たなフロントエンド関数を実装する際、「テスト可能な純粋計算部分」と「DOM操作部分」を意識して分離する設計にすると後でテストが書きやすくなる

### 2026-04 | ユーザー承認前にコードを実装した

- **状況**: 「説明の時のみ日本語にしてください」という指示を「フォーマット指示」として解釈し、日本語で説明した直後に実装まで進めた
- **ミス**: 指示の本意は「日本語で説明し、ユーザーがOKを出してから英語で実装する」という承認フロー要件だった。ユーザーから「まだ私は確認してません」と指摘を受け、`git revert HEAD --no-edit && git push`でロールバックした
- **教訓**: 「実装前に確認を取る」という指示が文中に含意されている場合、明示的な承認（「お願いします」「OKです」等）があるまで実装に着手しない。特に「日本語で説明 → 承認 → 英語で実装」のような2ステップフローは見落としやすい

---

### 2026-04 | Bluesky❤️分析：プロンプト改善の限界とシナリオ生成の必要性

- **背景**: `@nyanmusu.bsky.social`の全投稿（100件）を分析し、❤️数Top10と自動生成Bot投稿を比較した
- **分析結果**:
  - 手動投稿の最高値: **21❤️**（花粉症で運転する猫、スキーリフトで子猫に指導等）
  - Botの最高値: **4❤️**（2026年にゃんバーサリー自動投稿）
  - **5倍以上のエンゲージメント差**が存在する
- **高❤️投稿の共通パターン**:
  - 猫が「動作の途中」にいる（くしゃみ中・キャッチ挑戦中・リフトに乗りながら）
  - 猫が人間的なシチュエーションに完全参加している
  - テーマとの「ナラティブ」がある（テーマの横にいるだけでなく、テーマの中に猫がいる）
- **試みた改善（A・B）と結果**:
  - A（mid-action指示追加）・B（visualHintを場面描写に変更）をGeminiで実際に試した
  - ユーザー評価: 「生成結果にそう大した差がないように思えた」→ どちらも不採用
- **根本原因**: プロンプトレベルの調整では埋まらない差。`handleResearch()`が「テーマ名・説明・物リスト」を返す限り、Geminiは「テーマの横にいる猫」を生成しやすい。真のレバレッジは`handleResearch()`の段階で**猫が体験するシナリオ（"cat experiencing the theme"）**を生成させることにある
- **実装済み変更**: visualHintの指示文を「Setting and surrounding atmosphere; the cat may naturally interact with theme-related items (approaching, touching, or holding them as fits the scene):」に変更（Bug#15の反省を踏まえつつ自然な関わりを許可）。これはパン泥棒の日など「持つことが自然なテーマ」への対応として有効
- **今後の課題**: `handleResearch()`にシナリオフィールド（"scene concept"）を追加し、Geminiが「猫が体験する場面」を生成する方向性。設計変更が大きいため別セッションで検討

---

```text
### YYYY-MM | タイトル
- **状況**: 何をしようとしていたか
- **ミス**: 何を間違えたか
- **教訓**: 次回どう防ぐか
```
