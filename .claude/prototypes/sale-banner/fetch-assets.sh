#!/usr/bin/env bash
# SNSセール告知バナー試作用の素材を作業ディレクトリに集める（本番コードではない）
#   bash .claude/prototypes/sale-banner/fetch-assets.sh <作業ディレクトリ> <Bot作品ID 例: bot/2026-09-25>
# 取得するもの: フォント3種（Google Fonts・OFL）・そのBot作品のSUZURIグッズ画像4種
# Geminiの背景（bg.jpg）は取得しない。手動で作業ディレクトリに置くこと。
set -euo pipefail
WORK="${1:?作業ディレクトリを指定}"
ID="${2:?Bot作品IDを指定（例: bot/2026-09-25）}"
WORKER="https://anniversary-cat-worker.hiroshikuze.workers.dev"
FONTS="https://raw.githubusercontent.com/google/fonts/main/ofl"

mkdir -p "$WORK/fonts"
for f in mochiypopone/MochiyPopOne-Regular.ttf zenmarugothic/ZenMaruGothic-Bold.ttf zenmarugothic/ZenMaruGothic-Black.ttf; do
  curl -sSfL -m 60 -o "$WORK/fonts/$(basename "$f")" "$FONTS/$f"
done

# R2メタのproducts[].previewImageUrl（lens.suzuri.jp・500x500透過PNG）を<slug>.pngとして保存
curl -sSf -m 20 "$WORKER/meta/$ID" \
  | python3 -c 'import json,sys; [print(p["slug"], p["previewImageUrl"]) for p in json.load(sys.stdin).get("products", []) if p.get("previewImageUrl")]' \
  | while read -r slug url; do curl -sSfL -m 30 -o "$WORK/$slug.png" "$url"; echo "saved $slug.png"; done
