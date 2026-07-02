# revision_log.md

セッション開始時にこのファイルを読み、過去のミスパターンを把握してから作業を始める。

---

## ミスパターン記録

[2026-03のミスパターン](revision_log_2026-03.md)も参照すること

### 2026-04 | 複数エージェントによる引数順ずれ（createSuzuriProducts）

- **状況**: 別エージェントが`createSuzuriProducts()`に`backTexture`引数を5番目に追加。rebase後、私の呼び出し箇所2か所（`resume-hires`・centerグループ）で`description`が`backTexture`に、`r2Id`が`description`にずれた
- **原因**: リベース後に他エージェントが変更したシグネチャとの整合性を確認しなかった
- **教訓**: 複数エージェントが同じ関数を変更する可能性がある場合、rebase後は必ず該当関数の全呼び出し箇所を`grep`で確認する。引数が多い関数はオブジェクト引数（`{description, r2Id, backTexture}`）に変えて順序依存を排除することも検討する

---

### 2026-04 | Cronトリガーがbest-effortで稀に未発火になる（運用知見）

- **状況**: 2026-04-02（木）19:00 JSTにBotが投稿せず、Discordにもエラー通知なし
- **原因**: Cloudflare Workersの公式仕様として「Cron Triggerはbest-effort（保証なし）」。Cronが発火しなかった場合は`runBot()`に到達しないためDiscord通知も出ない。Cloudflareステータスページに障害表示もなく、コードのバグでもない
- **対処**: Cloudflareダッシュボード → コードを編集する → Scheduled → 送信で手動発火。翌日以降は自動回復
- **教訓**: Cron未発火はコードバグと区別するため、まずCloudflareのトリガーイベント履歴（設定タブ）を確認する。エントリ自体が存在しない場合はインフラ側の問題

### 2026-04 | fal.ai AuraSRアップスケールがタイムアウトし続ける → ctx.waitUntil()で解決

- **状況**: `POST /suzuri-create`でfal.ai AuraSRを同期呼び出しすると毎回タイムアウト。SUZURI登録は元画像で継続されUXが悪化
- **原因1**: fal.aiのバランス残高不足（初期エラー: status=403 "Exhausted balance"）
- **原因2**: Cloudflare WorkersのWall-clock時間制限（約30秒）により同期ハンドラー内では完了できない
- **最終解決**: `ctx.waitUntil()`を使った非同期アーキテクチャに移行
  - t-shirt+stickerグループ: バックグラウンドで処理、即座に`{ queued: true }`を返す
  - can-badge+acrylic-keychainグループ: 従来通り同期処理
  - フロントエンドが`GET /meta/:id`を5秒ごとにポーリングしてSUZURI URL完成を待つ
- **追加修正**: fal.ai CDN URL（`v3b.fal.media`）を直接SUZURIに渡すと0バイトエラー。R2にバイナリ保存→`GET /hires/:id`経由でSUZURIに渡す方式で解決（動作確認済み）
- **教訓**: 同期Workerハンドラー内で外部API（画像処理系）を直列呼び出しする設計はWall-clock制限に引っかかる。`ctx.waitUntil()`はI/O待ちにCPU時間が計上されないため有効。外部CDN URLを第三者APIに直接渡すのも避ける

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
- **原因**: 1024px入力→4096px PNGは~24MBになりSUZURIの20MB上限を超過する
- **修正**: CDNから取得したbyteLengthが20MB超の場合はR2保存をスキップしてbase64フォールバックへ（`buf.byteLength <= 20_000_000`チェックを追加）
- **場所**: `worker/index.js` `/suzuri-create`バックグラウンドタスクと`/resume-hires`の両方

### 2026-04 | fal.aiモデル実測比較（400px入力・scripts/test-fal-models.mjs）

- **目的**: AuraSR 4xが20MB超過するため、代替モデル・パラメーターを調査
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
- **制約**: 残高$0.5以下の「事前通知」はfal.aiのREST APIが非公開のため未実装。残高0（403）になってはじめて通知が届く
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
- **代替手段**: Cloudflareダッシュボード → Workers & Pages → `anniversary-cat-worker` → ログで手動確認

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


### 2026-04 | ギャラリーとloadSharedImageの同時実行によるSUZURI重複登録

- **状況**: `?id=bot/YYYY-MM-DD` を開いたとき、同じページに表示されるギャラリーと `loadSharedImage()` が同じidに対して `createSuzuriFromImage()` を同時に呼び出し、SUZURIに同一マテリアルが2件登録されていた
- **ミス**: Worker側の重複防止チェック（R2メタ参照）で防げると考えていたが、両リクエストがほぼ同時にR2を読んだ場合（TOCTOUギャップ）はすり抜けることを見落としていた。ドキュメントにも「重複防止チェックが防ぐ」と誤った記述をしていた
- **教訓**: TOCTOUギャップ（チェックと更新の間に他のリクエストが入る）はCloudflare Workersの分散環境では常に起きうる。フロント側で「同じidに対する同時呼び出し自体を防ぐ」設計で根本回避するのが正しいアプローチ。ドキュメントの「防止できる」という記述も同時に修正する

### 2026-04 | sourceUrlKind の if ブロックが順次実行で上書きされ `vertexaisearch-skipped` が `google-search-fallback` に化ける

- **状況**: プール方式を実装後、30日シミュレーションを実行するとfallback除外率90%・季節補充100%という異常な結果が出た
- **原因**: `handleResearch()`のsourceUrlKind分類を独立した複数の`if`ブロックで書いたため、上のブロックが`sourceUrlKind = "vertexaisearch-skipped"`と設定した後、下の`if (!result.sourceUrl && queries.length > 0)`ブロックが`sourceUrlKind = "google-search-fallback"`に上書きしていた。`vertexaisearch-skipped`ケースは`result.sourceUrl`を設定していなかったため、次のブロックの条件を満たしてしまった
- **症状**: groundingが存在する`vertexaisearch-skipped`エントリが全件`google-search-fallback`と判定され、フィルタリングで除外されていた。7日シミュレーションで74.3%が誤除外
- **修正**: 独立した`if`ブロック群を`if-else if`チェーンに書き直し、最初にマッチしたケースで処理を終える。`vertexaisearch-skipped`ケースにもGoogle検索URLを`result.sourceUrl`に設定して後続ブロックが発火しないようにした
- **教訓**: sourceUrlKindのような「排他的分類」には必ず`if-else if`チェーンを使う。順次`if`ブロックは「後のブロックが前の結果を上書きする」バグを起こしやすい。シミュレーション（実測スクリプト）を先に実行したことで異常を即検出できた

---

### 2026-04 | 実在の速報ニュースをハルシネーションと誤判断

- **状況**: `scripts/test-gemini-research-batch.mjs`の出力に`2026年三陸沖地震`が含まれており、「架空イベントのハルシネーション」とユーザーに報告した
- **実態**: 前日（2026-04-21）に実際に発生した地震の速報ニュースだった。Geminiが最新ニュースをgroundingして返した正常な動作
- **真の問題**: ハルシネーションではなく「実在するがにゃんバーサリーに不向きな時事災害情報」。現行の`google-search-fallback`フィルターでは除外できない（正規URLでgroundingされるため）
- **対処**: `handleResearch()`プロンプトに「速報ニュース・災害・事故・訃報は除く」を明示追記することで根本対策。プール方式に限らず現行Botにも即時適用が必要
- **教訓**: AIの出力が「おかしい」と感じたとき、ハルシネーションと即断する前に「最近の実際の出来事でないか」を確認する。とくに時事的な名称（年号+地名+事象）は実在の可能性が高い

### 2026-04 | 定義・exportした関数を実際の処理フローで呼び出し忘れ（normalizeKanjiChar）

- **状況**: `normalizeKanjiChar()`をexportし、ドキュメントにも「Workerはnormalizeした後に返す」と記載していたが、`handleResearch()`の`return result`前に呼び出すコードを書いていなかった。Geminiが`kanjiChar: null`を返すとフロントへnullが渡り、Tシャツ背面印刷が生成されなかった
- **ミス**:「関数を定義してexportした」ことと「実際の処理フローで呼び出した」ことを混同した。ドキュメントに意図を書いたことで実装済みと錯覚した
- **教訓**: exportしただけでは処理に組み込まれない。ドキュメントに「〜でバリデーション後に返す」と書いたら、その行が実際にコードに存在するか必ず確認する。テストで「`handleResearch()`がnullを返さない」ことを先に書いていれば実装忘れをすぐ検出できた

### 2026-04 | サブエージェントが一次ソース未確認のまま確定情報として報告

- **状況**: Wikipedia MediaWiki APIの利用規約・レート制限・レスポンス内容を調査させたところ、サンドボックスからja.wikipedia.orgへのfetchが全件403でブロックされた。エージェントは「公式ドキュメントと複数の信頼できる情報源から」と述べながら、実態は学習データとサードパーティ実装の調査のみで一次ソースを確認できていなかった
- **類似ミス**: 2026-03の「SUZURI API招待制」と同じパターン（未確認情報の断言）
- **教訓**: サブエージェントに外部API調査を依頼した場合、「実際にURLをfetchできたか」「公式ドキュメントのURLを明示できているか」を結果レポートで確認する。「公式ドキュメントを参照した」という記述だけでは不十分。とくにサンドボックス環境では外部fetchがブロックされることが多いため、実装前に自分で一次ソースを確認する
- **対処**: architecture.mdの当該調査メモに「情報の一次ソース未確認」と明記した

### 2026-04 | 共有URLの日付バッジが常に「今日」を表示していた

- **状況**: `?id=user/...` 形式の共有URLを翌日以降に開くと、日付バッジが生成日ではなく「今日」を表示し、記念日の内容と矛盾していた
- **原因**: `updateDateDisplay()`が常に`new Date()`（現在時刻）を使っており、`loadSharedImage()`がR2から取得した`data.createdAt`を日付表示に反映していなかった
- **修正**: `updateDateDisplay(date = null)`にオプション引数を追加。`loadSharedImage()`成功時に`updateDateDisplay(new Date(data.createdAt))`を呼ぶ。また`timeZone: "Asia/Tokyo"`を追加しユーザーのブラウザ環境にかかわらず常にJSTで表示するよう修正（副次的なタイムゾーンバグも解消）
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

### 2026-04 | 一部商品のみ登録済みの場合にTシャツ・ステッカーが永遠に作成されない

- **状況**: 通信不良等でTシャツ・ステッカーの登録に失敗し、缶バッジ・アクキーのみ登録済みの状態でリロード
- **症状**: リロード後もTシャツ・ステッカーが表示されない（手動リトライ不可）
- **原因**: `loadSharedImage()`と`loadGallery()`の判定が`products?.length > 0`（1件でも登録済みか）だったため、缶バッジ・アクキーが2件登録された時点で「登録完了」と判断し`createSuzuriFromImage()`を呼ばなくなっていた
- **修正**: 判定を`allSuzuriProductsRegistered(products)`（全4スラッグが揃っているか）に変更。Worker側の重複防止チェックが登録済みスラッグをスキップするため、`createSuzuriFromImage()`を再実行しても二重登録にはならない
- **テスト**: `shouldRegisterGalleryItem`の内部ロジックを新条件に更新。回帰テスト2件（缶バッジ・アクキーのみ登録済み → 登録すべき）と`allSuzuriProductsRegistered`の正常系・境界値4件を追加
- **教訓**: 「登録済みかどうか」の判定は「何か1件でもある」ではなく「期待する全件が揃っている」で判定する。部分的な成功状態を「完了」と誤認するとリトライ不能になる

### 2026-04 | フロントエンドDOMに依存する関数はunit testが書けない

- **状況**: `resetToInitial()`・`updateDateDisplay()`はDOM APIに依存しているため、`test-bot.mjs`（Node.js環境）ではテストが書けなかった
- **制約**: 現行テストは`jsdom`等を使わずNode.js標準で動く設計。DOM依存コードのテストには`jsdom`の導入が必要だが、軽微な修正に対してオーバーエンジニアリングになる
- **対応**: 純粋な計算ロジックのみ切り出してテスト対象にする方針（`_calcWatermarkLayout()`の先例と同じ）。DOM操作部分はCI上でテストできない旨をコメントしない（コードの自己説明で十分）
- **教訓**: 新たなフロントエンド関数を実装する際、「テスト可能な純粋計算部分」と「DOM操作部分」を意識して分離する設計にすると後でテストが書きやすくなる

### 2026-04 | ユーザー承認前にコードを実装した

- **状況**:「説明の時のみ日本語にしてください」という指示を「フォーマット指示」として解釈し、日本語で説明した直後に実装まで進めた
- **ミス**:指示の本意は「日本語で説明し、ユーザーがOKを出してから英語で実装する」という承認フロー要件だった。ユーザーから「まだ私は確認してません」と指摘を受け、`git revert HEAD --no-edit && git push`でロールバックした
- **教訓**:「実装前に確認を取る」という指示が文中に含意されている場合、明示的な承認（「お願いします」「OKです」等）があるまで実装に着手しない。とくに「日本語で説明 → 承認 → 英語で実装」のような2ステップフローは見落としやすい

---

### 2026-04 | ファイル名と実装内容の乖離（bluesky-bot.js → bot.js）

- **状況**: `bluesky-bot.js`にBluesky・Mastodon・Discord通知のすべてを実装したため、ファイル名が内容を表さなくなった
- **修正**: `bot.js`にリネーム。importパスを更新するだけで済むため影響最小
- **教訓**: 機能追加でファイルの責務が変わった場合は早めにリネームまたは分割する。命名が実態と乖離すると次のセッションで混乱を招く

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
  - ユーザー評価:「生成結果にそう大した差がないように思えた」→ どちらも不採用
- **根本原因**: プロンプトレベルの調整では埋まらない差。`handleResearch()`が「テーマ名・説明・物リスト」を返す限り、Geminiは「テーマの横にいる猫」を生成しやすい。真のレバレッジは`handleResearch()`の段階で**猫が体験するシナリオ（"cat experiencing the theme"）**を生成させることにある
- **実装済み変更**: visualHintの指示文を「Setting and surrounding atmosphere; the cat may naturally interact with theme-related items (approaching, touching, or holding them as fits the scene):」に変更（Bug#15の反省を踏まえつつ自然な関わりを許可）。これはパン泥棒の日など「持つことが自然なテーマ」への対応として有効
- **今後の課題**: `handleResearch()`にシナリオフィールド（"scene concept"）を追加し、Geminiが「猫が体験する場面」を生成する方向性。設計変更が大きいため別セッションで検討

### 2026-04 | Bluesky APIにタイムアウト未設定（ユーザーが明示依頼済みにもかかわらず漏れ）

- **状況**: MastodonにタイムアウトをつけるときBlueskyも同様にするよう明示的に依頼されていた。実装後に「入れ忘れがないか確認した」と称したが、実際にはBlueskyの3つのfetch（認証・画像アップロード・投稿）すべてに`AbortSignal.timeout()`が設定されていなかった
- **影響**: BlueskyがハングするとPromise.allSettledが返らず、Discord通知が送信されないままCloudflare wall-clock上限（~30秒）でWorkerが強制終了する
- **修正**: `createBlueskySession`・`uploadBlob`・`createPost`の3関数それぞれに`AbortSignal.timeout(10_000)`を追加
- **教訓**: 「タイムアウトを追加した」という確認は「外部fetchを持つ関数すべてを`grep -n "AbortSignal\|fetch("`でリストアップして照合する」まで行う。特に「MastodonとBluesky両方に追加して」という指示のように複数対象がある場合は、実装後に全対象を機械的に確認する


### 2026-05 | Gemini 2.5のgroundingChunks変化によるプール全件季節補充

- **状況**: リサーチプール生成のDiscord通知で`fallback除外 10件 → 重複除去後 0件 → 季節補充1件追加`が数日連続して発生。Botが毎日「杜若の季節」等の季節補充テーマのみを投稿していた
- **原因**: Gemini 2.5以降、`tools: [{ google_search: {} }]`を使ったリサーチで`groundingChunks`が返らなくなり、`webSearchQueries`のみが返るようになった。旧フィルターは`groundingChunks`のないエントリ（`google-search-fallback`）を全件除外していたため、プールが常に空→季節補充発動
- **修正**: `filterAndDedupePool()`の除外条件を`google-search-fallback`→`none`（`webSearchQueries`すら返らないケース）に緩和。`webSearchQueries`が存在する＝Geminiが検索した証拠として信頼できる
- **Discord通知の表示修正**: `fbCount`（`google-search-fallback`件数）を「fallback除外」と誤表示していたのを、実際に除外される`noneCount`を「none除外」・保持される`gsfCount`を「gsf保持」と分けて表示するよう修正
- **教訓**: モデルのバージョンアップでAPIレスポンス構造が変わることがある。プール生成のDiscord通知を毎日確認し「全件除外」が続いたらフィルター条件を疑う。`google-search-fallback`のようなラベルが将来も同じ意味を持つとは限らない

### 2026-05 | ルール7違反が5セッション以上繰り返された根本原因と構造的対策

- **状況**: /insightsレポートで「Docs→Tests→Codeの違反を5セッション以上にわたりユーザーが指摘」と報告。revision_log.mdに記録しても同じミスが繰り返されていた
- **根本原因**: ルール7に「違反した後どうするか」「テスト省略の判断基準」「フェーズ移行の宣言義務」が書かれておらず、「知っているのに実行できない」状態になっていた
- **構造的対策（今セッションで実装）**:
  1. テスト省略の条件を明示（「ドキュメント・コメントのみ」「定数値の変更（ロジック変更なし）」のみ省略可）
  2. フェーズ移行前の宣言義務を追加（`[Docs完了] → Testsフェーズへ移ります`等）
  3. 違反検知時の回復手順を追加（停止→TodoWrite追記→不足分完了→再開）
- **教訓**: revision_logへの記録だけでは「注意するようになる」だけで構造は変わらない。ルール違反が繰り返される場合は「なぜ違反できるのか」（制度の抜け穴）を探してルール文言で塞ぐ

### 2026-05 | CLAUDE.mdのファイル構成ツリーが古くなりarchitecture.mdと乖離

- **状況**: CLAUDE.mdのファイル構成ツリーにtest-suzuri.mjs・test-gemini-research-batch.mjs・test-pool-30days.mjs（3ファイル）が欠落していた。architecture.mdとの2重管理で片方だけが更新されていた
- **原因**: ファイル追加のたびにCLAUDE.mdとarchitecture.mdの両方を更新するルールがなかった
- **修正**: CLAUDE.mdのツリーを削除し「architecture.md参照」1行に統一（Single Source of Truth）。必要なシークレット一覧も同様にgit-workflow.mdに統一
- **教訓**: 同一情報を複数ファイルに持つと必ず一方が古くなる。ファイル構成・シークレット一覧のような「増減する情報」は権威的なソースを1箇所に決め、他は参照のみにする

### 2026-04 | Docs→Tests→Code順序を再び違反（Umami計測追加）

- **状況**: SUZURIボタンへのUmamiクリック計測を実装した
- **ミス**: ドキュメント・テストを追加せずにコードを先に変更した。ユーザーから指摘されて初めて気づいた
- **経緯**: 「シンプルな属性追加だから」という判断でプロセスを省略した
- **教訓**: 変更の大小に関わらず「Docs → Tests → Code」の順序は常に守る。テスト不要（DOM依存）の場合でも、その旨を先に説明してからコードに着手する

---

### 2026-05 | update_pull_request_branch のマージが意図しない削除を引き起こした（PR #121）

- **状況**: PR #121（UmamiでSUZURIクリック計測）を`update_pull_request_branch`でmainにリベース後マージした。その後の差分確認で`frontend/index.html`の英語機能（`?lang=en`、`themeEn`/`descriptionEn`、`MONTH_NAMES_EN`、ギャラリーのUmami計測）が消えていることが発覚
- **技術的根本原因（2層）**:
  1. feature branchが古いmainを起点にしており、mainとfeature branchの両方が同じ関数（`buildGalleryCard()`・`toggleLang()`等）を変更していた
  2. `update_pull_request_branch`のマージ競合解決がfeature branch側の古いコンテンツを優先したため、mainで新規追加した英語機能が黙って削除された
- **プロセス的根本原因**: マージ後に「SHAが異なること」のみを確認してマージを承認した。PRの全差分（削除行を含む）を読まなかった
- **失われた機能**:
  - 英語i18n: `MONTH_NAMES_EN`定数・`themeEn`/`descriptionEn`表示・`?lang=en` URL同期・`toggleLang()`
  - 計測: ギャラリーカードの`data-umami-event="gallery-click"`・`loadSharedImage()`内のUmami page view追跡
- **修正**: `cb735e6`（PR #121適用前のmain）の`frontend/index.html`を復元。ホットフィックスブランチ`claude/hotfix-restore-en-features-yH1La`でマージ
- **再発防止策（今セッション実装）**:
  - CI（`health-check.yml`）にgrep-based フロントエンド機能存在チェック（11項目）を追加。問題のある`frontend/index.html`がpushされると即CIが失敗する
  - 選定基準を`testing.md`に文書化
  - `CLAUDE.md`に「新機能追加時はチェックリストに追加する」ルールを追加
- **教訓**: `update_pull_request_branch`実行後は必ずPRの全差分（削除行を含む）を読み、意図した変更のみか確認する。「SHAが異なる」は必要条件だが十分条件ではない。削除行（`-`行）が意図しない機能の喪失を意味していないか必ず確認する

---

### 2026-05 | かなモードruby HTML露出バグを複数パスで修正（Bug#21・22・23）

- **状況**: かなモード（JP/かな/EN 3択）を実装し、`translations.kana`の全43キーにruby HTMLを設定した
- **ミス（第1パス）**: `applyLang()`はkana時に`innerHTML`を使う対応済みだったが、動的UI更新関数群（`updateDateDisplay`・`showGoods`・`updateResultButtons`・`showToast`・`showWhatsNew`）が`textContent`のままだった（Bug#21）
- **ミス（第2パス・実装確認時に追加発見）**:
  - `startGenerate()`の画像生成後の結果表示が`textContent`+日本語固定で、`themeKana`/`descriptionKana`を参照していなかった（Bug#22）
  - `getRateLimitMessage()`・`err.message`（`t("imageLoadError")`等から生成）を`textContent`でエラー表示していた（Bug#23）
- **教訓**:
  - 翻訳値にHTMLを含む言語を追加するときは`applyLang()`だけでなく**全DOM書き込み箇所を確認する**（`grep -n "textContent = t(" frontend/index.html`）
  - 同じ表示ロジック（テーマ・説明文の表示）が複数箇所にある場合、1か所修正したら残り全箇所を同時確認する
  - `new Error(t("rubyHtmlKey"))`でエラーを投げると`err.message`にruby HTMLが入る。エラーテキスト表示は`setErrText()`経由に統一する
  - **初回修正後に必ず`実装抜けがないか確認`を行うこと**。同一バグクラスの漏れが複数パスで見つかるケースがある
- **保留**: `test-bot.mjs`にtranslations.kana完全性テスト追加（DOMテスト環境なしでは困難・future-ideasに記録済み）

---

### 2026-06 | デプロイCI失敗の`/subdomain`認証エラーは一時的なCloudflare API不調だった

- **状況**: PR #132マージ後の`deploy-worker.yml`が失敗。ログでは`Uploaded anniversary-cat-worker`まで成功していたが、後続の`/accounts/.../workers/scripts/.../subdomain`へのリクエストで`Unable to authenticate request [code: 10001]`が発生していた
- **診断**: 直前の成功run（#127）のログと比較し、スクリプト本体のアップロードは両方成功・差分は`/subdomain`呼び出し（workers.dev URL表示+Cron trigger再適用）のみと特定した
- **対処**: `rerun_failed_jobs`で同コミットを再実行したところ2回目は正常完了し、Cron triggerも再適用された。コード変更は不要だった
- **教訓**: スクリプト本体のアップロードが成功していれば、後続`/subdomain`ステップの`[code: 10001]`は一時的なCloudflare API不調の可能性が高い。過去の成功runログと比較して「どのAPI呼び出しだけが新たに失敗しているか」を特定し、再実行で解消するか確認する。トークン権限の恒久的な問題と判断するのは再実行でも同じエラーが繰り返される場合のみ

---

### 2026-06 | GEMINI_API_KEYを他リポジトリと共用していたためローテーションでBot Cronが失敗

- **状況**: 別リポジトリ案件と本リポジトリでGEMINI_API_KEYを共用していた。別リポジトリの課金が想定より高かったためユーザーが鍵をローテーションしたところ、本リポジトリのCloudflare Workerシークレットが旧キーのまま残り、2026-06-15朝のBot Cronが`画像生成に失敗しました（API key expired. Please renew the API key. / All promises were rejected）`で失敗（Discord通知で検知）
- **原因**: 1つのAPIキーを複数リポジトリで共用していたため、一方の都合（コスト懸念によるローテーション）がもう一方（本リポジトリ）に無通知で影響した
- **対処**: 以下の順を案内し、ユーザーが手動で実施・完了済み:
  1. このリポジトリ専用の新しいGEMINI_API_KEYをGoogle AI Studioで発行
  2. `wrangler secret put GEMINI_API_KEY`でCloudflare Workerシークレットを更新（最優先・本番復旧）
  3. GitHub Actionsシークレット`GEMINI_API_KEY`を更新（`health-check.yml`のE2Eで使用）
  4. testing.mdの「Botの手動テスト（本番発火）」でログ・Discord通知を確認
- **教訓**: 外部APIキーは利用するリポジトリ・プロジェクト単位で専用に発行する。共用すると一方の都合（コスト最適化・セキュリティローテーション等）による変更が他方に無通知で波及し、検知がCron実行失敗（Discord通知）まで遅れる

### 2026-06 | フェーズ宣言はしたのに実際はTestsより先にCodeを書いた（季節カラー修正・Bug#26）

- **状況**: Style行の固定文言"light pink and beige tones"を季節カラーに置き換える修正で、「[Docs完了] → Testsフェーズへ移ります」と宣言し、タスク#2（Tests）をin_progressにした直後、test-bot.mjsにテストを1行も書かずに`worker/index.js`の`_buildGeminiPrompt()`切り出し・`getSeasonalStyleTone()`追加・`handleGenerate()`書き換えを先に実装してしまった
- **ミス**: 宣言（フェーズ移行の儀式）を行ったことと、実際の作業順序が一致しているかを確認しなかった。「次にやることはテストだ」と認識していたのに、手が先にコード編集に動いた
- **対処**: 気づいた時点で追加のコード変更を止め、すでに書いたコードに対するテストをtest-bot.mjsに追加してnpm testで検証（520件成功）。コードへの巻き戻しはせず「テストが実装を裏付ける」形で収束させた
- **教訓**: フェーズ宣言（`[Docs完了] → Testsフェーズへ移ります`）はそれ自体が目的ではなく、宣言した直後の次のツール呼び出しが実際にテストファイルへの編集であるかを毎回自己チェックする。2026-05に「ルール文言を整備した」が、文言があっても実行時に守れているかの自己監視が別途必要（ルール7はすでに5セッション以上違反履歴あり・本件で再発）

---

### 2026-06 | ユーザーの意図ではなく実装しやすい解釈に問題をずらした（テキストモデルコスト削減）

- **状況**: ユーザーから「gemini-2.5-flashに切り替えて、廃止されたら次を自動選択・記憶・Discord通知してほしい」という依頼を受けた
- **ミス**: 「gemini-2.5-flash」が画像生成モデルの話か、テキスト生成モデルの話かを判断する際、「テキスト側（`selectBestModel()`）にはすでに優れた自動選択機構がある」という理由で画像側の話と断定し実装した。しかし実際にはユーザーのコスト文脈（`selectBestModel()`が`gemini-3.5-flash`を選んでいることへの問題意識）を無視して、技術的に実装しやすいほうへ問題をずらしていた
- **根本原因**: コードの技術構造（画像側=静的リスト、テキスト側=動的選択）を起点に判断し、ユーザーの発言と意図（コスト削減・テキストモデルの固定回避）を二次的に扱った。「すでに優れた仕組みがある」という言葉が、実際には「実装したくない」という自分の都合の言い換えになっていた
- **教訓**: 「既存の仕組みで対応できる」と判断する前に、「それはユーザーが困っている問題を実際に解決しているか」を確認する。技術的な理由でスコープを変える場合は、その変更をユーザーに明示して合意を得る。ユーザーが「コスト削減したい」と言ったときは、実際のコスト（選ばれているモデルの料金）まで調べてから判断する

---

### 2026-07 | Gemini APIモデル料金スナップショット（2026-07-01確認・次回調査効率化用）

- **目的**: テキストモデルのコスト最適化作業で調査した公式料金情報を記録する。次回Claudeセッションが再調査せずに判断できるようにする
- **確認方法**: ユーザーが公式ページのmarkdownを直接貼り付け・信頼度高
- **Gemini 2.5ファミリー（2026-07-01時点）**:

| モデル | 入力 | 出力（非思考） | 備考 |
| --- | --- | --- | --- |
| `gemini-2.5-flash-lite` | $0.10/M | $0.40/M | 最安値・Google Search grounding対応 |
| `gemini-2.5-flash` | $0.30/M | $2.50/M | flash-lite廃止時のfallback |
| `gemini-2.5-pro` | $1.25/M | $10.00/M | 状態最先端・リサーチには不要 |

- **gemini-3.5-flash**（PDF確認）: 出力$9.00/M・思考トークン含む。旧スコア式で高スコアになっており「高コストモデルを優先選択」していたのがコスト問題の原因
- **Google Search grounding無料枠**: 500 RPD（flash/flash-lite共有）
- **課金先**: Google AI Studio APIキー → Google Cloud請求書ではなく**Google AI Studioの請求**。Google Cloud Consoleに動きがなくても課金されている可能性がある
- **スコア式（2026-07実装）**: `flash+20 / 非preview+10 / lite+5 / バージョン -= major*3+minor`
  - flash-lite: 24点 / flash: 19点 / 3.5-flash: 16点 / pro: -1点
  - 式の意図:「高度な推論不要・コスト最小化」→ lite最優先、低バージョン優先
- **次回調査が必要なタイミング**: `/usage`エンドポイントのtextTokensが急増した場合・`gemini-2.5-flash-lite`が廃止されてDiscordに切替通知が届いた場合
- **再調査手順**: Cloudflare KV`text-model:active`の値を確認（`/usage`エンドポイントの`textModel`フィールド）→ Google AI Studio料金ページと照合
- **教訓**: スコア式の「高バージョン優先」から「低バージョン優先（低コスト）」への変更理由を必ずdocumentに残す。「高バージョン=高コスト」という逆直感は次回誤った方向に戻される可能性が高い

---

### 2026-07 | `/usage`エンドポイントをClaude Codeから直接取得できなかった設計ミス

- **状況**: 「将来のClaude Codeセッションが`/usage`を直接fetchして確認できる」という前提で設計・ドキュメント化した
- **実態**: Claude Code on the webのサンドボックスはegress proxyで`*.workers.dev`への接続を403ブロックする。curlを実行しても`CONNECT tunnel failed, response 403`（policy denial）が返る
- **確認方法**: `curl -sS "$HTTPS_PROXY/__agentproxy/status"`でproxyの`recentRelayFailures`を確認するとブロックされたホストが記録される
- **回避策**: Claude Code on the webの設定画面（ドメイン許可リスト）に`anniversary-cat-worker.hiroshikuze.workers.dev`を追加すると、**新しいセッションから**アクセス可能になる（既存セッションには反映されない）
- **現時点での代替手段**: ブラウザで直接URLを開く・CIログの末尾（health-check.jsのW3出力）を確認する
- **教訓**: 「Claude Codeセッションから外部Workerへのfetchができるかどうかはサンドボックスのegressポリシー次第」。設計前に実際に試してから「Claude Codeから直接確認できる」とドキュメントに書く。`*.workers.dev`は現状ブロック対象（ユーザーが許可リストを手動追加すれば解除可能）

---

### 2026-07 | CIの`[W1] sourceUrl`チェックがGemini 2.5既知動作でCI失敗

- **状況**: PR #140マージ後のHealth CheckがCIで失敗。`[W1] Worker /research エンドツーエンド`の`✗ sourceUrl あり`が唯一の失敗
- **原因**: Worker `/research`がsourceUrlを返せない場合（Gemini 2.5のgroundingChunks未返却・既知動作）に`check()`（CI失敗）していた。Gemini直接呼び出しのチェック[3]は同じ状況を`warn()`（警告のみ）で扱っており、W1だけ不整合だった
- **修正**: `check("sourceUrl あり", !!data.sourceUrl, ...)`を`if (data.sourceUrl) { check(...) } else { warn(...) }`に変更し、チェック[3]と一致させた。あわせて`res.json()`直呼びも`res.text()+JSON.parse()`に修正（coding.md規約）
- **教訓**: Worker E2EチェックとGemini直接呼び出しチェックの同一項目は同じ寛容度で扱う。既知の非決定的挙動（Gemini 2.5のgrounding返却有無）は`check()`ではなく`warn()`で扱う

---

### 2026-07 | 未検証のトレーニングデータを文化的事実として断言した（半夏生・タコ）

- **状況**: ユーザーから「半夏生のテーマでタコの足が出てきたのはなぜか」と聞かれ、「関西地方（近畿圏）に半夏生にタコを食べる風習がある」と断言した
- **実態**: ユーザーは大阪・京都在住で「聞いたことがない」と指摘。一次ソースを確認せず学習データをそのまま事実として報告した
- **同じパターン**: 2026-03「SUZURI API招待制」・2026-04「Wikipedia調査でfetch403を確認なしに確定情報として報告」と全く同じミス
- **教訓**: coding.mdの「外部API調査の報告ルール」は文化・知識的な事実の報告にも同じく適用される。一次ソースを確認できていない場合は冒頭に明記する。ユーザーの生活体験（大阪・京都在住）は高い信頼性を持つ情報源であり、私のトレーニングデータよりも優先すべき

---

### 2026-07 | visualHintで食材が「主役名詞」になると猫の絵に直接合成されて不気味になる

- **状況**: 半夏生の画像でタコの足が猫に生えている絵が生成された
- **原因**: `handleResearch()`のvisualHint生成指示が「主役となる名詞（動物・物・人物）を1〜2語で先頭に抽出」するため、テーマに食材（タコ等）が関連する場合にそれが主役名詞に選ばれる。Gemini/Pollinationsは「octopus」を画像の中心的な視覚要素として描こうとし、猫と合成される
- **影響範囲**: タコ以外にも「恵方巻き・ちらし寿司・おせち」等の食テーマで同様に発生しうる
- **未対応の理由**: 修正にはvisualHintプロンプトの変更が必要。設計の影響範囲が広いため別セッションで判断
- **次のセッションへの引き継ぎ**: visualHint生成プロンプトに「食材・料理が主役になる場合は背景の小道具として扱い、主役は猫が自然に関われるシーンの構成要素（場所・道具・季節感）を優先する」という制約を追加することを検討する

---

```text
### YYYY-MM | タイトル
- **状況**: 何をしようとしていたか
- **ミス**: 何を間違えたか
- **教訓**: 次回どう防ぐか
```
