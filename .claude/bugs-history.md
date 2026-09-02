# 過去のバグ履歴

## 過去に修正した問題（再発防止）

### 1. Gemini画像生成が404になる（2026-03）

- **原因**: `gemini-2.0-flash-preview-image-generation`が廃止
- **修正**: `KNOWN_CANDIDATES`の先頭を`gemini-2.5-flash-image`に変更
- **場所**: `worker/index.js` L222-228

### 2. sourceUrlがvertexaisearchリダイレクトURLになり404（2026-03）

- **原因**: フィルター条件が`"<vertexaisearch.cloud.google.com>"`と角括弧付きで誤っていた
- **修正**: `!uri.includes("vertexaisearch.cloud.google.com")`に修正
- **場所**: `worker/index.js` L205

### 3. BotがHTTP自己呼び出しでURL設定ミスにより動作しない（2026-03）

- **原因**: `WORKER_URL`環境変数が未設定でURLがundefinedになっていた
- **修正**: `handleResearch()`/`handleGenerate()`を直接関数として呼び出すよう変更
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `scheduled()`

### 4. Cron曜日指定がずれていた（2026-03）

- **原因**: Cloudflare Workersは`1=日曜日`で標準cronと異なる。`1-5`では日〜木になっていた
- **修正**: `0 10 * * 1-5` → `0 10 * * 2-6`（月〜金）
- **場所**: `wrangler.toml` L8

### 5. Bluesky画像アップロードがサイズ超過で失敗（2026-03）

- **原因**: Gemini生成画像（PNG）がBluesky上限1,000,000 bytesを超えることがある（実測 ~1.3MB）
- **修正**: `shrinkImageIfNeeded()`を追加。Photon（WASM）でJPEG圧縮し、それでも超過する場合はPollinationsで512×512を再取得
- **場所**: `worker/bluesky-bot.js` `shrinkImageIfNeeded()` / `ensurePhoton()`

### 6. 記念日の根拠リンクが表示されない（2026-03）

- **原因**: リファクタリング時に`sourceUrl`の表示コードがフロントから消えていた
- **修正**: `<p>`を`<a>`タグに変更し`researchData.sourceUrl`を`href`に設定
- **場所**: `frontend/index.html` L155, L450-458

### 7. SUZURI在庫切れ商品の購入リンクが有効になっていた（2026-03）

- **原因**: 全商品に`<a>`タグを生成していたため、在庫切れでも遷移できた
- **修正**: `GET /api/v1/items`で事前在庫チェック、`available: boolean`を返し、フロントでグレーアウト＋タップ時トースト表示
- **場所**: `worker/suzuri.js` `fetchAvailableItemIds()` / `frontend/index.html` `showGoods()`

### 8. SUZURIの全商品が在庫切れ表示になる（2026-03）

- **原因**: `createdMap`のキーを`p.item?.name`（文字列スラッグ）で作成していたが、SUZURIが返す`item.name`が`SUZURI_ITEM_IDS`のキーと表記が一致しなかった（例: `"StandardTshirt"` vs `"t-shirt"`）
- **修正**: `p.item?.id`（整数）でマップを作成し、`createdMap.get(SUZURI_ITEM_IDS[slug])`で照合するよう変更。文字列の表記ゆれに依存しない
- **再発防止**: `scripts/test-bot.mjs`に`【回帰】item.name表記ゆれ時も全商品available:true`テストを追加
- **場所**: `worker/suzuri.js` `createSuzuriProducts()`

### 9. SUZURIに著作権表示なし画像がアップロードされていた（2026-03）

- **原因**: 画像生成後そのままSUZURI登録していた
- **修正**: `/generate`からSUZURI登録を分離し、フロントCanvas合成（`applyWatermark()`）でウォーターマーク付与後に`POST /suzuri-create`で登録
- **ウォーターマーク仕様**: margin 12px・`© nyanmusu`・半透明黒背景（rgba(0,0,0,0.35)）・白テキスト・JPEG quality 0.92で出力
- **位置**: `position`引数で制御。`'bottom-right'`（右下）または`'bottom-center'`（中央下）。商品グループごとに使い分ける
- **場所**: `frontend/index.html` `applyWatermark(imageData, mimeType, position)` / `_calcWatermarkLayout(imgW, imgH, textW, position)` / `worker/index.js` `/suzuri-create`ハンドラー

### 10. fal.ai AuraSRのCDN画像をbase64変換してWorkers CPU時間超過（2026-04）

- **原因**: `upscaleWithFal()`がfal.ai CDN URLから画像をfetch→ArrayBuffer→base64変換していた。4096×4096 PNG（約4MB）の変換がWorkers CPU時間上限（Paid Bundled: 50ms）を超過
- **修正**: CDNダウンロードを廃止。`upscaleWithFal()`は`{ cdnUrl, mimeType }`を返すだけにし、CDN URLを直接SUZURIの`texture`フィールドに渡す（SUZURI APIはURLを受け付ける）
- **場所**: `worker/fal.js` `upscaleWithFal()` / `worker/index.js` / `worker/bluesky-bot.js`

### 11. fal.ai CDN URLをSUZURIに直接渡すと0バイトエラー（2026-04）

- **原因**: fal.aiが返すCDN URL（`v3b.fal.media`）をSUZURIの`texture`フィールドに直接渡すと、SUZURIのサーバーがfetchした際に0バイトが返りstatus=422エラーになる。CDN URLへのアクセス制限・一時URL等が原因と推測
- **修正**: fal.ai CDN URL → Worker内でfetch → R2にバイナリ保存（I/Oのみ・CPU不要）→ `GET /hires/:id`エンドポイント経由のWorker自身のURLをSUZURIに渡す。Worker URLはSUZURIから安定してアクセスできる
- **教訓**: 外部CDN URLを第三者APIの`texture`等に直接渡す設計は、アクセス制限・TTL・リダイレクト等で失敗するリスクがある。自分で管理するURL（R2経由）に変換してから渡す
- **場所**: `worker/index.js` `/suzuri-create`ハンドラー / `GET /hires/:id`エンドポイント

### 12. AuraSR 4xがSUZURI 20MB上限を常に超過し実質アップスケールなしに（2026-04）

- **原因**: AuraSR 4xは1024px入力→4096px PNG≈24MBとなりSUZURIの20MB上限を超過。`upscaling_factor: 2`パラメーターは**完全に無視**され、常に4x出力になる
- **修正**: `fal-ai/aura-sr` → `fal-ai/esrgan`に切り替え（`worker/fal.js` `FAL_QUEUE_BASE`）。ESRGANは2x（2048px/≈6MB）でSUZURI上限内に収まる
- **モデル比較実測**（400px JPEG入力で計測）:

| モデル | 出力 | 1024px推定 | 速度 |
| --- | --- | --- | --- |
| AuraSR 4x | 1600px | ~24 MB ❌ | 3.2秒 |
| ESRGAN 2x | 800px | **~6 MB ✅** | 3.2秒 |
| Clarity 2x | 800px | ~6 MB ✅ | 9.6秒（遅い） |

- **教訓**: アップスケールの目的は「印刷品質の向上」であり倍率の厳密さではない。SUZURI上限（20MB）を超えるモデルは結局フォールバックになり効果なし。切り替え前にサイズを実測すること
- **場所**: `worker/fal.js` `FAL_QUEUE_BASE`

### 13. fal.ai運用イベントのDiscord通知（2026-04）

- **対応内容**: fal.ai関連の以下イベントでDiscordに通知するよう追加
  - 403エラー（残高不足の可能性）→ チャージURLを含む警告通知
  - ジョブFAILED → requestIdを含む通知
  - ポーリング3回未完了→base64フォールバック → requestIdを含む警告
  - 出力20MB超→base64フォールバック → byteLengthを含む警告
- **実装**: `worker/fal.js`に`notifyFalDiscord()`ヘルパーを追加。`worker/index.js`では`bluesky-bot.js`の`notifyDiscord()`をimportして使用
- **制約**: fal.aiのクレジット残高を事前取得するREST APIエンドポイントが非公開のため、残高が0になった時点（403）でのみ通知。事前通知（$0.5以下等）はfal.aiダッシュボードのメール通知で補完する
- **場所**: `worker/fal.js` `notifyFalDiscord()` / `worker/index.js` ctx.waitUntil()ブロック・`/resume-hires`

### 14. Pollinationsが常に先着し、Gemini画像が使われない（2026-04）

- **原因1（フィルターバグ）**: `listImageModelCandidates()`のフィルター条件が`name.includes("image-generation") || name.includes("imagen") || name.includes("flash-exp")`だったため、`gemini-2.5-flash-image`（末尾が`-image`）が発見されず「discovery found no image models」警告が毎回発生
- **原因2（Discovery APIオーバーヘッド）**: `tryGemini()`冒頭でモデル一覧APIを呼び出していたため、Gemini生成前に1〜2秒の余計なオーバーヘッドが発生
- **原因3（Pollinations高速）**: Pollinationsの`turbo`モデルが約2秒で完了するため、並列レース（`Promise.any`）では常にPollinationsが先着
- **修正**:
  - `listImageModelCandidates()`を廃止し`KNOWN_IMAGE_CANDIDATES`定数に置き換え（Discovery API呼び出しを撤廃）
  - `Promise.any`並列レースから**2フェーズ方式**に変更（上記「Pollinations.aiフォールバック」セクション参照）
- **実測検証**: `scripts/test-gemini-image-timing.mjs`で3回計測し、12秒ウィンドウの設計根拠を確認してから実装（数値先行実装を避けた）
- **場所**: `worker/index.js` `handleGenerate()` / `KNOWN_IMAGE_CANDIDATES` / `buildPollinationsUrl()`

### 15. Geminiプロンプトの「holding or surrounded」制約がvisualHintと競合（2026-04）

- **原因**: `visualHint`（例: `lotus flower, baby Buddha statue, sweet tea ceremony`）が場面・小道具をすでに指定しているにもかかわらず、「The cat is holding or surrounded by items related to the theme.」という空間的制約が残っていた
- **問題**: Geminiが「猫がお釈迦様の像を抱えている」等の不自然な構図に引き寄せられ、visualHintが意図する雰囲気・背景としての使い方ができなかった
- **修正**: 該当文を削除。visualHintによる場面指示に一本化し、Geminiの構図判断を尊重する
- **場所**: `worker/index.js` `handleGenerate()` `prompt`定数

### 16. ボット経由のTシャツが1024px低解像度のままSUZURI登録されていた（2026-04）

- **原因**: `runBot()`が直接`createSuzuriProducts()`を呼んでいたため、ブラウザ側の`resizeForSuzuri()`（2048px bicubic）もfal.ai ESRGAN 2xも適用されていなかった
- **修正**: ボットでのSUZURI登録を廃止。初回訪問者のブラウザで`createSuzuriFromImage()`（手動生成と同じフロー）を実行する設計に変更
- **重複防止**: `/suzuri-create`冒頭にR2メタチェックを追加。対象スラッグが全件登録済みなら既存データを返してスキップ（複数ユーザー同時訪問でも二重登録しない）
- **誰も訪問しない場合**: productsが未作成のままR2が14日で期限切れになる（許容設計）
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `/suzuri-create`ハンドラー / `frontend/index.html` `createSuzuriFromImage()` `loadSharedImage()`

### 17. ギャラリーとloadSharedImageの同時実行によるSUZURI重複登録（2026-04）

- **原因**: `?id=bot/YYYY-MM-DD` を開いたとき、`loadGallery()` のバックグラウンド登録（`registerGalleryItemInBackground()`）と `loadSharedImage()` が同じidに対してほぼ同時に `createSuzuriFromImage()` を呼び出していた。Worker側の重複防止チェック（R2メタ参照）はTOCTOUギャップがあり、両リクエストがR2の `products:[]` を読んだ後に両方とも登録に進んでしまった
- **修正**: `loadGallery()` でURLの `?id` パラメーターと一致するidはバックグラウンド登録をスキップ。`loadSharedImage()` に一本化することで競合を排除
- **場所**: `frontend/index.html` `loadGallery()`（`id !== currentPageId` 条件を追加）
- **テスト**: `scripts/test-bot.mjs` `[shouldRegisterGalleryItem]` セクションで4ケースをカバー

### 18. ボット画像のSUZURI登録でkanjiCharが失われ🐾になる（2026-04）

- **原因**（3箇所の連鎖）:
  1. `bluesky-bot.js`: R2保存時のmetaオブジェクトに`kanjiChar`フィールドが含まれていなかった
  2. `frontend/index.html` `loadSharedImage()`: Blueskyリンク初回訪問者が`createSuzuriFromImage()`を呼ぶ際に`kanjiChar`を渡していなかった
  3. `frontend/index.html` `registerGalleryItemInBackground()`: ギャラリーからのバックグラウンド登録でも同様の漏れがあった
- **症状**: Discordには「🈁 裏面漢字: 塔（採用）」と表示されるのに、実際のSUZURIのTシャツ裏面は🐾になっていた
- **修正**:
  - `bluesky-bot.js`: `meta`オブジェクトに`kanjiChar: research.kanjiChar ?? null`を追加
  - `loadSharedImage()`: `createSuzuriFromImage()`の末尾引数に`data.kanjiChar ?? null`を追加
  - `registerGalleryItemInBackground()`: 同上
- **テスト**: `scripts/test-bot.mjs` `[runBot: R2メタにkanjiCharが保存される]` セクションで2ケースをカバー（有効な漢字・null）
- **場所**: `worker/bluesky-bot.js` L367 / `frontend/index.html` `loadSharedImage()` / `registerGalleryItemInBackground()`

### 19. Gemini API 502平文レスポンスでSyntaxErrorが伝播しBotがクラッシュ（2026-04）

- **症状**: Discord通知が `❌ [bot] エラー: Unexpected token 'e', "error code: 502" is not valid JSON`
- **原因**: `handleResearch()`・`handleGenerate()`内で`await res.json()`を`res.ok`チェックより先に呼ぶため、Gemini/Cloudflareが502を平文テキスト（`"error code: 502"`）で返したとき`res.json()`がSyntaxErrorを投げる。このエラーは`runBot()`のcatchに伝播し、意味不明なメッセージでDiscordに通知される
- **影響範囲**:
  - Bot（`runBot()`→`handleResearch()`直接呼び出し）: クラッシュ
  - ユーザー向け`/generate`（`handleGenerate()`）: 同じバグあり・Geminiが502を返した場合クラッシュ
  - ユーザー向け`/research`: R2プール経由のため影響なし
  - `generateResearchPool()`（0:00 Cron）: `Promise.allSettled()`でラップ済みのため影響なし
- **修正**: `res.text()`で先にボディを取得→`JSON.parse()`でパース→失敗時はステータス付きエラーを投げる
- **副次修正**: `generateResearchPool()`の`notifyDiscord()`呼び出しで絵文字引数を省略していたためDiscord通知の先頭が`❌`になっていた（メッセージ本文の`✅`と矛盾）。`"✅"`を明示渡しに修正
- **テスト**: `scripts/test-bot.mjs`に`handleResearch`・`handleGenerate`の502平文レスポンス回帰テストを追加
- **場所**: `worker/index.js` `handleResearch()` L327 / `handleGenerate()` L623 / `generateResearchPool()` L273
- **横展開の見落とし・追加是正（2026-08）**: `/cpu-usage`の`res.json()`直呼び（`scripts/health-check.js`）をきっかけに全リポジトリを`res.json()`でgrep監査したところ、当時の修正が`worker/index.js`のみに限定され、他の外部API呼び出し箇所には同じ危険パターンが残っていたことが判明した
  - **`worker/fal.js`（本番影響あり・最優先）**: `submitFalJob()`・`getFalResult()`内の3箇所（fal.ai Queue APIへの投入・ステータス確認・結果取得）が`res.ok`チェック後も`res.json()`を直接呼んでおり、fal.ai側が502等を平文で返すとBug#19と同じ構造でクラッシュしうる状態だった（`!res.ok`分岐は`res.text()`で正しく処理されていたのに、成功分岐だけ無防備という非対称な状態）。標準パターンに是正した
  - **`scripts/health-check.js`・`scripts/test-suzuri-api.mjs`・`scripts/test-fal-models.mjs`**: CI・手動実行スクリプト内の計13箇所も同様に是正した。いずれも`testing.md`で「GitHub Actionsのみ・外部API必要」に分類されたE2E専用スクリプトのため、`scripts/test-bot.mjs`への単体テストは追加していない（既存の`checkBlueskyAuth`等と同じ扱い）
  - **対象外とした箇所**: `frontend/index.html`（ブラウザから自Workerを呼ぶコードで文脈が異なるため、今回はユーザー判断で対象外とした）・`worker/r2-storage.js`や`worker/bot.js`/`worker/index.js`のR2オブジェクト`.json()`呼び出し（外部API通信ではなく自ドメインのR2ストレージ読み取りのため対象外）
  - **教訓**: 特定のバグ修正パターンを導入した際、修正箇所と同じリスクを持つ「兄弟コード」（同種の外部API呼び出し）が他のファイルに残っていないか、修正直後にリポジトリ全体をgrepで確認する習慣が必要。今回は約4ヶ月後に別の作業（CPU計測）のついでに偶然発見された

### 20. runBot()がR2リサーチプールを参照せずhandleResearch()を直接呼んでいた（2026-04）

- **原因**: プール方式実装時に`/research`エンドポイントのプール参照ロジックを`runBot()`に反映し忘れた。Botは0:00に生成済みのプールを無視して毎回Geminiをリアルタイム呼び出ししていた
- **影響**: プール方式のハルシネーション低減効果がBotに適用されない。2026-04-24の502障害もプールを参照していれば回避できた
- **修正**: `runBot()`の冒頭でR2プールを参照し、エントリがあれば`handleResearch()`を呼ばずに使用。プール未存在またはエントリなしの場合のみ従来の`handleResearch()`にフォールバック
- **テスト**: `scripts/test-bot.mjs`に「プールあり→プールから取得」「プールなし→handleResearch呼び出し」のテストを追加
- **場所**: `worker/bluesky-bot.js` `runBot()`

### 21. かなモードでruby HTMLがテキストとして表示される（2026-05）

- **原因**: `translations.kana`の値はruby HTMLを含む文字列だが、DOM書き込みを`textContent`で行うと`<ruby>`タグがそのままテキストとして表示される。`applyLang()`は`innerHTML`対応済みだったが、動的UI更新を行う関数群（`updateDateDisplay()`・`showGoods()`・`updateResultButtons()`・`showToast()`・`showWhatsNew()`）が`textContent`のままだった
- **影響**: かなモードで日付ラベル・商品名・ボタンラベル・トースト・更新モーダルにタグ文字列が表示される
- **修正**: 上記全関数で`currentLang === "kana"`のとき`innerHTML`を使うよう分岐を追加
- **場所**: `frontend/index.html` `updateDateDisplay()` / `showGoods()` / `updateResultButtons()` / `showToast()` / `showWhatsNew()`
- **教訓**: 翻訳値にHTMLを含む言語モードを追加した場合、`applyLang()`だけでなく「言語切り替え後に動的にDOMを書き換える全関数」をgrepして`textContent`→`innerHTML`対応漏れを確認する。チェックコマンド: `grep -n "textContent = t(" frontend/index.html`

### 22. startGenerate()が画像生成後の結果表示でkana/en変種を無視していた（2026-05）

- **原因**: 画像生成完了後にテーマ・説明文を表示する箇所（`startGenerate()`）が`textContent`+日本語のみで固定されており、`themeKana`/`descriptionKana`/`themeEn`/`descriptionEn`を参照していなかった。`loadSharedImage()`・`setLang()`は正しく対応済みだったが`startGenerate()`だけ取りこぼされた
- **影響**: かなモードで画像生成ボタンを押すと、結果テーマ・説明文がふりがななしで表示される。英語モードでも英語テキストが表示されない
- **修正**: `loadSharedImage()`と同じ3分岐（en/kana/ja）パターンに統一
- **場所**: `frontend/index.html` `startGenerate()` 結果表示ブロック
- **教訓**: 同じ「テーマ・説明文の表示」ロジックが複数箇所にある場合（`loadSharedImage()`・`setLang()`・`startGenerate()`）、一か所修正したら残り全箇所も同時に確認する

### 23. エラーメッセージのkana対応漏れ（getRateLimitMessage・err.message）（2026-05）

- **原因**: `rateLimitError`・`imageLoadError`・`noImageError`はkana翻訳値にruby HTMLを含む。しかし`getRateLimitMessage()`の戻り値および`err.message`（`t()`から生成されたエラー）を`g-error-text`に`textContent`で設定していたため、ruby HTMLが生テキストとして表示された
- **影響**: かなモードでレート制限・画像読み込み失敗・画像データなしのエラー時にrubyタグが露出する
- **修正**: `setErrText(msg)`ヘルパー関数を新設し、全エラーテキスト設定箇所（5か所）を統一。kana時は`innerHTML`、それ以外は`textContent`を使用
- **場所**: `frontend/index.html` `setErrText()` / `startResearch()` / `startGenerate()` 各catchブロック
- **教訓**: `new Error(t("rubyHtmlKey"))`とすると`err.message`にruby HTMLが入り込む。エラーテキストをUIに表示する際は必ず`setErrText()`経由にする。`textContent = err.message`のような直接代入は禁止パターン

### 24. SUZURIマテリアルが画像1件につき2つ作成され、片方がクリーンアップから漏れて孤立する（2026-06）

- **症状**: ユーザーから「ボットが毎日SUZURI商品を生成しているが、古い商品の削除が一部失敗しているように見える」と報告
- **原因**: `/suzuri-create`はTシャツ/ステッカー（rightグループ・`ctx.waitUntil()`で非同期処理）とキャンバッジ/アクキー（centerグループ・即時処理）を別々に`createSuzuriProducts()`で登録するため、画像1件につきSUZURI側マテリアルが**2つ**作成される。しかしR2の`meta.json`は単数フィールド`materialId`しか持たず、rightグループの非同期処理および`/resume-hires/:id`（安全網エンドポイント）が`updateMetaInR2()`を呼ぶ際に`products`のみを渡して`materialId`を渡し忘れていた。結果としてrightグループのmaterialIdは一度もR2に保存されず、14日後の`scheduled()`クリーンアップはcenterグループのIDしか削除できなかった
- **影響**: 生成された画像すべてについて、Tシャツ/ステッカーのSUZURIマテリアルが永久に孤立し続ける（14日後クリーンアップが対象を認識できない）
- **修正**:
  - R2メタのスキーマを単数`materialId`から配列`materialIds`に変更。`worker/r2-storage.js` `updateMetaInR2()`に`products`と同様のマージ（蓄積・重複排除）ロジックを追加
  - 3つの`createSuzuriProducts()`呼び出し箇所（centerグループ・rightグループ・`/resume-hires/:id`）すべてで`materialIds: [sr.materialId]`を渡すよう統一
  - 旧スキーマ（単数`materialId`）との後方互換のため`collectMaterialIds(meta)`を新設し、`scheduled()`のクリーンアップループで新旧両スキーマを読み出せるようにした
  - 過去分の孤立マテリアルを検出・削除する`scripts/audit-suzuri-materials.mjs`を新設（`GET /api/v1/materials`一覧をdescriptionの期限表記で判定）
- **テスト**: `scripts/test-bot.mjs`に`materialIds`マージ・`collectMaterialIds()`・`parseExpiryDate()`の正常系/境界値/エラー系テストを追加
- **場所**: `worker/r2-storage.js` `updateMetaInR2()` `collectMaterialIds()` / `worker/index.js` `scheduled()` `/suzuri-create` `/resume-hires/:id` / `scripts/audit-suzuri-materials.mjs`
- **教訓**: 1つの論理エンティティ（画像1件）が複数の外部リソース（SUZURIマテリアル）を作成しうる設計では、ID集約フィールドは最初から配列で持つ。単数フィールドの「最後に書き込んだ値だけ残る」という性質は、複数の呼び出し元が非同期・別タイミングで書き込む構成と相性が悪い

### 25. 季節補充フォールバックのvisualHintが花以外の季節要素にも「花びら」を指示し季節と矛盾する画像になる（2026-06）

- **症状**: ユーザーから「6月中旬なのに生成画像に桜の花びらのようなものが舞っていて季節と合わない」と報告。該当画像のテーマは6/16〜6/30の季節補充フォールバック「苔の季節」
- **原因**: `generateResearchPool()`の季節補充ブロック（リサーチプールが3件未満の日に発動）が、`SEASONAL_FLOWERS`の全24エントリに対して`` `${flowerName} flowers, Japanese garden, soft petals, gentle breeze` ``という単一テンプレートで`visualHint`を生成していた。苔は花を咲かせない植物のため「flowers」「soft petals」という指示は実体と矛盾し、Gemini画像生成が代わりに「日本庭園で舞う柔らかい花びら」の中で最も学習データに近い桜の花びらを補完してしまっていた。同根の不一致が紅葉（葉を花扱い）・銀杏（葉を花扱い）・千両（実を花扱い）にも存在
- **影響**: 6月下旬（苔）・11月下旬（紅葉）・12月上旬（銀杏）・12月下旬（千両）にリサーチプールが3件未満になった日、生成画像のビジュアルが季節・実際の植物と矛盾する確率が上がる
- **修正**: `SEASONAL_FLOWERS`の各エントリに実際の見た目を記述したASCII英語`visual`フィールドを追加し、単一テンプレートを廃止。新規`getSeasonalFlowerVisual(dateStr)`で該当エントリの`visual`を取得し、`generateResearchPool()`の補充ブロックで`visualHint`に直接使用する
- **テスト**: `scripts/test-bot.mjs`に`getSeasonalFlowerVisual()`の正常系（境界値）・苔/紅葉/銀杏/千両が「flower」「petal」を含まないことの回帰チェック・全24エントリがASCIIのみであることの検証を追加
- **場所**: `worker/index.js` `SEASONAL_FLOWERS` `getSeasonalFlowerVisual()` `generateResearchPool()`
- **教訓**: 複数バリアントを持つ定数テーブル（季節要素・商品種別等）に対して「全件共通の文言テンプレート」を適用する設計は、テーブルの要素数が増えるほど一部要素の実体と矛盾するリスクが高まる。各要素が本質的に異なる見た目・性質を持ちうる場合は、テンプレートではなく要素ごとのフィールドとして明示的に持たせる

### 26. Gemini生成画像が季節と無関係に桜の花びらを描き込む（2026-06）

- **症状**: ユーザーから「6/26（露天風呂の日）投稿の生成画像に桜の花びららしきものが舞っていて時期として季節と合わない」と報告。当初Bug#25（季節補充フォールバックの`flowers, soft petals`テンプレート）の再発と推測したが、実際のDiscord通知ログを確認した結果、当日のテーマは通常のリサーチプール取得「露天風呂の日」であり`visualHint`にも花・花びら・桜への言及は一切なく、Bug#25とは無関係と判明
- **原因**: `handleGenerate()`が組み立てるGeminiプロンプトのStyle指示が`` `soft pastel colors, light pink and beige tones, gentle watercolor brushstrokes, ... Japanese illustration style` ``という年間共通の固定文言だった。「light pink」「Japanese illustration style」「watercolor」の組み合わせが学習データ上の桜イメージと強く結びついており、テーマ・visualHintに花の言及がない場合でもGeminiモデルが装飾として桜の花びらを補完してしまっていた
- **影響**: 一年を通じて常時発生しうる（季節補充フォールバック発動時のみではない）。桜が季節的に不自然な6月〜2月頃の生成画像で特に目立つ
- **修正**:
  - `SEASONAL_FLOWERS`の24エントリ（既存の`startMd`/`endMd`境界を再利用）に`style`フィールド（ASCII英語の色調記述）を追加。新規`getSeasonalStyleTone(dateStr)`で該当エントリの`style`を取得する
  - `handleGenerate()`のGeminiプロンプト構築を`_buildGeminiPrompt()`として切り出し、固定文言`light pink and beige tones`を`getSeasonalStyleTone(toJSTDateStringWorker(new Date()))`の戻り値に置き換え。季節補充フォールバック限定ではなく**すべてのGemini画像生成**に適用する
  - 実際に桜・梅・蓮等のピンク系の花が咲く時期（梅・彼岸桜・染井吉野・皐月・蓮・百日紅・秋桜）は`style`もピンク系トーンを維持し、季節と合致する桜表現は引き続き可能にする
  - 保険として、Theme/Context/Setting欄に明示されていない桜・花びら・季節装飾を追加しないようGeminiプロンプトにネガティブ指示を追加（`SEASONAL_FLOWERS`春エントリのように`visual`/`style`で明示された場合は除外されない）
- **テスト**: `scripts/test-bot.mjs`に`getSeasonalStyleTone()`の正常系（境界値）・`_buildGeminiPrompt()`の構築ロジック（ネガティブ指示の有無・季節カラー反映）を追加
- **場所**: `worker/index.js` `SEASONAL_FLOWERS` `getSeasonalStyleTone()` `_buildGeminiPrompt()` `handleGenerate()`
- **教訓**: 画像生成プロンプトの装飾的な固定文言（色調・画風指定等）も、特定の単語の組み合わせが学習データ上の強いイメージ連想を引き起こす場合がある。テーマに依存しない見た目の指示であっても、季節性のあるサービスでは年間固定にせず可変にする余地を検討する。また、ユーザー報告の症状が過去バグと類似していても、実際の生成ログ（プロンプト全文）を確認せずに過去バグの再発と決めつけない（前回の誤診断: 本バグをBug#25再発と最初に断定した）

### 27. Gemini生成画像が丸皿（陶器プレート）風にレンダリングされる（2026-07・原因未確定）

- **症状**: ユーザーから「7/13投稿（テーマ: ナイスの日）の生成画像が、水彩画イラストではなく濃い緑背景の上に置かれた白縁の丸皿のように見える。SUZURI連携に悪影響」と報告
- **調査**: 実際のGeminiプロンプト全文（Discord通知ログ）を確認したところ、Theme/Context/Setting（`Nice Day` / `cat, thumbs up, sunny sky, flowers, bright colors, happy, cheerful`）は完全にテーマ通りで、生成された絵の内容（猫+柴犬・晴れた空・花・サムズアップ）とも一致していた。問題は内容ではなく構図・フォーマット（円形の皿状レンダリング）のみ
- **当初の仮説と再評価**: `SEASONAL_FLOWERS`の`07-01`〜`07-15`（蓮）エントリのStyle行`"soft pink and deep green tones, calm pond atmosphere"`が唯一Style行に具体的情景名詞「pond」を含む例外であることを原因と推測したが、ユーザーからの指摘で「Theme/Context/Setting側には蓮・池を連想させる語が一切ない」ことを見落としていたと気づいた。画像の配色（ピンクの花・深緑背景）はStyle行の色指定と一致しており影響自体はあったと考えられるが、「pondという単語が円形皿化の直接原因」と断定する根拠（他エントリでの非発生の確認・A/Bテスト等）はなく、**本バグは原因未確定のまま記録する**
- **対処（原因非依存のDefense-in-depth）**: `_buildGeminiPrompt()`の既存ネガティブ指示文に、物理オブジェクト化・円形フレーム化を明示的に禁止する一文を追加（`Do not render the scene as if painted, printed, or mounted on a plate, dish, fan, tapestry, or any other physical object, and do not add a circular frame, border, or vignette around the subject.`）。原因がpond語であってもなくても、円形/工芸品風レンダリング自体を直接抑止する
- **副次対応**: 蓮エントリのStyle行から「pond」を除去し他23エントリと同じ「色調＋抽象的雰囲気語」パターンに統一（`"soft pink and deep green tones, tranquil summer calm"`）。ただしこれは確定原因の除去ではなく念のための一貫性改善という位置づけ
- **テスト**: `scripts/test-bot.mjs`に`_buildGeminiPrompt()`の新ネガティブ指示文検証・`getSeasonalStyleTone("2026-07-01")`のpond不在/pink維持の回帰テストを追加
- **場所**: `worker/index.js` `SEASONAL_FLOWERS` `_buildGeminiPrompt()`
- **今後の観測ポイント**: 蓮期間（07-01〜07-15）以外の日に同種の丸皿化が再発した場合、pond語は原因ではなく別要因（モデルの確率的挙動・`Japanese illustration style`自体等）と判明する。その場合は本エントリを更新すること
- **教訓**: 1件の観測結果から特定の単語を原因と断定しかけた。傍証（配色の一致）と直接因果（円形皿化の原因）を混同していた。ユーザーに「本当にそれが原因か」と問われて初めて、Theme/Context/Setting側に該当語が存在しないことを確認していなかったと気づいた。外部APIで検証手段がない場合は、原因を断定せず「効果はあるが原因非依存の対策」を優先し、ドキュメントにも確度を明記する

### 28. 外部通信リトライ監査で4つのギャップを発見・修正（2026-07）

- **状況**: ユーザーから「外部への通信箇所すべてにリトライ対策済みか」と質問を受け、`worker/*.js`・`frontend/index.html`の全`fetch()`呼び出しを監査した
- **発見したギャップ**:
  1. `worker/index.js` `/suzuri-create`の`ctx.waitUntil()`内fal.aiポーリングループ（3回×5秒）が、例外発生時に`catch`節で即座に`break`しており、1回の一時的な通信不良で残り試行を放棄し低画質base64フォールバックに落ちていた
  2. `worker/suzuri.js` `createSuzuriProducts()`の`POST /materials`にリトライがなかった
  3. フロントエンド`loadSharedImage()`の`/image/:id`取得（共有URL・ボット投稿の閲覧という主要導線）にリトライがなかった
  4. `worker/index.js` `/proxy-image`ハンドラーにリトライがなかった
- **調査中に判明した前提課題**: ギャップ2の修正テストを`scripts/test-suzuri.mjs`に追加しようとしたところ、同ファイルが`npm test`にも`.github/workflows/health-check.yml`にも接続されておらず**CIで一度も実行されていない**ことが判明。実際に単体実行すると、`createSuzuriProducts()`が`coding.md`規約に従い`res.text()`→`JSON.parse()`で読む実装に変わっていたのに対し、テストのモックが`res.json()`のみを実装しており`res.text is not a function`で例外落ちして**現に失敗する**状態だった。また同テストのモックは`/items`（在庫確認）と`/materials`（登録）の2つのfetch呼び出しを区別せず同一アサーションを適用しており、1件目（`/items`宛）で常にアサーションが失敗していた
- **修正**:
  - `worker/http-utils.js`を新設し、5xxに加えて`fetch()`自体が投げるネットワーク例外（DNS失敗・接続断等）も指数バックオフでリトライする共通`fetchWithRetry()`を実装（`worker/index.js`の旧版は5xxのみ対応だった）。循環import回避のため独立ファイルとした
  - fal.aiポーリングループを`_pollFalAndGetTexture()`として抽出・export（`_twoPhaseRace()`と同じ依存注入パターン）。例外時は`continue`し残り試行を継続するよう修正
  - `worker/suzuri.js`・`/proxy-image`に`fetchWithRetry()`を適用
  - フロントエンド`apiFetch()`を汎用化してGETに対応させ、`loadSharedImage()`の`/image/:id`取得をリトライ対応
  - `scripts/test-suzuri.mjs`のモックを`res.text()`ベースに修復し、`/items`と`/materials`を区別するよう修正した上で`package.json`の`test`スクリプトと`health-check.yml`に接続
- **テスト**: `scripts/test-bot.mjs`に`fetchWithRetry()`・`_pollFalAndGetTexture()`の正常系/境界値/エラー系テストを追加。`scripts/test-suzuri.mjs`に`createSuzuriProducts()`のリトライ回帰テストを追加
- **場所**: `worker/http-utils.js`（新規）・`worker/index.js`・`worker/suzuri.js`・`frontend/index.html`・`scripts/test-suzuri.mjs`・`package.json`・`.github/workflows/health-check.yml`
- **恒久対応**: `.claude/rules/coding.md`に「新規に外部通信を追加する際はリトライ可否を検討する」チェック項目を追加し、今後同種の見落としを構造的に防ぐ
- **教訓**: テストファイルを新設・変更しても、実行コマンド（`npm test`・CIワークフロー）に接続されているかを別途確認しないと「書いたのに一度も実行されていない」状態になりうる。ユニットテストを追加・修正した際は必ず`npm test`を実行して実際に走ることを確認する

### 29. 共有URL閲覧中のエラー再試行が元の画像ではなく新規生成に置き換わる（2026-07・Issue#149）

- **症状**: ユーザー報告（Issue#149）「cronで定期生成されたボット画像ページ（`?id=bot/YYYY-MM-DD`）を閲覧中、読み込み中に通信が不安定になりエラー画面が表示された。再試行したところ、元のボット生成画像ではなくまったく別の新規生成画像に置き換わった」
- **原因**: `frontend/index.html`の`#g-error`（エラー画面）の再試行ボタンが`onclick="startResearch()"`にハードコードされていた。`startResearch()`は常に新規記念日リサーチ→新規画像生成を開始する関数のため、`loadSharedImage(id)`（共有URL・ボット画像の読み込み）が通信不良で失敗して`#g-error`画面に遷移した場合でも、無条件で無関係な新規画像が生成されてしまっていた
- **既存の正しいパターンとの比較**: 同ファイル内の`#g-result`（結果画面）のセカンダリボタンは`updateResultButtons()`が`showGenerate("result")`のたびに`isSharedView`フラグを見て`.onclick`をJSで動的に切り替える設計になっており、エラー画面だけがこのパターンに追随していなかった
- **調査時に確認した非該当箇所**: `#g-waiting`（初期画面）の`startResearch()`固定は正常（まだ何も生成していない状態で保持すべきコンテンツがない）。`#g-expired`（期限切れ画面）の`startResearch()`固定も正常（R2側で14日経過し実データが削除済みのため、新規生成以外に選択肢がない。ボタン文言も「再試行」ではなく「作る」）
- **修正**: `updateResultButtons()`と同じ設計で`updateErrorRetryButton()`を新設し、`showGenerate("error")`時に呼び出す。`isSharedView === true`（共有URL閲覧中のエラー）なら`loadSharedImage(currentSharedId)`を再実行、`false`（通常生成中のエラー）なら従来通り`startResearch()`を実行するよう`.onclick`を動的に設定する。HTML側の`onclick="startResearch()"`固定値は削除
- **テスト**: フロントエンドのDOM依存ロジックのためNode環境でのユニットテスト不可（`testing.md`の既存制約と同じ）。目視確認とする
- **場所**: `frontend/index.html` `showGenerate()` `updateErrorRetryButton()`（新設）
- **教訓**: 「共有URL閲覧中かどうか」で分岐が必要な画面遷移は`#g-result`だけでなく、同じUIコンポーネント（ボタン）を複数の文脈（通常生成・共有URL閲覧）で共有する画面すべてに存在しうる。新しい状態遷移・エラー画面を追加する際は、既存の`isSharedView`分岐パターン（`updateResultButtons()`）を横展開する必要がないか確認する

### 30. Geminiがtheme等のプレーンテキストフィールドにruby HTMLを混入させBluesky投稿が失敗（2026-07）

- **症状**: 深夜のリサーチプール生成Discord通知で、テーマ一覧の1件に`<ruby>劇画<rt>げきが</rt></ruby>の<ruby>日<rt>ひ</rt></ruby>`という生のHTMLタグが表示されているとユーザーから報告。さらに同日7:00 JSTの平日Bot投稿で、このプールエントリが実際に選ばれ`❌ Bluesky投稿失敗: ... grapheme too big (maximum 300, got 325)`が発生。Mastodonは文字数上限（500）に収まったため成功したが、投稿本文には同じ壊れたHTMLタグがそのまま露出していたと推定される。共有URLページ（`?id=bot/2026-07-24`）のテーマ表示・保存画像のファイル名にも同じ破損が伝播していた
- **原因**: `handleResearch()`のGeminiプロンプトは`theme`（プレーンテキスト）と`themeKana`（ruby HTML付き）を明確に指示で分けているが、`result.theme`/`result.description`/`result.themeEn`/`result.descriptionEn`に対するサニタイズ・検証が一切なく、Geminiが誤って`theme`にも`themeKana`と同じruby HTML文字列を返した際にそのまま通過していた。10並列生成のうち1件でこの誤りが発生し、`filterAndDedupePool()`の文字列一致による重複除去も素通りしてプールに保存された
- **影響範囲**: リサーチプール（Discord通知・R2保存）→ 平日Bot投稿（Bluesky/Mastodon本文）→ 共有URLページの表示・保存画像ファイル名まで、`theme`/`description`を利用する全経路に伝播する。とくにBluesky投稿は`worker/bot.js`の設計上リトライしない（二重投稿防止のため）ため、一度失敗するとその日の投稿は失われる
- **修正**:
  - `worker/index.js` `handleResearch()`内でGeminiレスポンスをパースした直後に`theme`/`description`/`themeEn`/`descriptionEn`からHTMLタグを除去する`stripHtmlTags()`を追加・適用（`themeKana`/`descriptionKana`はruby HTMLが仕様上必要なため対象外）。副次効果として、タグ除去後は文字列が一致するようになり`filterAndDedupePool()`の重複除去も正しく機能するようになる
  - 追加の安全網として、`worker/bot.js` `buildPostText()`/`buildMastodonText()`に実行時のgrapheme数チェックを追加。Bluesky（300）/Mastodon（500）の上限を超える場合はheader・URL・CTA・ハッシュタグを保持したままdescription部分のみ切り詰める。根本原因の修正だけでなく、将来別の予期しない原因でtheme/descriptionが長くなった場合にも投稿失敗を防ぐ
- **手動復旧**: 既存のR2保存済みデータ（`bot/2026-07-24/meta.json`等）は今回の修正では自動的に直らない。Cloudflareダッシュボード（またはwrangler CLI）から該当オブジェクトの`theme`フィールドを手動で書き換える必要がある
- **テスト**: `scripts/test-bot.mjs`に`handleResearch()`のHTMLタグ除去（対象4フィールド・themeKana/descriptionKanaは対象外）、`buildPostText()`/`buildMastodonText()`のgrapheme上限安全網（正常系・境界値・上限超過時のheader/URL保持）を追加
- **場所**: `worker/index.js` `handleResearch()`（新規`stripHtmlTags()`）・`worker/bot.js` `buildPostText()` `buildMastodonText()`
- **教訓**: LLMの構造化出力は「プロンプトで指示した通りの形式で返る」ことを前提にせず、各フィールドの型・形式を検証・サニタイズしてから使う。とくに複数フィールドが似た内容（`theme`と`themeKana`のように同じ情報の別表現）を持つ場合、LLMが取り違えて同じ値を別フィールドに複製するリスクがある。また外部SNS APIへの投稿のような「失敗すると機会が失われ取り返せない」操作は、入力値の想定外の長さ・形式に対する実行時の安全網を根本修正とは別に用意しておく

### 31. 季節補充フォールバックにthemeKana/descriptionKana/themeEn/descriptionEnが欠落しかなモード・英語モードで日本語にフォールバックする（2026-07）

- **症状**: ユーザー報告「かなモード設定中のスクリーンショットで、桔梗の季節（7/16〜7/31・季節補充フォールバック発動日）にふりがなが付かなかった」
- **原因**: `generateResearchPool()`の季節補充ブロック（当日のリサーチプールが3件未満のときに発動。`worker/index.js` 373〜389行目）が生成するフォールバックエントリのオブジェクトリテラルは、Geminiを一切呼ばず`theme`/`description`のみを直接組み立てており、`themeKana`/`descriptionKana`（かなモード用ruby HTML）と`themeEn`/`descriptionEn`（英語モード用）が最初から存在しなかった。通常のGemini生成エントリはこれら6フィールドすべてを含むため、季節補充フォールバックの日だけ`themeKana`等が`undefined`になり、フロントエンドの「既存データにthemeKanaがない場合は日本語にフォールバック」という既存の後方互換ロジックが働いて、ふりがな・英語表示なしの日本語表示になっていた
- **影響範囲**: かなモード（`?lang=kana`）と英語モード（`?lang=en`）の両方。季節補充フォールバックは通常10%の確率でのみ選ばれる低頻度の分岐だが、リサーチプールが3件未満になる日（Gemini検索結果が乏しい日）には必ず発動する
- **修正**: `SEASONAL_FLOWERS`配列の既存24エントリ（`visual`/`style`と同じ人手管理パターン）に、花の名前のふりがな用`kana`フィールド（ruby HTML、例: 桔梗→`<ruby>桔梗<rt>ききょう</rt></ruby>`）と英語名`en`フィールド（例: `Balloon Flower`）を追加。新規`getSeasonalFlowerKana(dateStr)`/`getSeasonalFlowerEn(dateStr)`を`getSeasonalFlowerVisual()`と同じパターンで新設し、`generateResearchPool()`の季節補充フォールバックで`theme`/`description`の固定テンプレート部分（「の季節」「今の季節を彩る」）のふりがなと組み合わせて`themeKana`/`descriptionKana`/`themeEn`/`descriptionEn`を組み立てる。GeminiのAPI呼び出しは追加しない（実行時コストゼロ・24種類の固定パターンのため事前に人手で用意可能）
- **テスト**: `scripts/test-bot.mjs`に`getSeasonalFlowerKana()`/`getSeasonalFlowerEn()`の全24エントリ検証（kanaはruby HTML形式・enはASCIIのみ）を追加。`generateResearchPool()`自体は非exportのため既存の`getSeasonalFlowerVisual()`等と同じ方針でgetter関数単位のテストに留める
- **場所**: `worker/index.js` `SEASONAL_FLOWERS` `getSeasonalFlowerKana()`（新設） `getSeasonalFlowerEn()`（新設） `generateResearchPool()`
- **教訓**: 通常経路（Gemini API呼び出し）とフォールバック経路（固定値の直接組み立て）が同じデータ構造（`theme`/`description`等のフィールド一式）を返す設計では、通常経路にフィールドを追加した際にフォールバック経路が追随しているか確認する。今回はかなモード追加（`themeKana`/`descriptionKana`）・英語モード追加（`themeEn`/`descriptionEn`）のどちらの実装時にも季節補充フォールバックへの反映が漏れていた

### 32. Cron Trigger実行がWorkers Free プランのCPU時間上限（10ms）を恒常的に超過し投稿が途中で止まる（2026-08）

- **症状**: 2026-08-04 22:00 UTC以降、両方のCron Trigger（`0 15 * * *`・`0 22 * * 1-5`）がCloudflareダッシュボードの実行履歴に1件も記録されなくなった。`wrangler.toml`へのコメントのみの変更で再デプロイしCron Trigger登録をリフレッシュしたところ実行自体は復旧したが、その後ダッシュボードから手動でScheduledイベントを送信した際、R2への画像保存（`bot/YYYY-MM-DD`）は成功したにもかかわらずBluesky/Mastodon投稿・Discord完了通知が一切行われなかった
- **原因調査**: Cloudflare公式ドキュメント（[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)）で、Workers Freeプランの「CPU time per Cron Trigger」上限が**10ms**であることを確認。一方、過去の正常時のCronイベントログのCPU時間は**243〜297ms**（上限の約20〜30倍）で恒常的に推移していた。公式ドキュメントには「isolateには不定期の超過を許容する内部的な猶予があるが、恒常的に超過し続ける場合は実行が終了させられる」と明記されており、これまで動作していたのはこの非公式な猶予に依存していたためと考えられる。2026-08-04以降この猶予が尽きた（または打ち切られた）結果、Cron実行自体が記録されなくなり、再デプロイ後もCPU時間予算切れで`runBot()`の後半（Bluesky/Mastodon投稿・Discord通知）まで到達できないケースが発生したと推定される
- **恒久対応（未実施・検討中）**: Workers Paidプランへのアップグレード（月$5〜）でCPU時間上限が30秒（1時間未満間隔のCron Trigger）に緩和される。ただし2026-08時点でSUZURI等による収益がまだ発生していないため、まずは無料枠内でCPU時間を削減する最適化を試み、それでも不安定な場合に移行を検討する方針とした
- **暫定対応（実施済み）**: `runBot()`実行パス内でCPU時間を消費している不要な重複処理を洗い出し、以下を解消した
  - `worker/bot.js`: 同一base64画像データが`saveToR2()`・`shrinkImageIfNeeded()`のサイズ判定・Bluesky投稿用バイト列変換の3箇所で毎回デコードし直されていた。1回のデコード結果を使い回すよう変更
  - `worker/bot.js`: `graphemeLength()`/`truncateToGraphemes()`が`Intl.Segmenter`を毎回新規生成し、上限を超えない場合でも常に全文を書記素分割していた（`Bug#30`で追加した安全網）。JS文字列の`.length`（UTF-16コード単位数）は書記素数の上界であることを利用し、`text.length <= max`の場合はSegmenterを呼ばずに済むfast pathを追加。`Intl.Segmenter`インスタンスはモジュールスコープで1つを使い回す
  - `worker/index.js`: `handleGenerate()`が`getSeasonalStyleTone()`用のJST日付を`toJSTDateStringWorker(new Date())`で独自に再計算していたが、`runBot()`側で同じ日付をすでに計算済みだった。`body.jstDateISO`として渡せる場合はそれを再利用するよう変更（後方互換: 未指定時は従来通り自前で計算）
  - `worker/bot.js`: Discord通知の裏面漢字表示行が、`handleResearch()`側で`normalizeKanjiChar()`によりすでに正規化済みの値に対して同じ正規表現で再判定していた。単純な値比較（`_k && _k !== "😺"`）に置き換えて正規表現を削除。季節補充フォールバック由来の`kanjiChar: null`（`normalizeKanjiChar()`を通らない）も正しく「なし→🐾」表示になることを確認した上で修正（サブエージェントの初期提案`_k === "😺" ? ... : ...`はこの`null`ケースを見落としており`"null（採用）"`と表示するバグを持っていたため採用せず修正）
  - `worker/bot.js`: `buildHashtagFacets()`/`buildUrlFacets()`がそれぞれ独自に`new TextEncoder()`を生成していた（`createPost()`1回あたり最大3インスタンス）。モジュールスコープの単一インスタンスを共有するよう変更
  - `worker/bot.js`: `research.description ?? ""`を`runBot()`内4箇所で毎回再評価していたのを、`desc`変数に1回だけ代入して使い回すよう変更
- **見送った項目**: `buildThemeTag()`の3重計算（`runBot()`・`buildPostText()`・`buildMastodonText()`各々で再計算）とヘッダー文字列の2重組み立ては、`buildPostText()`/`buildMastodonText()`のシグネチャ変更が必要で`scripts/test-bot.mjs`内の既存テスト呼び出し箇所への影響範囲が広い一方、正規表現・テンプレートリテラルの計算コスト自体は`Intl.Segmenter`や`Date`系ほど高くないため、今回は見送った
- **観測性の追加（実施済み・上記の暫定対応を実測で検証するため）**:
  - `wrangler.toml`に`[observability.traces]`を有効化（ベータ期間中無料）
  - Cron・HTTPエンドポイント問わず「重そうな処理」の前後に`performance.now()`計測を追加。`worker/index.js`の`recordCpuCheckpoint(step, ms, kv = null)`に共通化し、`console.log`（`[cpu] {step}: {ms}ms`形式）と、既存のレート制限で呼び出し回数が有界な経路（`research`・`generate`・`suzuriCreate-backTextureDecode`・`shrinkImage`・Cron）のみ`incrementCpuTimeKv()`によるKV日次集計（キー`cpu-time:YYYY-MM-DD`）を行う。`/usage`と同じ`GET /cpu-usage`エンドポイントで直近30日分を取得できる
  - `research`/`generate`の計測は`handleResearch()`/`handleGenerate()`内部（`fetchWithRetry()`のネットワーク待ちを含まない同期処理区間のみ）に実装し、Cron・`/research`・`/generate`・`generateResearchPool()`の10並列呼び出しすべてを1箇所でカバーする
  - `/image/:id`（`getImageFromR2()`）はレート制限がなく高頻度に呼ばれるため、Workers KV Freeプランの書き込み上限（1,000回/日）を圧迫しないよう`console.log`のみに留め、`recordCpuCheckpoint()`は使わない（循環import回避のため`r2-storage.js`は`worker/index.js`をimportしない設計上の理由もある）
  - `scripts/health-check.js`に`/cpu-usage`を呼びCIログにステップ別サマリーを出力するチェック（`[W4]`）を追加。これによりCloudflareダッシュボードを都度確認せずとも、Claude CodeセッションがGitHub Actionsログから実測CPU時間を確認できるようになった
- **テスト**: 既存の`scripts/test-bot.mjs`（657件+26件）で全項目が動作変更なしであることを回帰確認。fast path追加箇所・`incrementCpuTimeKv()`・`recordCpuCheckpoint()`には正常系/累積/境界値のテストを追加
- **場所**: `worker/bot.js`（`shrinkImageIfNeeded()` `graphemeLength()` `truncateToGraphemes()` `runBot()` `buildHashtagFacets()` `buildUrlFacets()`）・`worker/index.js`（`handleResearch()` `handleGenerate()` `incrementCpuTimeKv()`（新設） `recordCpuCheckpoint()`（新設） `/cpu-usage`（新設） `/suzuri-create`ハンドラー）・`worker/r2-storage.js`（`getImageFromR2()`）・`wrangler.toml`・`scripts/health-check.js`
- **教訓**: Cloudflare WorkersのCPU時間制限は「たまたま動いている」状態が長く続くことがあり、実際に制限を超過している事実に気づきにくい。定期的にダッシュボードのCronイベントログでCPU時間の実測値を確認し、プランの公式上限と比較する習慣が必要。またLLMエージェントが提案する「一見安全な簡略化」も、分岐の全パターン（今回は`null`という第3の値）を网羅しているか必ず自分で検証してから適用する。さらに、コード削減の最適化だけでなく「効果を実測で検証できる仕組み」自体を併せて整備しないと、修正が本当に効いたのか確認する手段がなくなる（`/usage`と同じKV集計＋API公開パターンをそのまま流用できた）
- **追加調査・対応（2026-08、`/cpu-usage`稼働後の実測データ取得後）**: 上記の観測性追加後、初回の実測データ（`generateResearchPool()`の0:00 JST Cron分）で`research`ステップが`maxMs=94ms`（10ms上限の約9倍）という懸念のある値を示した。掘り下げたところ、`handleResearch()`/`handleGenerate()`の計測区間（`tCpuStart`〜`recordCpuCheckpoint()`呼び出し）に、本来除外すべき`incrementUsageKv()`の`await`（KV `get`→`put`の2回のネットワークラウンドトリップ）が含まれており、実際のCPUバウンドな同期処理（JSON.parse・正規表現・`stripHtmlTags()`等、通常1ms未満）ではなくこのKV往復が計測値を水増ししていたことが判明した。
  - **是正**: `performance.now() - tCpuStart`の計算を`incrementUsageKv()`呼び出しより前に移動し、KV往復を計測区間から除外した
  - **副次対応**: `handleResearch()`/`handleGenerate()`・`generateResearchPool()`・`runBot()`・`scheduled()`・`fetch()`の`/research`・`/generate`ハンドラーに`ctx`（Workers `ExecutionContext`）を新たに通し、`incrementUsageKv()`・`recordCpuCheckpoint()`の呼び出しを`ctx.waitUntil()`で背景化した（`ctx`未指定時は従来通り`await`する後方互換設計）。これによりKV書き込みの完了を待たずに`handleResearch()`/`handleGenerate()`が結果を返せるようになり、HTTPエンドポイントの応答速度・Cron全体の壁時計時間の両方が改善する。`/suzuri-create`のfal.aiキュー処理で既に使われている`ctx.waitUntil()`パターンを踏襲した
  - **検討したが採用しなかった案**: Cloudflare Workersは1 invocationにつき単一のV8アイソレート（真のマルチスレッド不可）のため、KV書き込みの「マルチスレッド化」自体は選択肢にならない。またCPU時間課金・上限はinvocation全体（`waitUntil()`の背景処理を含む）に対して適用されるため、`ctx.waitUntil()`はCPU時間予算そのものを増やすものではなく、あくまでI/O待ちをクリティカルパスから外すための手段である点に注意
  - **教訓（追加）**: 「ネットワーク待ちを含まない同期処理のみを計測する」という設計意図があっても、計測区間の途中に見落としたawait（今回は使用量集計のKV書き込み）が紛れ込むと計測値が大きく歪む。計測ポイントを追加・変更する際は、区間内のコードを1行ずつ「これはCPUバウンドか、I/Oバウンドか」を確認する
  - **横展開（同日追加）**: `/suzuri-create`ハンドラー内の`suzuriCreate-backTextureDecode`計測（`incrementUsageKv()`とのペアはなく`recordCpuCheckpoint()`単体だが、同じく`await`でクリティカルパスをブロックしていた）にも同じ「計測確定→ctxがあればwaitUntil・なければawait」パターンを適用した。この箇所は`fetch()`ハンドラー内にインラインで書かれておりexportされた関数がなかったため、`_recordBackTextureDecodeCpu(cpuMs, env, ctx)`としてテスト可能な形に切り出した（`_pollFalAndGetTexture()`等の既存の「依存関数を引数で受け取る」切り出しパターンを踏襲）
  - **見落とし・追加是正（同日）**: `worker/bot.js` `runBot()`内の`shrinkImage`計測（`recordCpuCheckpoint("shrinkImage", ..., env.RATE_KV)`）にも同じブロッキングパターンが残っていた。`runBot()`は既に`ctx`を受け取るようになっていたにもかかわらず、この呼び出しだけ`ctx`を使わずawaitしたままだった（実装時の見落とし）。「ctxがあればwaitUntil・なければawait」パターンが4箇所目の重複になったため、共通ヘルパー`_deferOrAwait(promise, ctx)`に抽出し、`handleResearch()`・`handleGenerate()`・`_recordBackTextureDecodeCpu()`・`runBot()`のshrinkImage計測の4箇所すべてで使うようリファクタした
  - **教訓（同種パターンの見落とし対策）**: 同じ設計変更を複数箇所に適用する際、grep等で`recordCpuCheckpoint(`・`incrementUsageKv(`の全呼び出し箇所を機械的に洗い出してから着手しないと、一部の呼び出し（今回は`env.RATE_KV`を渡している箇所のみが対象で、`kv`省略の呼び出しは対象外という判断が必要だった）を見落とす。修正対象の判定基準（第3引数にKVを渡しているかどうか）を明文化してから横展開すると漏れを防ぎやすい
  - **本番実測での確認（同日）**: 上記デプロイ後、フロントエンドの生成ボタンで実際に`/research`・`/generate`を呼び出し`/cpu-usage`を確認した。`generate`のcalls/totalMsは増加し`ctx.waitUntil()`背景化が機能していることを確認できた一方、`research`のcallsは変化しなかった。これは不具合ではなく、`/research`が当日のリサーチプール（`research-pool/YYYY-MM-DD.json`）にヒットする限り`handleResearch()`自体が呼ばれずCPU計測も発生しないという既存の設計（プール優先方式）通りの挙動である
  - **`generate`の残存する高い計測値の切り分け（同日）**: KV往復除去後も`generate`ステップは`maxMs=666ms`と依然として高い値を示した。原因を推測で済ませず実測で切り分けるため、`generate`ステップの計測区間のうち`JSON.parse(resText)`単体の所要時間だけを`generate-jsonParse`という別ステップとして追加計測することにした（Gemini画像生成レスポンスはbase64画像データを含む大きめのJSONのため、`JSON.parse()`自体が支配的コストである可能性が高いという仮説を検証する目的）
  - **CPU時間とネットワークI/O待ちの関係（公式ドキュメントで確認・同日）**: [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)で「Waiting on network requests (such as fetch() calls, KV reads, or database queries) does not count toward CPU time」と明記されていることを確認した。CPU時間は実際にコードを実行している時間のみを測定し、fetch・KV等のI/O待ちは「Duration」（壁時計時間）には含まれるがCPU時間には計上されない。これは`ctx.waitUntil()`によるI/O待ちの背景化がCPU時間予算そのものを増やすものではなく、あくまでクリティカルパス（応答速度）を改善する手段であるという既存の理解と整合する
  - **自己招入したレースコンディション・テストで検出（同日）**: `generate-jsonParse`追加実装時、`recordCpuCheckpoint("generate", ...)`と`recordCpuCheckpoint("generate-jsonParse", ...)`の2つのPromiseを先に生成してから並行して`_deferOrAwait()`に渡す設計にしたところ、両者が同じKVキー（`cpu-time:YYYY-MM-DD`）へ並行してGET→PUTする形になり、read-modify-writeが競合して一方の更新が失われるバグを自ら作り込んでいた。事前に追加していたテスト（`ctxなし: 応答が返るまでにcpu-time KVへ書き込まれている`）がこれを即座に検出した。修正は、同じKVキーに書き込む2つのチェックポイントを1つの非同期関数にまとめて内部で直列に`await`し、`ctx.waitUntil()`/`_deferOrAwait()`には単一のPromiseとして渡す形にした（`usagePromise`は別キー`usage:YYYY-MM-DD`のため引き続き並行実行してよい）
  - **教訓（同じKVキーへの並行書き込み）**: 「Promiseを先に生成してから並行実行する」という最適化パターン（`usagePromise`/`cpuPromise`を先に作ってから`_deferOrAwait()`に渡す設計）は、書き込み先のKVキーが異なる場合にのみ安全。同じ日次ドキュメント（`usage:YYYY-MM-DD`・`cpu-time:YYYY-MM-DD`等）に対して複数のステップを記録する箇所を追加する際は、既存の書き込みと同じキーを共有していないか必ず確認し、共有する場合は直列化する

### 33. visualHintの主役名詞がテーマを猫に擬人化し画像内に2匹目の猫顔が出現（2026-09）

- **症状**: 「草の日」テーマの生成画像で、メインの猫（白いラグドール）とは別に、草むらの中に猫の顔がもう1つ描かれているとユーザーから報告。生成に使われた実際のプロンプトも合わせて共有された
- **原因**: `handleResearch()`のvisualHint生成指示「主役となる名詞（動物・物・人物）を1〜2語で先頭に抽出」に従い、Geminiが「草」というテーマ自体を擬人化して`cute green cat`という主役名詞を選んでいた。`_buildGeminiPrompt()`のSetting行にそのまま挿入されるため、画像生成モデルが「猫を含むシーンに、さらにもう1匹の緑の猫」を描画してしまう。2026-07に未対応のまま残っていたバグ（食材が主役名詞になり猫に合成される＝半夏生でタコの足が生えた件・`.claude/rules/architecture.md`参照）と同じ原因の類型で、対象が食材から植物に広がったケース
- **修正**: Bug#27（丸皿画像）と同じ「原因が確定していても対症療法を主策・原因対処を補助策とする」方針で両方実施
  1. **主策**: `_buildGeminiPrompt()`の末尾ネガティブ指示群に`Only the cat(s) described above should have a face, eyes, or expression. Do not depict grass, plants, flowers, food, or any other scenery element with a face, eyes, or anthropomorphized expression.`を常時追加。従来`eatingAction`が真のときのみ付与していた食べ物専用の同種指示はこれに統合・廃止した（重複防止）。`_buildPollinationsPrompt()`にも同趣旨のキーワード`only the cat has a face, no faces on other objects`を追加
  2. **補助策**: `handleResearch()`のvisualHint生成指示に「主役名詞はテーマそのものの実際の姿で表現し、テーマを猫や他の動物に擬人化しない」制約を追加
- **副次的な確認事項**: ユーザーが同時に指摘した「Discord通知のプロンプト表示が途中で途切れる」件は、`notifyDiscord()`の2,000文字上限による表示上の切り詰め（既存仕様どおり）であり、実際にGemini APIへ送信されるプロンプト自体は途切れていないことを確認した
- **テスト**: `scripts/test-bot.mjs`の`_buildGeminiPrompt`テスト群に、常時ネガティブ指示（猫以外への顔禁止）が`eatingAction`の有無にかかわらず含まれることの回帰テストを追加。`_buildPollinationsPrompt`にも同趣旨のキーワードが含まれることを確認するテストを追加
- **場所**: `worker/index.js` `_buildGeminiPrompt()` `_buildPollinationsPrompt()` `handleResearch()`（visualHint生成プロンプト文言）
- **教訓**: 2026-07に「設計の影響範囲が広いため別セッションで判断」として先送りしたバグは、症状の対象（食材→植物）を変えて再発した。visualHintの主役名詞抽出という設計そのものが「テーマを動物・人物として表現する」ことを許容している限り、対象を変えた再発は今後も起こりうる。先送りしたバグはドキュメントに記録するだけでなく、根本にある設計判断（主役名詞に動物・人物も許可する）自体が抱えるリスクとして次回発生時にすぐ参照できる形にしておく

### 未対応バグ・改善項目（次回実装時にまとめて対応）
