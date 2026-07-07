/**
 * Pranslate オプションページ スクリプト
 *
 * <script type="module"> として読み込まれる。config.js の getSettings/saveSettings と
 * STORAGE_KEYS/DEFAULT_SETTINGS/MODELS を使って設定の読み書きを行う。
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS, MODELS, getSettings, saveSettings } from "../lib/config.js";

const CUSTOM_VALUE = "__custom__";

// ---- DOM 要素 ----
const apiKeyInput = document.getElementById("apiKey");
const toggleApiKeyBtn = document.getElementById("toggleApiKey");
const modelSelect = document.getElementById("model");
const customModelInput = document.getElementById("customModel");
const defaultEnabledCheckbox = document.getElementById("defaultEnabled");
const dailyLimitInput = document.getElementById("dailyLimit");
const usageTextEl = document.getElementById("usageText");
const saveBtn = document.getElementById("saveBtn");
const savedMsgEl = document.getElementById("savedMsg");
const errorMsgEl = document.getElementById("errorMsg");

/** モデル <select> の選択肢を構築する（MODELS + カスタム...） */
function populateModelSelect() {
  modelSelect.innerHTML = "";
  MODELS.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.note ? `${m.label} - ${m.note}` : m.label;
    modelSelect.appendChild(opt);
  });
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_VALUE;
  customOpt.textContent = "カスタム...";
  modelSelect.appendChild(customOpt);
}

function isKnownModel(modelId) {
  return MODELS.some((m) => m.id === modelId);
}

function updateCustomModelVisibility() {
  const isCustom = modelSelect.value === CUSTOM_VALUE;
  customModelInput.classList.toggle("pr-hidden", !isCustom);
}

modelSelect.addEventListener("change", updateCustomModelVisibility);

toggleApiKeyBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleApiKeyBtn.textContent = isPassword ? "隠す" : "表示";
});

/** 今日の使用状況を読み込み表示する */
async function loadUsage() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = stored?.[STORAGE_KEYS.USAGE];
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
    const count = usage && usage.date === todayStr && typeof usage.count === "number" ? usage.count : 0;
    usageTextEl.textContent = `本日の呼び出し: ${count} 回`;
  } catch {
    usageTextEl.textContent = "本日の呼び出し: 0 回";
  }
}

/** 設定を読み込みフォームに反映する */
async function loadSettings() {
  populateModelSelect();

  let settings;
  try {
    settings = await getSettings();
  } catch {
    settings = DEFAULT_SETTINGS;
  }

  apiKeyInput.value = settings.apiKey || "";

  if (isKnownModel(settings.model)) {
    modelSelect.value = settings.model;
    customModelInput.value = "";
  } else {
    modelSelect.value = CUSTOM_VALUE;
    customModelInput.value = settings.model || "";
  }
  updateCustomModelVisibility();

  defaultEnabledCheckbox.checked = !!settings.defaultEnabled;

  dailyLimitInput.value =
    settings.dailyLimit === null || settings.dailyLimit === undefined ? "" : String(settings.dailyLimit);

  await loadUsage();
}

function showError(message) {
  errorMsgEl.textContent = message;
  errorMsgEl.classList.remove("pr-hidden");
  savedMsgEl.classList.add("pr-hidden");
}

function clearError() {
  errorMsgEl.classList.add("pr-hidden");
  errorMsgEl.textContent = "";
}

function showSaved() {
  savedMsgEl.classList.remove("pr-hidden");
  setTimeout(() => {
    savedMsgEl.classList.add("pr-hidden");
  }, 2000);
}

/** 保存ボタン押下時のバリデーション＋保存処理 */
async function handleSave() {
  clearError();

  const apiKey = apiKeyInput.value.trim();

  const model = modelSelect.value === CUSTOM_VALUE ? customModelInput.value.trim() : modelSelect.value;
  if (modelSelect.value === CUSTOM_VALUE && !model) {
    showError("カスタムモデル ID を入力してください。");
    return;
  }

  const dailyLimitRaw = dailyLimitInput.value.trim();
  let dailyLimit = null;
  if (dailyLimitRaw !== "") {
    const parsed = Number(dailyLimitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      showError("1日あたりの呼び出し上限は正の整数、または空欄（無制限）にしてください。");
      return;
    }
    dailyLimit = parsed;
  }

  const patch = {
    apiKey,
    model,
    defaultEnabled: !!defaultEnabledCheckbox.checked,
    dailyLimit,
  };

  try {
    await saveSettings(patch);
    showSaved();
  } catch {
    showError("設定の保存に失敗しました。もう一度お試しください。");
  }
}

saveBtn.addEventListener("click", handleSave);

loadSettings();
