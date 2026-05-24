# コーディング規約

## JavaScript

- 関数は単一責務か → 複数の役割を持つ関数は分割する
- 外部APIエラーは`throw new Error("説明: status=xxx")`形式で投げているか
- `fetch`にはタイムアウト（`AbortSignal.timeout(ms)`）を設定しているか
- **外部HTTP通信後は必ず`res.text()`で受けてから`JSON.parse()`する**（`res.json()`直呼びは禁止）

  理由: CDN・ロードバランサー・Cloudflare自身が502などを平文・HTMLで返す場合、`res.json()`は`SyntaxError`を投げてクラッシュする（過去バグ: Bug#19）。

  標準パターン（JSONパース失敗自体をエラーにする場合）:
  ```js
  const resText = await res.text();
  let data;
  try { data = JSON.parse(resText); } catch {
    throw new Error(`[API名] 非JSONレスポンス: status=${res.status} body=${resText.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(`[API名] エラー: status=${res.status} message=${data.xxx ?? JSON.stringify(data)}`);
  }
  ```

  エラーメッセージにparseデータが不要な場合（Blueskyのように`data.error`が存在する場合のみ使う場合）:
  ```js
  const resText = await res.text();
  let data = {};
  try { data = JSON.parse(resText); } catch { /**/ }
  if (!res.ok) {
    throw new Error(`[API名] エラー: ${data.error ?? res.status} ${data.message ?? ""}`);
  }
  ```
- Cloudflare Workers環境ではNode.js専用API（`Buffer`等）を使っていないか
- テスト用コードは`export`で切り出し、本番コードと混在させない
- WASMモジュール（Photon等）は動的importで遅延ロードする（Node.jsテスト環境でのロード失敗回避）
- 外部APIレスポンスをMapにする際は**整数IDをキーにする**。文字列名はAPIバージョン・ロケールで表記が変わり照合ミスの原因になる（過去バグ: SUZURI `item.name` 表記ゆれ）

## 外部API調査の報告ルール

調査報告において、一次ソース（公式ドキュメント・実際のAPIレスポンス）へのアクセス可否を必ず明記する。

- アクセスできた場合: 参照したURLを明示する
- アクセスできなかった場合: 報告の冒頭に「公式ドキュメントを直接確認できていない（理由: サンドボックス制限等）。以下は学習データ・サードパーティ情報に基づく」と記載する

「公式ドキュメントを参照した」という記述だけでは不十分。実際にfetchできたかどうかを区別する。

過去の事例:

- 2026-03: 「SUZURI APIは招待制」と記録したが、公式ドキュメント未確認だった。実際は誰でも即時利用可能
- 2026-04: Wikipedia MediaWiki APIの調査でエージェントがja.wikipedia.orgへのアクセスを403でブロックされたにもかかわらず、確定情報として報告した

## かなモードのDOM書き込みルール

`translations.kana`の値はruby HTMLを含む。`el.textContent = t(key)`で書いた箇所は、`currentLang === "kana"`のとき`innerHTML`に切り替えが必要。

**標準パターン:**

```js
if (currentLang === "kana") { el.innerHTML = t(key); } else { el.textContent = t(key); }
```

**新しいUI要素を追加したら必ず確認:**

```bash
grep -n "textContent = t(" frontend/index.html
```

対象: `applyLang()`（一括適用）だけでなく、言語切り替え後に動的にDOMを書き換える全関数（`showGoods()`・`showToast()`・`showWhatsNew()`・`updateResultButtons()`・`updateDateDisplay()`等）を確認する。（過去バグ: Bug#21）

## セキュリティ

- ユーザー入力をそのままプロンプトに埋め込んでいないか（プロンプトインジェクション）
- `/proxy-image`エンドポイントは`https://image.pollinations.ai/`以外のURLを403で拒否しているか
- シークレット値（APIキー等）をログに出力していないか

## Markdown執筆ルール

全角・半角の間にスペースを入れない（JTF 3.1.1）

- ✅ `GitHub Pagesで` / ❌ `GitHub Pages で`
- ✅ `Actionsの結果` / ❌ `Actions の結果`
- ✅ `meta.jsonを更新` / ❌ `meta.json を更新`
- ✅ `eating actionは` / ❌ `eating action は`
- ✅ `TodoWriteで` / ❌ `TodoWrite で`
- コードスパン（`` ` ``）の前後にも不要スペースを入れない

全角文字同士の間にスペースを入れない（JTF 3.1.2）

- ✅ `送信で手動発火` / ❌ `送信 で手動発火`
- ✅ `ログで確認` / ❌ `ログ で確認`

日本語括弧（「」）の前後にスペースを入れない（JTF 3.3）

- ✅ `教訓**:「ドキュメント」` / ❌ `教訓**: 「ドキュメント」`
- `: 「` パターンは必ず `:「` に直す（コロン直後の引用開始が最多パターン）

用語の表記（prh・テキスト校正くんが自動修正）

| 誤り | 正しい表記 |
| --- | --- |
| ハンドラ | ハンドラー |
| パラメータ | パラメーター |
| フィルタ | フィルター |
| 既に | すでに |
| 初めて | はじめて |
| 特に | とくに |
| 関わらず | かかわらず |
| ビューア | ビューアー |
| 全く | まったく |

括弧は全角を使う（JTF 4.3.1）

- ✅ `（重要）` / ❌ `(重要)`
- ただしコード・コマンド・URLの中の括弧は半角のまま

コードブロックには言語を指定する（MD040）

- ✅ ` ```js `, ` ```bash `, ` ```text ` / ❌ ` ``` `（言語なし）

その他

- 見出しの前後に空行を入れる（MD022）
- リストの前後に空行を入れる（MD032）。`**太字:**` の直後にリストを続ける場合も必ず間に空行を入れる
- 順序付きリストは見出しをまたがずに採番する。新しい見出し下のリストは `1.` から始める（MD029）
- 同じ見出し文字列を使わない。区別できる修飾語を付ける（MD024）
- ファイルは必ず改行で終える（MD047）
- テーブルのセパレーター行はスペースを入れる: `| --- | --- |`（MD060）
