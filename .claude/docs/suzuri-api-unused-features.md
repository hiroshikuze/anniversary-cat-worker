# SUZURI API: 未使用だが将来有用な機能

> `.claude/future-ideas.md`から移動した（2026-10）。本文は移動前のまま。

## 未使用だが将来有用な機能

### 1. `products/exemplaryItemVariantId`（Material Create/Update）

「サンプル表示」に使うバリアント（色×サイズの組み合わせ）を指定するパラメーター。
未指定の場合はSUZURI側がデフォルトを選ぶ（TシャツはホワイトSサイズになることが多い）。

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
**現状（2026-10更新）**: 漢字一字の背面印刷として実装済み（`frontend/index.html` `generateKanjiTexture()`・`worker/suzuri.js` `createSuzuriProducts()`）。

**注意（2026-10・Bug#42）**: `sub_materials`を渡すと、SUZURI側でタイトルなし・非公開の**別マテリアル**が自動作成される。このIDはR2メタの`materialIds`に記録されないため、現在は毎日のクリーンアップで素材一覧から探して削除している（`cleanupOrphanBackTextureMaterials()`）。

**改善案（未実装・案A）**: 商品登録時の`POST /materials`のレスポンスから背面素材のIDを取り出し、メイン素材と同じく`materialIds`に記録する。成り立てば素材一覧を走査する現方式より確実で、一覧取得のサブリクエストも不要になる。前提として、レスポンスに背面素材のIDが含まれるかを確認する必要がある（未確認）。確認方法: `createSuzuriProducts()`で`data.products[]`（Tシャツ分）のキー構成を一度`console.log`に出し、`query-worker-logs.mjs`で見る。含まれていれば実装し、現方式は取りこぼし対策として残すかを判断する

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

### 5. `GET /api/v1/products?materialId={id}`（Product List + materialIdフィルター）

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
`scripts/audit-suzuri-materials.mjs`（2026-06追加）と、Tシャツ背面画像マテリアルの毎日の削除（`worker/suzuri.js` `listSuzuriMaterials()`・2026-10追加・Bug#42）で使用している。`limit`の上限は50（`suzuri-api-reference.md`参照）。

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
