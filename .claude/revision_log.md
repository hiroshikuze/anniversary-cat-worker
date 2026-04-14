# revision_log.md

セッション開始時にこのファイルを読み、過去のミスパターンを把握してから作業を始める。

---

## ミスパターン記録

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

---

## 記録フォーマット

```text
### YYYY-MM | タイトル
- **状況**: 何をしようとしていたか
- **ミス**: 何を間違えたか
- **教訓**: 次回どう防ぐか
```
