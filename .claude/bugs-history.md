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

### 未対応バグ・改善項目（次回実装時にまとめて対応）
