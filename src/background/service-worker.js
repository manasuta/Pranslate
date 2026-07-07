// Service worker（司令塔）
// 役割:
//  - 拡張アイコンによるタブ単位の ON/OFF トグル＋バッジ
//  - キーボードコマンド受信 → content へモード発火を通知
//  - content からの getState 応答
//  - Port 経由でモード実行（キャッシュ / 上限チェック / Gemini ストリーミング中継）

import { getSettings } from "../lib/config.js";
import { buildMessages } from "../lib/prompts.js";
import { getCached, setCached } from "../lib/cache.js";
import { canCall, recordCall } from "../lib/ratelimit.js";
import { gemini } from "../lib/providers/gemini.js";

// 差し替え可能なプロバイダ（将来ここを変えるだけで別APIに）
const provider = gemini;

// タブ単位の有効状態（メモリ保持。ナビゲーションで既定へリセット）
const tabEnabled = new Map(); // tabId -> boolean

async function defaultEnabled() {
  try {
    return (await getSettings()).defaultEnabled;
  } catch (_) {
    return true;
  }
}

async function isEnabled(tabId) {
  if (tabId != null && tabEnabled.has(tabId)) return tabEnabled.get(tabId);
  return await defaultEnabled();
}

function updateBadge(tabId, enabled) {
  if (tabId == null) return;
  try {
    chrome.action.setBadgeText({ tabId, text: enabled ? "" : "OFF" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#8a8a8a" });
    chrome.action.setTitle({
      tabId,
      title: enabled
        ? "Pranslate: 有効（クリックで無効化）"
        : "Pranslate: 無効（クリックで有効化）",
    });
  } catch (_) {
    /* タブが閉じている等は無視 */
  }
}

// --- 拡張アイコン: タブ単位トグル ---
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const next = !(await isEnabled(tab.id));
  tabEnabled.set(tab.id, next);
  updateBadge(tab.id, next);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "setEnabled", enabled: next });
  } catch (_) {
    /* content 未注入（chrome:// 等）は無視 */
  }
});

// --- ナビゲーションで状態をリセット ---
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    tabEnabled.delete(tabId);
    try { chrome.action.setBadgeText({ tabId, text: "" }); } catch (_) {}
  }
});
chrome.tabs.onRemoved.addListener((tabId) => tabEnabled.delete(tabId));

// --- content からの単発メッセージ ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getState") {
    const tabId = sender.tab && sender.tab.id;
    (async () => {
      const enabled = await isEnabled(tabId);
      if (tabId != null) {
        tabEnabled.set(tabId, enabled);
        updateBadge(tabId, enabled);
      }
      sendResponse({ enabled });
    })();
    return true; // 非同期応答
  }
  return false;
});

// --- キーボードコマンド → モード発火 ---
chrome.commands.onCommand.addListener(async (command) => {
  const mode = command; // "translate" | "code" | "term"
  if (mode !== "translate" && mode !== "code" && mode !== "term") return;
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    return;
  }
  if (!tab || tab.id == null) return;
  if (!(await isEnabled(tab.id))) return; // 無効ページでは何もしない
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "triggerMode", mode });
  } catch (_) {
    /* content 未注入は無視。ショートカットは選択が無ければ content 側でも無反応 */
  }
});

// --- Port 経由のモード実行（ストリーミング中継） ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pranslate") return;
  let aborter = null;
  port.onDisconnect.addListener(() => {
    if (aborter) aborter.abort();
  });
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "run") return;
    aborter = new AbortController();
    try {
      await handleRun(port, msg, aborter.signal);
    } catch (e) {
      safePost(port, { type: "error", requestId: msg.requestId, message: friendly(e) });
    }
  });
});

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch (_) {
    /* Port が切断済みなら無視 */
  }
}

function friendly(e) {
  if (e && e.name === "AbortError") return "キャンセルされました。";
  return (e && e.message) || "不明なエラーが発生しました。";
}

async function handleRun(port, msg, signal) {
  const { requestId, mode, selection, context } = msg;
  const sel = (selection || "").trim();
  if (!sel) {
    safePost(port, { type: "error", requestId, message: "テキストが選択されていません。" });
    return;
  }

  const settings = await getSettings();
  if (!settings.apiKey) {
    safePost(port, {
      type: "error",
      requestId,
      message: "APIキーが未設定です。拡張機能のオプションで Gemini API キーを設定してください。",
    });
    return;
  }

  // 1) キャッシュ（正規化＋モードでハッシュ）
  const cached = await getCached(mode, sel);
  if (cached != null) {
    safePost(port, { type: "chunk", requestId, text: cached });
    safePost(port, { type: "done", requestId, fullText: cached, cached: true });
    return;
  }

  // 2) 1日の呼び出し上限
  if (!(await canCall(settings.dailyLimit))) {
    safePost(port, {
      type: "error",
      requestId,
      message: `本日の呼び出し上限（${settings.dailyLimit} 回）に達しました。オプションで変更できます。`,
    });
    return;
  }

  // 3) プロンプト生成
  const { systemInstruction, userText } = buildMessages(mode, {
    selection: sel,
    paragraph: (context && context.paragraph) || "",
    title: (context && context.title) || "",
    url: (context && context.url) || "",
  });

  // 4) 呼び出しを記録してストリーミング
  await recordCall();
  let full = "";
  try {
    for await (const chunk of provider.generateStream({
      apiKey: settings.apiKey,
      model: settings.model,
      systemInstruction,
      userText,
      signal,
    })) {
      full += chunk;
      safePost(port, { type: "chunk", requestId, text: chunk });
    }
  } catch (e) {
    safePost(port, { type: "error", requestId, message: friendly(e) });
    return;
  }

  // 5) 完了：非空ならキャッシュ保存
  if (full.trim()) {
    await setCached(mode, sel, full);
  }
  safePost(port, { type: "done", requestId, fullText: full, cached: false });
}
