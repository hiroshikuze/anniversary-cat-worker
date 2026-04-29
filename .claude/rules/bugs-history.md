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
- **場所**: `frontend/index.html` `applyWatermark(imageData, mimeType, position)` / `_calcWatermarkLayout(imgW, imgH, textW, position)` / `worker/index.js` `/suzuri-create`ハンドラ

### 10. fal.ai AuraSRのCDN画像をbase64変換してWorkers CPU時間超過（2026-04）

- **原因**: `upscaleWithFal()`がfal.ai CDN URLから画像をfetch→ArrayBuffer→base64変換していた。4096×4096 PNG（約4MB）の変換がWorkers CPU時間上限（Paid Bundled: 50ms）を超過
- **修正**: CDNダウンロードを廃止。`upscaleWithFal()`は`{ cdnUrl, mimeType }`を返すだけにし、CDN URLを直接SUZURIの`texture`フィールドに渡す（SUZURI APIはURLを受け付ける）
- **場所**: `worker/fal.js` `upscaleWithFal()` / `worker/index.js` / `worker/bluesky-bot.js`

### 11. fal.ai CDN URLをSUZURIに直接渡すと0バイトエラー（2026-04）

- **原因**: fal.aiが返すCDN URL（`v3b.fal.media`）をSUZURIの`texture`フィールドに直接渡すと、SUZURIのサーバーがfetchした際に0バイトが返りstatus=422エラーになる。CDN URLへのアクセス制限・一時URL等が原因と推測
- **修正**: fal.ai CDN URL → Worker内でfetch → R2にバイナリ保存（I/Oのみ・CPU不要）→ `GET /hires/:id`エンドポイント経由のWorker自身のURLをSUZURIに渡す。Worker URLはSUZURIから安定してアクセスできる
- **教訓**: 外部CDN URLを第三者APIの`texture`等に直接渡す設計は、アクセス制限・TTL・リダイレクト等で失敗するリスクがある。自分で管理するURL（R2経由）に変換してから渡す
- **場所**: `worker/index.js` `/suzuri-create`ハンドラ / `GET /hires/:id`エンドポイント

### 12. AuraSR 4xがSUZURI 20MB上限を常に超過し実質アップスケールなしに（2026-04）

- **原因**: AuraSR 4xは1024px入力→4096px PNG≈24MBとなりSUZURIの20MB上限を超過。`upscaling_factor: 2`パラメータは**完全に無視**され、常に4x出力になる
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

- **原因**: `visualHint`（例: `lotus flower, baby Buddha statue, sweet tea ceremony`）が場面・小道具を既に指定しているにもかかわらず、「The cat is holding or surrounded by items related to the theme.」という空間的制約が残っていた
- **問題**: Geminiが「猫がお釈迦様の像を抱えている」等の不自然な構図に引き寄せられ、visualHintが意図する雰囲気・背景としての使い方ができなかった
- **修正**: 該当文を削除。visualHintによる場面指示に一本化し、Geminiの構図判断を尊重する
- **場所**: `worker/index.js` `handleGenerate()` `prompt`定数

### 16. ボット経由のTシャツが1024px低解像度のままSUZURI登録されていた（2026-04）

- **原因**: `runBot()`が直接`createSuzuriProducts()`を呼んでいたため、ブラウザ側の`resizeForSuzuri()`（2048px bicubic）もfal.ai ESRGAN 2xも適用されていなかった
- **修正**: ボットでのSUZURI登録を廃止。初回訪問者のブラウザで`createSuzuriFromImage()`（手動生成と同じフロー）を実行する設計に変更
- **重複防止**: `/suzuri-create`冒頭にR2メタチェックを追加。対象スラッグが全件登録済みなら既存データを返してスキップ（複数ユーザー同時訪問でも二重登録しない）
- **誰も訪問しない場合**: productsが未作成のままR2が14日で期限切れになる（許容設計）
- **場所**: `worker/bluesky-bot.js` `runBot()` / `worker/index.js` `/suzuri-create`ハンドラ / `frontend/index.html` `createSuzuriFromImage()` `loadSharedImage()`

### 17. ギャラリーとloadSharedImageの同時実行によるSUZURI重複登録（2026-04）

- **原因**: `?id=bot/YYYY-MM-DD` を開いたとき、`loadGallery()` のバックグラウンド登録（`registerGalleryItemInBackground()`）と `loadSharedImage()` が同じidに対してほぼ同時に `createSuzuriFromImage()` を呼び出していた。Worker側の重複防止チェック（R2メタ参照）はTOCTOUギャップがあり、両リクエストがR2の `products:[]` を読んだ後に両方とも登録に進んでしまった
- **修正**: `loadGallery()` でURLの `?id` パラメータと一致するidはバックグラウンド登録をスキップ。`loadSharedImage()` に一本化することで競合を排除
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

### 未対応バグ・改善項目（次回実装時にまとめて対応）

