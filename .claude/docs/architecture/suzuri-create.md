# アーキテクチャ詳細: /suzuri-createエンドポイント仕様

> `.claude/rules/architecture.md`から移動した（2026-10）。毎セッション自動で読み込まれるファイルを軽くするため、詳細をこのファイルに分けた。本文は移動前のまま。

## /suzuri-createエンドポイント仕様

フロントエンドがCanvasでウォーターマーク合成した画像をSUZURIに登録するエンドポイント。
`/generate`からSUZURI登録処理を分離することで、合成済み画像のみSUZURIに送れる。

商品ごとにウォーターマーク位置が異なるため、フロントから**2回**呼び出す（右下グループ・中央下グループ）。

**ウォーターマーク位置ルール:**

| 商品 | position | 理由 |
| --- | --- | --- |
| `t-shirt` / `sticker` | `bottom-right` | 矩形商品なのでコーナーが見切れない |
| `can-badge` / `acrylic-keychain` | `bottom-center` | 円形・変形クロップでコーナーが切れるため |

**リクエスト:**

```json
{
  "imageData": "<base64>",
  "hiresImageData": "<base64>",
  "mimeType": "image/jpeg",
  "theme": "記念日テーマ",
  "r2Id": "user/{uuid}",
  "slugs": ["t-shirt", "sticker"],
  "description": "記念日の説明文",
  "backTexture": "data:image/jpeg;base64,..."
}
```

- `slugs`は任意。指定時はそのスラッグのみSUZURI登録する（未指定時は全4商品）。
- `r2Id`は任意。指定時はSUZURI登録完了後にR2の`meta.json`を`materialIds`/`products`で更新する。フロントは右グループ（t-shirt/sticker）・中央グループ（can-badge/acrylic-keychain）の**両方の呼び出し**に同じ`r2Id`を渡す（`createSuzuriFromImage()`）。
- `hiresImageData`は任意。t-shirt/stickerグループのみ送る。フロントがCanvas `imageSmoothingQuality:"high"`（Chrome: Lanczos / Firefox・Safari: bicubic）で2048pxにリサイズした画像。fal.ai失敗時のフォールバックとして使用し、元画像（~1024px）より印刷品質が向上する。`imageData`はfal.ai投入用として元サイズのまま維持する（2048px入力→ESRGAN→4096px≈24MBとなりSUZURI 20MB超過を招くため）。
- `description`は任意。`/research`が返す記念日説明文。SUZURIマテリアルの`description`フィールドに使用する。
- `backTexture`は任意。t-shirt/stickerグループのみ送る。フロントが`generateKanjiTexture(kanjiChar)`でCanvas生成した漢字テクスチャ（`data:image/jpeg;base64,...`形式）。`kanjiChar`がnullまたは無効値の場合は🐾フォールバックで生成し、必ず送信する。Tシャツのみ`sub_materials`（背面印刷）として適用。

**重複防止チェック（2026-04追加）:**

`r2Id`と`slugs`が両方指定された場合、R2メタの`products`に対象スラッグが全件存在すれば既存データを返して登録をスキップする。これによりボット画像への複数ユーザー同時訪問による二重登録を防ぐ。

**SUZURIマテリアルは画像1件につき2つ作成される（2026-06明確化）:**

右グループ（t-shirt/sticker）・中央グループ（can-badge/acrylic-keychain）はそれぞれ独立して`createSuzuriProducts()`を呼ぶため、`POST /api/v1/materials`が**2回**実行され、SUZURI側には別々の`materialId`を持つ2つのマテリアルが作成される。R2メタの`materialIds`（配列）は両方の呼び出し結果を`updateMetaInR2()`で蓄積し（`products`と同じupsertパターン）、14日後のクリーンアップ（`scheduled()`）が配列内の全IDを削除する。`/resume-hires/:id`（安全網エンドポイント）が右グループを再実行した場合も同様に`materialIds`へ追記する。

**Tシャツ背面画像は3つ目のマテリアルになる（2026-10判明・Bug#42）:** 右グループのTシャツに`sub_materials`（背面印刷の漢字テクスチャ）を渡すと、SUZURI側でタイトルなし・非公開（`title: null`・`published: false`）の**別マテリアル**が自動作成される（実測: 豆腐の日のTシャツ商品の背面画像URLがメインとは別の素材ID`21066962`を参照していた）。このIDは`POST /materials`のレスポンスから取得していないため`materialIds`に記録されず、上記の14日後クリーンアップから漏れて蓄積していた（2026-10時点で142件）。後述の「Tシャツ背面画像マテリアルの一括削除」で毎日掃除する。

**`updateMetaInR2()`の並行書き込み耐性（2026-09追加・Bug#34）:** 右グループ（`ctx.waitUntil()`内で15〜20秒後）・中央グループ（同期）・`/resume-hires`はいずれも同一`r2Id`のmeta.jsonへ独立したタイミングで書き込む。かつては単純な`get→JSでマージ→put`だったため、書き込みが競合すると後勝ちが先勝ちの結果を黙って上書きするロストアップデートが発生し、実際に本番でマテリアルIDが`materialIds`配列から消失する事故が起きた（詳細は`.claude/bugs-history.md`のBug#34参照）。現在はR2の条件付きPUT（`onlyIf: { etagMatches: obj.etag }`）による楽観的並行性制御+有界リトライ（`maxRetries=5`）で、複数の書き込みが競合しても全て失われずマージされることを保証している。

**`updateMetaInR2()`最終失敗時のSUZURIマテリアル削除ロールバック（`_updateMetaOrRollback()`・2026-09追加）:** 上記のCAS+リトライを`maxRetries`回試しても最終的に`updateMetaInR2()`が失敗した場合（etag競合が解消しない・R2側の障害等）、`createSuzuriProducts()`はすでに成功済み（課金対象の商品ページがSUZURI上に存在）だがR2メタには一切記録されない「孤立マテリアル」が残ってしまう。この孤立は`scripts/audit-suzuri-materials.mjs`では検出できない（同スクリプトは販売期間が過ぎた期限切れマテリアルのみを対象とし、今日登録されたばかりの孤立は対象外）ため、次に共有ページが訪問されるたびにR2側が「未登録」と誤認して再登録が走り、孤立が際限なく増え続けるリスクがある（実際に2026-09に1日で8件の孤立マテリアルが発生する事故が起きた。詳細は`.claude/bugs-history.md`のBug#34参照）。

- `worker/index.js` `_updateMetaOrRollback(env, r2Id, updates, materialId, logPrefix, deps = {})`としてexport。`updateMetaInR2()`を試み、失敗したら**直前に作成した`materialId`を`deleteSuzuriMaterial()`で削除する補償トランザクション（ロールバック）**を行う
- ロールバック（削除）が成功した場合は孤立が実際には残らないため、Discord通知は行わない（`console.error`のログのみ）。**ロールバック自体も失敗した場合のみ**Discord通知する（書き込み失敗・削除失敗の両エラーメッセージを含む）。この場合のみ実際に孤立マテリアルが残るため、手動対応が必要というシグナルになる
- center・right・`/resume-hires`の3箇所すべてこのヘルパー経由に統一。`deps`引数（`updateMetaInR2Fn`・`deleteSuzuriMaterialFn`・`notifyDiscordFn`）はテスト用（`_pollFalAndGetTexture()`と同じ「依存関数を引数で受け取る」パターン）
- **削除ロールバックが本質的に完全な保証ではない点**: `deleteSuzuriMaterial()`自体もネットワーク障害等で失敗しうる（その場合は従来通りDiscord通知で人間に委ねる）。ただしR2書き込みとSUZURI削除という独立した2つの操作が両方失敗する確率は、R2書き込みの単独失敗より大幅に低いと見込まれるため、孤立の発生頻度を実用上大きく下げられる

**レスポンス:**

```json
{
  "products": [{ "slug": "t-shirt", "sampleUrl": "...", "previewImageUrl": "...", "available": true }, ...],
  "materialId": 12345
}
```

`materialId`はこの呼び出し（1グループ分）で作成されたマテリアルのIDを返す。R2に蓄積される配列は`materialIds`（複数形）であり、フィールド名が異なる点に注意。

| フィールド | 説明 |
| --- | --- |
| `slug` | 商品種別（`t-shirt` / `sticker` / `can-badge` / `acrylic-keychain`） |
| `sampleUrl` | SUZURIの商品詳細ページURL |
| `previewImageUrl` | グッズプレビュー画像URL（`pngSampleImageUrl` → `sampleImageUrl` の優先順）。フロントでサムネイルカード表示に使用 |
| `available` | 在庫あり: true / 在庫切れ: false |
| `queued` | t-shirt/sticker のfal.ai処理中: true（`previewImageUrl`なし） |

**フロントのグッズ表示（`showGoods()`）:**

| 状態 | 表示 |
| --- | --- |
| `available: true` + `previewImageUrl`あり | サムネイル画像カード（`<img>` + 商品名ラベル）。SUZURIへリンク |
| `available: true` + `previewImageUrl`なし | テキストボタン（後方互換） |
| `queued: true` | 生成済み猫画像を`opacity-40`に暗転 + 商品アイコンオーバーレイ（「準備中」トースト） |
| それ以外（在庫切れ等） | `btn-disabled`グレーボタン |

**SUZURIプレビュー画像のCDN遅延対策（2026-04）:**

商品登録直後、SUZURIはプレビュー画像を非同期生成する。生成完了前にブラウザがURLを叩くと404が返りネガティブキャッシュされる。`<img onerror>`で3秒後に1回だけリトライ（`?r=1`クエリ付加でキャッシュ回避）。

- `SUZURI_API_KEY`未設定時は503を返す
- レート制限なし（`/generate`のレート制限が上流で機能するため）

**SUZURIマテリアル説明文（`buildDescription()`・2026-04）:**

`POST /api/v1/materials`の`description`フィールドは任意文字列として公式APIが対応していることを確認済み（[developer docs](https://suzuri.jp/developer/documentation/v1)）。

```text
{M}月{D}日の「{theme}」をテーマにしました。
【期間限定！】{期限日}（日本時間）までの販売🐱

{description}          ← 空の場合はこのブロックごと省略

にゃんバーサリー {URL}  ← r2Id指定時は?id={r2Id}付き画像ページ、未指定はTOPページ
#AIイラスト #猫 #水彩画 #記念日 #にゃんバーサリー #{themeTag} #{guestSuzuriTag}
```

- 登録日のJST日付と期限日（+14日JST）は`buildDescription(theme, description, r2Id, nowMs)`内で算出
- `nowMs`はテスト用引数（デフォルト`Date.now()`）。固定値で日付ロジックの回帰テストが可能
- SUZURI自動削除（14日）は`scheduled()`のcleanupブロックで実装済み。R2と期限を統一している
- `{themeTag}`はthemeの末尾の「の日」を除去してタグ化（例: 大仏の日 → `#大仏`）。記号のみになる場合は省略
- `{guestSuzuriTag}`はゲスト登場時のみ追加（例: `#犬` `#うさぎ`）。伴侶猫・子猫は`#猫`と重複するため追加しない

**`createSuzuriProducts()`のシグネチャ（2026-04更新）:**

```js
createSuzuriProducts(imageUrl, theme, env, slugFilter = null, backTexture = null, description = "", r2Id = null, guestSuzuriTag = null)
```

- `backTexture`: Tシャツのみ`sub_materials`（背面印刷）に使用。`data:image/jpeg;base64,...`形式。nullの場合は背面印刷なし
- `description`・`r2Id`はフロントから`/suzuri-create`のリクエストボディで受け取り、`/resume-hires`ではR2メタから取得する
- can-badge/acrylic-keychainグループの呼び出しでは`backTexture=null`を渡す（Tシャツへの背面印刷は右グループのみ）
- 全商品に`resizeMode: "contain"`を設定（画像がアスペクト比を保ったまま収まる）
