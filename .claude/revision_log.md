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

---

## 記録フォーマット

```text
### YYYY-MM | タイトル
- **状況**: 何をしようとしていたか
- **ミス**: 何を間違えたか
- **教訓**: 次回どう防ぐか
```
