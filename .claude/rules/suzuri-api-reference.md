# SUZURI APIリファレンス（にゃんバーサリー向け抜粋）

公式ドキュメント全体を読み込み、現在の実装と照合した結果をまとめたもの。
原典: `tmp/SUZURI API _ オリジナルグッズ・アイテム通販 ∞ SUZURI（スズリ）.pdf`（2026-04-19取得）

---

## 実装済みエンドポイント

| メソッド | パス | 用途 | 実装箇所 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/items` | アイテムID一覧取得・在庫確認 | `worker/suzuri.js` `fetchAvailableItemIds()` |
| `POST` | `/api/v1/materials` | マテリアル＋商品一括作成 | `worker/suzuri.js` `createSuzuriProducts()` |
| `DELETE` | `/api/v1/materials/{id}` | マテリアル削除（テスト後クリーンアップ用） | `scripts/test-suzuri-api.mjs` |

---

## 実装済み追加フィールド（2026-04）

### `products/resizeMode`

全商品に`"contain"`を設定済み（`worker/suzuri.js` `createSuzuriProducts()`）。

| 値 | 挙動 |
| --- | --- |
| `"contain"` | 画像をアスペクト比を保ったまま商品内に収める（余白あり） |
| 未指定 | SUZURIのデフォルト配置（トリミングの可能性あり） |

---

## 未使用だが将来有用な機能

### 1. `products/exemplaryItemVariantId`（Material Create/Update）

「サンプル表示」に使うバリアント（色×サイズの組み合わせ）を指定するパラメータ。
未指定の場合はSUZURI側がデフォルトを選ぶ（Tシャツはホワイト Sサイズになることが多い）。

```json
{
  "products": [
    {
      "itemId": 1,
      "exemplaryItemVariantId": 151,
      "published": true
    }
  ]
}
```

`itemVariantId`は`GET /api/v1/items`のレスポンスの`variants[].id`で確認できる。
**現状の実装では未指定**。SUZURI側のデフォルトに任せている。

---

### 3. 背面印刷（`products/sub_materials`）

Tシャツの背面に別画像を印刷するオプション。

```json
{
  "products": [
    {
      "itemId": 1,
      "published": true,
      "sub_materials": [
        {
          "texture": "https://example.com/back-image.png",
          "printSide": "back",
          "enabled": true
        }
      ]
    }
  ]
}
```

**活用場面**: Tシャツ背面に記念日テキストや別デザインを入れる場合。
**注意**: 追加画像生成が必要になるため実装コストが高い。現状は不要。

---

### 4. `PUT /api/v1/materials/{material_id}`（Material Update）

マテリアルの情報を更新するエンドポイント。削除せずにタイトル・価格・商品構成を変更できる。

```bash
curl -X PUT /api/v1/materials/$MATERIAL_ID \
  -H "Authorization: Bearer $SUZURI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "新しいタイトル", "price": 200}'
```

**活用場面**: 将来的にトリブン（価格）を動的に変えたい場合や、タイトルを更新したい場合。
**現状**: 価格は`SUZURI_TORIBUN`定数で固定しており更新不要。

---

### 5. `GET /api/v1/products?materialId={id}`（Product List + materialIdフィルタ）

特定マテリアルIDに紐づく商品一覧を取得できる。

```bash
curl -n /api/v1/products?materialId=31106
```

**活用場面**: R2メタデータなしに「このマテリアルの商品が存在するか」をSUZURI APIから直接確認できる。
**現状**: 重複チェックはR2メタデータの`products`フィールド有無で判定しているため、このエンドポイントは不要。

---

### 6. `GET /api/v1/products/{product_id}`（Product Info）

個別商品の詳細情報。リスト取得と異なり、**全バリアント（色×サイズ）**の情報が`itemVariants[]`として取得できる。

リスト系エンドポイント（`GET /api/v1/products`等）は`sampleItemVariant`（1件）しか返さないが、このエンドポイントは`itemVariants`（全件）を返す。

**活用場面**: 特定商品のカラー展開・サイズ展開を調べたい場合。現状は不要。

---

### 7. `GET /api/v1/materials`（Material List）

自分のマテリアル一覧（デフォルト20件）を取得。

```bash
curl -n "/api/v1/materials?limit=30&offset=0" \
  -H "Authorization: Bearer $SUZURI_API_KEY"
```

**活用場面**: 過去に登録したマテリアルの棚卸しや、孤立したマテリアルの削除。
`scripts/test-suzuri-api.mjs`に追加すると運用管理が楽になる。

---

### 8. Choice API（キュレーションコレクション）

複数の商品をグループ化して「特集」として公開できる機能。

```bash
# Choiceを作成
POST /api/v1/choices
{
  "title": "にゃんバーサリー 人気グッズまとめ",
  "description": "..."
}

# 商品を追加
POST /api/v1/choices/{choice_id}
{ "productId": 1, "itemVariantId": 1 }
```

**活用場面**: 季節ごと・テーマごとに商品コレクションを作りSUZURIトップに特集として掲載できる。
**現状**: 商品数がまだ少ないため優先度低。売上が増えてから検討。

---

### 9. `GET /api/v1/user`（自分の情報確認）

認証済みユーザー自身の情報を返す。APIキーが正しく機能しているか確認するのに便利。

```bash
curl -n /api/v1/user -H "Authorization: Bearer $SUZURI_API_KEY"
```

**活用場面**: `scripts/test-suzuri-api.mjs`のStep 0として「APIキー疎通確認」に追加できる。

---

## APIの制約・注意事項（原典より）

| 項目 | 内容 |
| --- | --- |
| **ホスト** | `suzuri.jp`（HTTPS必須） |
| **認証** | `Authorization: Bearer <token>` ヘッダー |
| **Content-Type** | POST/PUT/DELETEは `application/json` |
| **成功ステータス** | 200（削除は204） |
| **エラー時** | 40x/50x。レスポンスボディは不定のため、必ずステータスコードを先に確認 |
| **レート制限** | `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` ヘッダーで確認 |
| **画像上限** | 20MB（SUZURI側で422エラー。ESRGANで対応済み） |
| **texture フィールド** | URL または base64 data URIのどちらも受け付ける |

---

## 既存ドキュメントとの整合確認（2026-04-19時点）

| 項目 | architecture.md の記載 | APIドキュメントとの一致 |
| --- | --- | --- |
| アイテムID（t-shirt=1, sticker=11等） | ✅ 記載あり | ✅ 一致 |
| `POST /api/v1/materials` のリクエスト仕様 | ✅ 記載あり | ✅ 一致 |
| `products[].price` はトリブン（上乗せ額） | ✅ 正しく記載 | ✅ 一致（「will be added to the price of item variant」） |
| `sampleUrl` が購買ページURL | ✅ 記載あり | ✅ 一致 |
| `pngSampleImageUrl` の存在 | ✅ architecture.mdに記載 | ⚠️ PDFには`sampleImageUrl`のみ。`pngSampleImageUrl`は別バージョン対応の可能性あり |
| `products[].item.name`で照合していた旧バグ | ✅ 過去バグとして記録済み | ✅ PDFでも`item.name`は`"t-shirt"`等のスラッグ（整数IDで照合が正解） |
