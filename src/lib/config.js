/**
 * Pranslate 設定モジュール
 *
 * MV3 サービスワーカー（type: "module"）とオプションページの両方から
 * import される共通設定。依存ライブラリなし。
 */

/** chrome.storage.local で使うキー。衝突防止のため "pranslate:" を接頭辞にする */
export const STORAGE_KEYS = {
  SETTINGS: "pranslate:settings",
  USAGE: "pranslate:usage",
  CACHE_PREFIX: "pranslate:cache:",
};

/**
 * 既定の設定値。
 * - apiKey: Gemini API キー（未設定時は空文字）
 * - model: 使用モデル ID
 * - defaultEnabled: 選択ポップアップを既定で有効にするか
 * - dailyLimit: 1日あたりのリクエスト上限（null = 無制限）
 */
export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-2.5-flash-lite",
  defaultEnabled: true,
  dailyLimit: null,
};

/**
 * オプションページで選択できる Gemini モデル一覧。
 * オプション UI 側で任意のモデル ID を自由入力できるため、
 * ここには代表的な選択肢のみ列挙する。
 */
export const MODELS = [
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite（推奨・最速）",
    note: "最も高速・軽量。無料枠の1日あたり回数（RPD）が最大。",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash（高品質）",
    note: "無料枠あり。速度と品質のバランスが良い標準モデル。RPD は Lite より少なめ。",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash（最新安定版）",
    note: "最新の安定版。無料枠あり。",
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview（プレビュー）",
    note: "プレビュー版。仕様変更や制限変更の可能性あり。",
  },
];

/** 3つの説明モード（翻訳 / コード解説 / 用語解説） */
export const MODE_IDS = ["translate", "code", "term"];

/**
 * 設定を読み込む。
 * ストレージが空・部分的でも DEFAULT_SETTINGS に浅くマージして
 * 常に完全な形の設定オブジェクトを返す。
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const saved = stored?.[STORAGE_KEYS.SETTINGS];
  // 保存値がオブジェクトでない（未保存・破損など）場合は既定値のみ返す
  return {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === "object" ? saved : {}),
  };
}

/**
 * 設定を部分更新して保存する。
 * 現在の設定に patch を浅くマージし、マージ後の設定を返す。
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch 更新したい項目のみ
 * @returns {Promise<typeof DEFAULT_SETTINGS>} マージ後の設定
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}
