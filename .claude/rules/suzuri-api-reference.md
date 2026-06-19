# SUZURI APIリファレンス（にゃんバーサリー向け抜粋）

公式ドキュメント全体を読み込み、現在の実装と照合した結果をまとめたもの。
原典: `tmp/SUZURI API _ オリジナルグッズ・アイテム通販 ∞ SUZURI（スズリ）.pdf`（2026-04-19取得）

---

## 実装済みエンドポイント

| メソッド | パス | 用途 | 実装箇所 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/items` | アイテムID一覧取得・在庫確認 | `worker/suzuri.js` `fetchAvailableItemIds()` |
| `POST` | `/api/v1/materials` | マテリアル＋商品一括作成 | `worker/suzuri.js` `createSuzuriProducts()` |
| `DELETE` | `/api/v1/materials/{id}` | マテリアル削除（14日後の自動クリーンアップ・テスト後の手動削除） | `worker/suzuri.js` `deleteSuzuriMaterial()`（`worker/index.js` `scheduled()`から呼び出し）/ `scripts/test-suzuri-api.mjs` |
| `GET` | `/api/v1/materials` | マテリアル一覧取得（孤立マテリアルの棚卸し用） | `scripts/audit-suzuri-materials.mjs`（2026-06追加） |

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

[将来拡張メモ：未使用だが将来有用な機能](../future-ideas.md)参照

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
