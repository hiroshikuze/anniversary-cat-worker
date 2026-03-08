# にゃんバーサリー / Nyaniversary

AI-powered daily cat illustration generator inspired by today's anniversary.

## 概要

「にゃんバーサリー（Nyaniversary）」は、今日の記念日をAIがリサーチして、その記念日にちなんだ水彩画風の猫イラストを毎日生成するWebアプリです。

ボタンひとつで、今日だけの特別な猫イラストと記念日のエピソードをお届けします。

![にゃんバーサリー イメージイラスト](https://hiroshikuze.github.io/anniversary-cat-worker/og-image.png)

## デモ

[![Demo](https://img.shields.io/badge/Demo-Open%20App-22c55e?style=for-the-badge&logo=html5&logoColor=white)](https://hiroshikuze.github.io/anniversary-cat-worker/)

> **利用制限**: 無料公開のため、記念日リサーチは1日10回、イラスト生成は1日3回までご利用いただけます（1IPアドレスあたり、毎日リセット）。

## 特徴

- 今日の日付をもとにAIが記念日を自動リサーチ
- 記念日テーマに合わせた水彩画風の猫イラストをAI生成
- 日本語・英語の表示切り替えに対応
- 生成したイラストをワンクリックで保存可能

## 使用方法

1. 「🔍 今日の記念日を調べる」ボタンをクリックします。
2. AIが今日の記念日をリサーチし、自動的に猫イラストの生成を開始します。
3. 水彩画風の猫イラストとテーマの解説が表示されます。
4. 「🔄 もう一度生成」で別パターンのイラストを生成、「💾 保存する」でダウンロードできます。

## 使用技術

- **フロントエンド**: HTML / JavaScript / Tailwind CSS
- **バックエンド**: Cloudflare Workers
- **AI（記念日リサーチ）**: Google Gemini API（Grounding with Google Search）
- **AI（画像生成）**: Google Gemini API / Pollinations.ai（フォールバック）

## ライセンス

このプロジェクトは[MITライセンス](https://github.com/hiroshikuze/anniversary-cat-worker/blob/main/LICENSE)の下で公開されています。

## 作者

[hiroshikuze](https://github.com/hiroshikuze/)

---

## 💖 応援募集 (Support my work)

このプロジェクトを応援していただける方は、ぜひスポンサーおよび寄付をお願いします！

If you'd like to support my projects, please consider becoming a sponsor!

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=for-the-badge&logo=github-sponsors)](https://github.com/sponsors/hiroshikuze)
[![アマゾンの欲しいものリスト (Amazon.co.jp wish list)](https://img.shields.io/badge/Amazon-Wishlist-orange?style=for-the-badge&logo=amazon)](https://www.amazon.jp/hz/wishlist/ls/5BAWD0LZ89V9?ref_=wl_share)
