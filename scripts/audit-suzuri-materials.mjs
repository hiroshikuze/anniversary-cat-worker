#!/usr/bin/env node
/**
 * audit-suzuri-materials.mjs - 孤立SUZURIマテリアルの棚卸し・削除
 *
 * 背景: Bug#24（旧設計ではrightグループ（t-shirt/sticker）のmaterialIdが
 * R2に保存されず、14日後の自動クリーンアップから漏れて孤立マテリアルが
 * 残り続けていた）。本スクリプトはSUZURI側に実在する全マテリアルを一覧し、
 * descriptionに埋め込まれた販売期限表記から削除対象を判定する。
 *
 * 実行前に環境変数を設定すること:
 *   export SUZURI_API_KEY=<SUZURIのAPIキー>
 *
 * 削除対象の一覧表示のみ（dry-run・実削除なし）:
 *   node scripts/audit-suzuri-materials.mjs
 *
 * 一覧を確認したうえで実際に削除:
 *   node scripts/audit-suzuri-materials.mjs --delete
 *
 * 注意: --delete オプションを付けると実際にSUZURIのマテリアルが削除される。
 *       事前に一覧をよく確認すること。
 */

const SUZURI_API_BASE = "https://suzuri.jp/api/v1";

// buildDescription()（worker/suzuri.js）が埋め込む「〇月〇日（日本時間）までの販売」を抽出する
const EXPIRY_PATTERN = /(\d{1,2})月(\d{1,2})日（日本時間）までの販売/;

/**
 * SUZURIマテリアルのdescriptionから販売期限日を算出する。
 * 年は埋め込まれていないため、現在年と仮定した素朴な解釈がnowから90日以上未来になる場合は
 * 前年と判断する（例: 12月期限のマテリアルを翌年6月の棚卸しで読む場合）。
 * @param {string} description
 * @param {Date} now
 * @returns {Date|null} 期限日（判定不可の場合はnull）
 */
export function parseExpiryDate(description, now = new Date()) {
  if (!description) return null;
  const m = description.match(EXPIRY_PATTERN);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const year = now.getUTCFullYear();
  let expiry = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));

  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (expiry.getTime() - now.getTime() > ninetyDaysMs) {
    expiry = new Date(Date.UTC(year - 1, month - 1, day, 23, 59, 59));
  }
  return expiry;
}

/**
 * GET /api/v1/materials を全件ページネーションで取得する。
 * @param {string} apiKey
 * @returns {Array<object>}
 */
async function fetchAllMaterials(apiKey) {
  const headers = { "Authorization": `Bearer ${apiKey}` };
  const limit = 100;
  let offset = 0;
  const materials = [];

  while (true) {
    const res = await fetch(`${SUZURI_API_BASE}/materials?limit=${limit}&offset=${offset}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const resText = await res.text();
    let data;
    try { data = JSON.parse(resText); } catch {
      throw new Error(`[SUZURI] 非JSONレスポンス: status=${res.status} body=${resText.slice(0, 120)}`);
    }
    if (!res.ok) {
      throw new Error(`[SUZURI] マテリアル一覧取得失敗: status=${res.status} message=${data.message ?? JSON.stringify(data)}`);
    }

    const page = Array.isArray(data) ? data : (data.materials ?? []);
    materials.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return materials;
}

async function deleteMaterial(materialId, apiKey) {
  const res = await fetch(`${SUZURI_API_BASE}/materials/${materialId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const resText = await res.text();
    throw new Error(`[SUZURI] マテリアル削除失敗: status=${res.status} id=${materialId} body=${resText.slice(0, 120)}`);
  }
}

async function main() {
  const apiKey = process.env.SUZURI_API_KEY;
  const doDelete = process.argv.includes("--delete");

  if (!apiKey) {
    console.error("❌ SUZURI_API_KEY が設定されていません");
    console.error("   export SUZURI_API_KEY=<APIキー> を実行してから再度試してください");
    process.exit(1);
  }

  console.log("\n[Step 1] GET /api/v1/materials - 全マテリアル取得");
  const materials = await fetchAllMaterials(apiKey);
  console.log(`✅ ${materials.length}件のマテリアルを取得`);

  const now = new Date();
  const expired = [];
  const undeterminable = [];

  for (const mat of materials) {
    const expiry = parseExpiryDate(mat.description ?? "", now);
    if (expiry === null) {
      undeterminable.push(mat);
    } else if (expiry.getTime() < now.getTime()) {
      expired.push({ ...mat, _expiry: expiry });
    }
  }

  console.log(`\n--- 削除対象（期限切れ）: ${expired.length}件 ---`);
  for (const mat of expired) {
    console.log(`  id=${mat.id}  期限=${mat._expiry.toISOString().slice(0, 10)}  title="${mat.title ?? ""}"`);
  }

  console.log(`\n--- 判定不可（手動確認が必要・削除対象には含めない）: ${undeterminable.length}件 ---`);
  for (const mat of undeterminable) {
    console.log(`  id=${mat.id}  title="${mat.title ?? ""}"  description="${(mat.description ?? "").slice(0, 60)}"`);
  }

  if (!doDelete) {
    console.log("\n💡 削除対象を実際に削除するには --delete オプションを付けて実行してください:");
    console.log("   node scripts/audit-suzuri-materials.mjs --delete");
    return;
  }

  if (expired.length === 0) {
    console.log("\n削除対象がないため終了します");
    return;
  }

  console.log(`\n[Step 2] DELETE /api/v1/materials/{id} - ${expired.length}件を削除`);
  for (const mat of expired) {
    try {
      await deleteMaterial(mat.id, apiKey);
      console.log(`  ✅ id=${mat.id} 削除完了`);
    } catch (e) {
      console.error(`  ❌ id=${mat.id} 削除失敗: ${e.message}`);
    }
  }
}

// このファイルが直接実行された場合のみ main() を起動する
// （test-bot.mjs から parseExpiryDate をimportする際にネットワーク処理が走らないようにするため）
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
