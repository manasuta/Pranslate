/**
 * Pranslate レート制限モジュール
 *
 * 1日あたりの Gemini API 呼び出し回数を chrome.storage.local で管理する。
 * ローカル日付（YYYY-MM-DD）が変わったらカウントをリセットする。
 * サービスワーカー（type: "module"）から import される。
 */

import { STORAGE_KEYS } from "./config.js";

/**
 * 今日の日付文字列（ローカルタイムゾーン基準）を YYYY-MM-DD で返す。
 * @returns {string}
 */
function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 本日分の使用状況を取得する。
 * 保存されている日付が今日と異なる場合は count を 0 として扱う
 * （ストレージ自体はまだ更新しない。更新するのは recordCall のタイミング）。
 * @returns {Promise<{date: string, count: number}>}
 */
export async function getUsage() {
  const today = todayString();
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = stored?.[STORAGE_KEYS.USAGE];
    if (usage && typeof usage === "object" && usage.date === today && typeof usage.count === "number") {
      return { date: today, count: usage.count };
    }
    return { date: today, count: 0 };
  } catch {
    return { date: today, count: 0 };
  }
}

/**
 * 呼び出し可能かどうかを判定する。
 * limit が null/undefined/0以下の場合は無制限として true を返す。
 * @param {number|null|undefined} limit
 * @returns {Promise<boolean>}
 */
export async function canCall(limit) {
  if (limit === null || limit === undefined || limit <= 0) {
    return true;
  }
  try {
    const usage = await getUsage();
    return usage.count < limit;
  } catch {
    return true;
  }
}

/**
 * 呼び出しを1回記録する。日付が変わっていれば 1 にリセットしてから記録する。
 * @returns {Promise<{date: string, count: number}>} 更新後の使用状況
 */
export async function recordCall() {
  const today = todayString();
  try {
    const usage = await getUsage();
    const nextCount = usage.date === today ? usage.count + 1 : 1;
    const next = { date: today, count: nextCount };
    await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: next });
    return next;
  } catch {
    return { date: today, count: 1 };
  }
}
