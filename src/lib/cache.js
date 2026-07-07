/**
 * Pranslate キャッシュモジュール
 *
 * 同一モード・同一テキストに対する Gemini API 呼び出し結果を
 * chrome.storage.local にキャッシュし、重複リクエストを避ける。
 * サービスワーカー（type: "module"）から import される。
 */

import { STORAGE_KEYS } from "./config.js";

/**
 * テキストを正規化する（前後の空白除去 + 内部の連続空白を単一スペースへ）。
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
}

/**
 * mode + 正規化テキストから SHA-256 の 16 進文字列（小文字）を計算する。
 * @param {string} mode
 * @param {string} text
 * @returns {Promise<string>} 小文字16進ハッシュ
 */
export async function hashKey(mode, text) {
  const normalized = normalize(text);
  const source = `${mode}\n${normalized}`;
  const data = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * キャッシュ済みの回答テキストを取得する。存在しない・エラー時は null。
 * @param {string} mode
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function getCached(mode, text) {
  try {
    const hash = await hashKey(mode, text);
    const key = STORAGE_KEYS.CACHE_PREFIX + hash;
    const stored = await chrome.storage.local.get(key);
    const entry = stored?.[key];
    if (entry && typeof entry === "object" && typeof entry.text === "string") {
      return entry.text;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 回答テキストをキャッシュに保存する。エラー時は何もしない。
 * @param {string} mode
 * @param {string} text
 * @param {string} fullText 保存する完成済み回答テキスト
 * @returns {Promise<void>}
 */
export async function setCached(mode, text, fullText) {
  try {
    const hash = await hashKey(mode, text);
    const key = STORAGE_KEYS.CACHE_PREFIX + hash;
    await chrome.storage.local.set({
      [key]: { text: fullText, ts: Date.now() },
    });
  } catch {
    // ストレージエラーは無視（キャッシュはベストエフォート）
  }
}
