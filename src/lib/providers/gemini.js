// Gemini プロバイダ。
// 将来プロバイダを差し替えやすいよう、外部からは「プロバイダ interface」だけを使う。
//
// プロバイダ interface（この形を満たせば差し替え可能）:
//   id: string
//   async *generateStream({ apiKey, model, systemInstruction, userText, signal })
//       -> テキスト片(string)を順次 yield する非同期ジェネレータ
//   async generate({ apiKey, model, systemInstruction, userText, signal }) -> string
//
// エンドポイント:
//   非ストリーム : .../models/{model}:generateContent
//   ストリーム   : .../models/{model}:streamGenerateContent?alt=sse
//   認証         : x-goog-api-key ヘッダ

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// リクエストボディを組み立てる（system_instruction + user contents）
function buildBody(systemInstruction, userText) {
  return {
    system_instruction: { parts: [{ text: systemInstruction || "" }] },
    contents: [{ role: "user", parts: [{ text: userText || "" }] }],
    generationConfig: {
      temperature: 0.3,
      // 学習補助なので端的に。長すぎる出力を防ぐ。
      maxOutputTokens: 1024,
    },
  };
}

// レスポンス JSON から候補テキストを取り出す
function extractText(json) {
  const cand = json && json.candidates && json.candidates[0];
  if (!cand) return "";
  const parts = (cand.content && cand.content.parts) || [];
  return parts.map((p) => (p && p.text) || "").join("");
}

// HTTP エラーを日本語の分かりやすい Error に変換
async function toApiError(res) {
  let detail = "";
  try {
    const data = await res.json();
    detail = (data && data.error && data.error.message) || "";
  } catch (_) {
    try { detail = await res.text(); } catch (_) { /* noop */ }
  }
  const map = {
    400: "リクエストが不正です（APIキーやモデル名を確認してください）。",
    401: "認証に失敗しました。APIキーを確認してください。",
    403: "アクセスが拒否されました。APIキー/権限を確認してください。",
    404: "モデルが見つかりません。オプションでモデル名を確認してください。",
    429: "レート上限に達しました（無料枠の上限の可能性）。少し待って再試行してください。",
    500: "Gemini 側でエラーが発生しました。",
    503: "Gemini が一時的に混雑しています。少し待って再試行してください。",
  };
  const base = map[res.status] || `APIエラー（HTTP ${res.status}）。`;
  const err = new Error(detail ? `${base}\n${detail}` : base);
  err.status = res.status;
  return err;
}

// 指数バックオフで再試行すべきステータスか
function isRetryable(status) {
  return status === 429 || status === 500 || status === 503;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    }
  });
}

// fetch（429/5xx は最大2回まで指数バックオフ再試行）
async function fetchWithRetry(url, init, signal) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const err = await toApiError(res);
    lastErr = err;
    if (attempt < maxAttempts - 1 && isRetryable(res.status)) {
      await delay(500 * Math.pow(2, attempt), signal); // 500ms, 1000ms
      continue;
    }
    throw err;
  }
  throw lastErr || new Error("不明なAPIエラー。");
}

async function* generateStream({ apiKey, model, systemInstruction, userText, signal }) {
  if (!apiKey) throw new Error("APIキーが未設定です。");
  const url = `${BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildBody(systemInstruction, userText)),
      signal,
    },
    signal
  );

  // SSE を行単位でパース（"data: {json}"）
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const text = extractText(json);
        if (text) yield text;
      } catch (_) {
        // 分割された JSON 断片などは無視（次のチャンクで揃う）
      }
    }
  }
}

async function generate({ apiKey, model, systemInstruction, userText, signal }) {
  if (!apiKey) throw new Error("APIキーが未設定です。");
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildBody(systemInstruction, userText)),
      signal,
    },
    signal
  );
  const json = await res.json();
  return extractText(json);
}

export const gemini = { id: "gemini", generateStream, generate };
