/**
 * Pranslate content script
 *
 * ページ内でテキスト選択を検知し、3つのモード（日本語訳 / コード説明 / 用語説明）を
 * 選べる小さなポップアップを表示する。モードを選ぶと、選択範囲付近に
 * ドラッグ可能なカードを出し、Service Worker から Port 経由でストリーミングされる
 * Markdown 回答を逐次レンダリングする。
 *
 * すべて Shadow DOM 内に閉じ込めることで、ページのレイアウト/CSSに一切影響を与えず、
 * ページ側の CSS もこちら側に影響しないようにする。
 *
 * 通常の content script（ES module ではない）。markdown.js の後に読み込まれる前提。
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 定数・状態
  // ---------------------------------------------------------------------

  /** モード定義（日本語ラベル、ショートカットキー文字） */
  const MODES = [
    { id: "translate", label: "日本語訳", key: "H" },
    { id: "code", label: "コード説明", key: "J" },
    { id: "term", label: "用語説明", key: "K" },
  ];

  /** モードIDからラベルを引く */
  const MODE_LABELS = MODES.reduce((acc, m) => {
    acc[m.id] = m.label;
    return acc;
  }, {});

  /** 拡張機能が有効かどうか（bg から同期される） */
  let enabled = true;

  /** 直近の選択情報（モード切替の再実行に使う） */
  let lastSelectionInfo = null; // { selection, context: { paragraph, title, url }, rect }

  /** 現在ストリーミング中の Port とリクエストID */
  let activePort = null;
  let activeRequestId = null;
  let answerBuffer = "";

  /** ユーザーが手動でリサイズしたカードサイズ（未設定なら自動サイズ） */
  let userSize = null; // { w, h }

  // ---------------------------------------------------------------------
  // プラットフォーム判定・ショートカット表示
  // ---------------------------------------------------------------------

  /** Mac かどうかを判定する */
  function isMac() {
    try {
      const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
      return /mac/i.test(platform);
    } catch {
      return false;
    }
  }

  /** モードごとのショートカット表示ラベルを返す（例: "⇧⌘H" / "Ctrl+Shift+H"） */
  function shortcutLabel(key) {
    return isMac() ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
  }

  // ---------------------------------------------------------------------
  // Shadow DOM ホストの構築
  // ---------------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "pranslate-host";
  // ページ側の CSS の影響を受けないよう、最低限のインラインスタイルを直接指定
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "2147483647";
  (document.documentElement || document.body).appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .pr-popup, .pr-card {
      position: fixed;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
      font-size: 13px;
      color: #1f2328;
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.16), 0 1px 3px rgba(0,0,0,0.08);
      border: 1px solid rgba(0,0,0,0.06);
    }
    .pr-hidden { display: none !important; }

    /* ---- 選択ポップアップ ---- */
    .pr-popup {
      display: flex;
      gap: 4px;
      padding: 6px;
    }
    .pr-popup button.pr-mode-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 6px 10px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: #f4f5f7;
      color: #1f2328;
      cursor: pointer;
      font-size: 12px;
      line-height: 1.3;
      white-space: nowrap;
    }
    .pr-popup button.pr-mode-btn:hover {
      background: #e8eaed;
    }
    .pr-popup button.pr-mode-btn.pr-suggested {
      background: #e6f0ff;
      border-color: #7aa7ff;
    }
    .pr-popup .pr-shortcut {
      font-size: 10px;
      color: #767b83;
    }

    /* ---- 結果カード ---- */
    .pr-card {
      width: 360px;
      max-width: 92vw;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .pr-card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      background: #f4f5f7;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      cursor: grab;
      user-select: none;
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
    }
    .pr-card-header:active { cursor: grabbing; }
    .pr-card-title {
      flex: 1;
      font-weight: 600;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pr-card-badge {
      font-size: 10px;
      color: #2f6f3e;
      background: #e3f5e6;
      border-radius: 6px;
      padding: 2px 6px;
      white-space: nowrap;
    }
    .pr-icon-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 13px;
      color: #55595e;
      padding: 4px 6px;
      border-radius: 6px;
      line-height: 1;
    }
    .pr-icon-btn:hover { background: rgba(0,0,0,0.08); }

    .pr-card-body {
      padding: 10px 12px;
      overflow-y: auto;
      overflow-x: hidden;
      line-height: 1.6;
      flex: 1 1 auto;
      /* Flex 子要素がコンテンツより小さく縮めるようにして overflow-y:auto を機能させる（本文スクロールの要） */
      min-height: 0;
      min-width: 0;
      /* 日本語・長い語も確実に折り返す */
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .pr-card-body p { margin: 0 0 8px; }
    .pr-card-body p, .pr-card-body li {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .pr-card-body p:last-child { margin-bottom: 0; }
    .pr-card-body h1, .pr-card-body h2, .pr-card-body h3,
    .pr-card-body h4, .pr-card-body h5, .pr-card-body h6 {
      margin: 10px 0 6px;
      line-height: 1.35;
    }
    .pr-card-body code {
      background: rgba(0,0,0,0.06);
      border-radius: 4px;
      padding: 1px 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .pr-card-body pre {
      background: #f6f8fa;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 8px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0 0 8px;
    }
    .pr-card-body pre code {
      background: none;
      padding: 0;
    }
    .pr-card-body ul, .pr-card-body ol {
      margin: 0 0 8px;
      padding-left: 20px;
    }
    .pr-card-body a { color: #1a5fd6; }

    .pr-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #767b83;
    }
    .pr-spinner {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(0,0,0,0.15);
      border-top-color: #767b83;
      animation: pr-spin 0.8s linear infinite;
    }
    @keyframes pr-spin { to { transform: rotate(360deg); } }

    .pr-error {
      color: #a5271f;
      background: #fdecea;
      border: 1px solid #f5c2bd;
      border-radius: 8px;
      padding: 8px 10px;
    }
    .pr-error .pr-retry {
      margin-top: 6px;
      border: 1px solid #a5271f;
      background: #fff;
      color: #a5271f;
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }

    .pr-card-footer {
      display: flex;
      gap: 4px;
      padding: 6px 8px;
      border-top: 1px solid rgba(0,0,0,0.06);
      background: #fafbfc;
      border-bottom-left-radius: 10px;
      border-bottom-right-radius: 10px;
    }
    .pr-card-footer button {
      flex: 1;
      border: 1px solid rgba(0,0,0,0.08);
      background: #ffffff;
      color: #1f2328;
      border-radius: 6px;
      padding: 5px 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .pr-card-footer button:hover { background: #f0f1f3; }
    .pr-card-footer button.pr-active {
      background: #e6f0ff;
      border-color: #7aa7ff;
    }

    /* ---- リサイズグリップ（右下） ---- */
    .pr-resize {
      position: absolute;
      right: 1px;
      bottom: 1px;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      pointer-events: auto;
      touch-action: none;
      z-index: 2;
      /* 斜線2本のグリップ表現 */
      background:
        linear-gradient(135deg, transparent 0 60%, #b3b7bd 60% 70%, transparent 70% 78%, #b3b7bd 78% 88%, transparent 88%);
      border-bottom-right-radius: 10px;
    }

    /* ---- ダークモード ---- */
    @media (prefers-color-scheme: dark) {
      .pr-popup, .pr-card {
        background: #2a2d31;
        color: #e6e6e6;
        border-color: rgba(255,255,255,0.08);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4);
      }
      .pr-popup button.pr-mode-btn {
        background: #35383d;
        color: #e6e6e6;
      }
      .pr-popup button.pr-mode-btn:hover { background: #40444a; }
      .pr-popup button.pr-mode-btn.pr-suggested {
        background: #1f3a5c;
        border-color: #4d7fc9;
      }
      .pr-popup .pr-shortcut { color: #9aa0a6; }
      .pr-card-header { background: #35383d; border-color: rgba(255,255,255,0.08); }
      .pr-icon-btn { color: #c7cad0; }
      .pr-icon-btn:hover { background: rgba(255,255,255,0.1); }
      .pr-card-body code { background: rgba(255,255,255,0.12); }
      .pr-card-body pre { background: #1e2023; border-color: rgba(255,255,255,0.08); }
      .pr-card-body a { color: #7db0ff; }
      .pr-loading { color: #9aa0a6; }
      .pr-error { color: #ff8a80; background: #402323; border-color: #6b3a35; }
      .pr-error .pr-retry { color: #ff8a80; background: #2a2d31; border-color: #ff8a80; }
      .pr-card-footer { background: #2f3237; border-color: rgba(255,255,255,0.08); }
      .pr-card-footer button {
        background: #35383d;
        color: #e6e6e6;
        border-color: rgba(255,255,255,0.1);
      }
      .pr-card-footer button:hover { background: #40444a; }
      .pr-card-footer button.pr-active {
        background: #1f3a5c;
        border-color: #4d7fc9;
      }
      .pr-card-badge { background: #1f3a2a; color: #8fd6a0; }
      .pr-resize {
        background:
          linear-gradient(135deg, transparent 0 60%, #6b7078 60% 70%, transparent 70% 78%, #6b7078 78% 88%, transparent 88%);
      }
    }
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  // ---------------------------------------------------------------------
  // ポップアップ要素
  // ---------------------------------------------------------------------

  const popupEl = document.createElement("div");
  popupEl.className = "pr-popup pr-hidden";
  shadow.appendChild(popupEl);

  MODES.forEach((mode) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pr-mode-btn";
    btn.dataset.mode = mode.id;
    btn.innerHTML = `<span>${mode.label}</span><span class="pr-shortcut">${shortcutLabel(mode.key)}</span>`;
    btn.addEventListener("mousedown", (e) => {
      // mousedown で selection が消えるのを防ぐ
      e.preventDefault();
    });
    btn.addEventListener("click", () => {
      if (!lastSelectionInfo) return;
      hidePopup();
      runMode(mode.id, lastSelectionInfo);
    });
    popupEl.appendChild(btn);
  });

  function hidePopup() {
    popupEl.classList.add("pr-hidden");
  }

  function showPopupNearRect(rect, isCode) {
    popupEl.classList.remove("pr-hidden");
    // 提案モードの強調表示をリセットしてから設定
    popupEl.querySelectorAll(".pr-mode-btn").forEach((btn) => {
      btn.classList.toggle("pr-suggested", isCode && btn.dataset.mode === "code");
    });
    positionNear(popupEl, rect, 6);
  }

  /**
   * 要素を rect の下（入らなければ上）に、ビューポート内に収まるよう配置する。
   * @param {HTMLElement} el
   * @param {DOMRect} rect
   * @param {number} gap
   */
  function positionNear(el, rect, gap) {
    // 一旦表示してサイズを測る
    const elRect = el.getBoundingClientRect();
    const width = elRect.width || 200;
    const height = elRect.height || 80;

    let top = rect.bottom + gap;
    if (top + height > window.innerHeight) {
      top = rect.top - height - gap;
      if (top < 0) top = Math.max(4, window.innerHeight - height - 4);
    }

    let left = rect.left;
    if (left + width > window.innerWidth) {
      left = window.innerWidth - width - 4;
    }
    if (left < 4) left = 4;

    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  /**
   * 結果カードを選択範囲付近に配置する。
   * 本文が長くなってもカードが必ずビューポート内に収まるよう、
   * 上下の空きスペースの大きい側に出し、その空きに応じて max-height を設定して
   * 本文を内部スクロールさせる（画面外に隠れて読めなくなるのを防ぐ）。
   * @param {DOMRect|{top:number,bottom:number,left:number,right:number}} rect
   */
  function positionCard(rect) {
    const gap = 10;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minH = 140;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    // 手動サイズがあれば幅はそれを優先（画面内にクランプ）
    const width = userSize
      ? clamp(userSize.w, 240, vw - margin * 2)
      : Math.min(360, vw - margin * 2);

    const spaceBelow = vh - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    // 下側優先。下が狭く上の方が広ければ上に出す。
    const placeBelow = spaceBelow >= 220 || spaceBelow >= spaceAbove;

    // 一旦リセット（前回の top/bottom/height が残らないように）
    cardEl.style.top = "";
    cardEl.style.bottom = "";
    cardEl.style.height = "";
    cardEl.style.width = `${Math.round(width)}px`;

    if (userSize) {
      // 手動サイズ: 明示 height を使い、top 基準で必ず画面内に収める
      const h = clamp(userSize.h, minH, vh - margin * 2);
      cardEl.style.height = `${h}px`;
      cardEl.style.maxHeight = `${vh - margin * 2}px`;
      let top = placeBelow ? rect.bottom + gap : rect.top - gap - h;
      top = clamp(top, margin, vh - margin - h);
      cardEl.style.top = `${Math.round(top)}px`;
    } else {
      // 自動サイズ: 空きの大きい側に出し、その空きに応じて内部スクロール
      const space = Math.floor(placeBelow ? spaceBelow : spaceAbove);
      if (space < minH) {
        // 上下どちらも狭い（選択範囲が画面をほぼ占有）→ 画面いっぱいに配置
        cardEl.style.top = `${margin}px`;
        cardEl.style.bottom = `${margin}px`;
        cardEl.style.maxHeight = `${vh - margin * 2}px`;
      } else {
        cardEl.style.maxHeight = `${space}px`;
        if (placeBelow) {
          cardEl.style.top = `${Math.round(rect.bottom + gap)}px`;
        } else {
          // 選択範囲の上に下端を合わせて配置（上方向に伸び、内部スクロール）
          cardEl.style.bottom = `${Math.round(vh - rect.top + gap)}px`;
        }
      }
    }

    // 左位置（ビューポート内にクランプ）
    let left = rect.left;
    if (left + width > vw - margin) left = vw - margin - width;
    if (left < margin) left = margin;
    cardEl.style.left = `${Math.round(left)}px`;
  }

  // ---------------------------------------------------------------------
  // 結果カード要素
  // ---------------------------------------------------------------------

  const cardEl = document.createElement("div");
  cardEl.className = "pr-card pr-hidden";
  cardEl.innerHTML = `
    <div class="pr-card-header">
      <span class="pr-card-title"></span>
      <span class="pr-card-badge pr-hidden">キャッシュ</span>
      <button type="button" class="pr-icon-btn pr-copy-btn" title="コピー">⧉</button>
      <button type="button" class="pr-icon-btn pr-close-btn" title="閉じる">×</button>
    </div>
    <div class="pr-card-body"></div>
    <div class="pr-card-footer"></div>
    <div class="pr-resize" title="ドラッグでサイズ変更（ダブルクリックで既定に戻す）"></div>
  `;
  shadow.appendChild(cardEl);

  const cardTitleEl = cardEl.querySelector(".pr-card-title");
  const cardBadgeEl = cardEl.querySelector(".pr-card-badge");
  const cardBodyEl = cardEl.querySelector(".pr-card-body");
  const cardFooterEl = cardEl.querySelector(".pr-card-footer");
  const cardHeaderEl = cardEl.querySelector(".pr-card-header");
  const copyBtn = cardEl.querySelector(".pr-copy-btn");
  const closeBtn = cardEl.querySelector(".pr-close-btn");
  const resizeHandle = cardEl.querySelector(".pr-resize");

  MODES.forEach((mode) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.mode = mode.id;
    btn.textContent = mode.label;
    btn.addEventListener("click", () => {
      if (!lastSelectionInfo) return;
      runMode(mode.id, lastSelectionInfo);
    });
    cardFooterEl.appendChild(btn);
  });

  function setActiveFooterButton(mode) {
    cardFooterEl.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("pr-active", btn.dataset.mode === mode);
    });
  }

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(answerBuffer);
      const original = copyBtn.textContent;
      copyBtn.textContent = "✓";
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1000);
    } catch {
      // クリップボード API が使えない環境では黙って無視
    }
  });

  closeBtn.addEventListener("click", () => {
    hideCard();
  });

  function hideCard() {
    cardEl.classList.add("pr-hidden");
    closePort();
  }

  function showCard() {
    cardEl.classList.remove("pr-hidden");
  }

  // ---- カードのドラッグ移動 ----
  (function enableDrag() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    cardHeaderEl.addEventListener("pointerdown", (e) => {
      // ヘッダー上のボタン自体はドラッグ対象から除外
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = cardEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      // bottom アンカー配置を解除して top 基準のドラッグに切り替える
      cardEl.style.bottom = "auto";
      cardEl.style.left = `${rect.left}px`;
      cardEl.style.top = `${rect.top}px`;
      try {
        cardHeaderEl.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    });

    cardHeaderEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = startLeft + dx;
      let top = startTop + dy;
      const rect = cardEl.getBoundingClientRect();
      const width = rect.width || 360;
      const height = rect.height || 200;
      left = Math.min(Math.max(left, -width + 60), window.innerWidth - 60);
      top = Math.min(Math.max(top, 0), window.innerHeight - 40);
      cardEl.style.left = `${Math.round(left)}px`;
      cardEl.style.top = `${Math.round(top)}px`;
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try {
        cardHeaderEl.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    }

    cardHeaderEl.addEventListener("pointerup", endDrag);
    cardHeaderEl.addEventListener("pointercancel", endDrag);
  })();

  // ---- カードのリサイズ（右下グリップ、ウィンドウのように伸縮） ----
  (function enableResize() {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startLeft = 0;
    let startTop = 0;

    resizeHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      const rect = cardEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      // top 基準に固定し、高さを明示制御できるようにする
      cardEl.style.bottom = "auto";
      cardEl.style.top = `${rect.top}px`;
      cardEl.style.left = `${rect.left}px`;
      cardEl.style.maxHeight = `${window.innerHeight - 16}px`;
      cardEl.style.height = `${rect.height}px`;
      cardEl.style.width = `${rect.width}px`;
      try {
        resizeHandle.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    });

    resizeHandle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const margin = 8;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxW = window.innerWidth - startLeft - margin;
      const maxH = window.innerHeight - startTop - margin;
      const w = Math.max(240, Math.min(startW + dx, maxW));
      const h = Math.max(120, Math.min(startH + dy, maxH));
      cardEl.style.width = `${Math.round(w)}px`;
      cardEl.style.height = `${Math.round(h)}px`;
      // 手動サイズとして記憶（以降の表示・再実行でも維持）
      userSize = { w: Math.round(w), h: Math.round(h) };
    });

    function endResize(e) {
      if (!resizing) return;
      resizing = false;
      try {
        resizeHandle.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    }

    resizeHandle.addEventListener("pointerup", endResize);
    resizeHandle.addEventListener("pointercancel", endResize);

    // ダブルクリックで自動サイズに戻す
    resizeHandle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      userSize = null;
      cardEl.style.height = "";
      if (lastSelectionInfo && lastSelectionInfo.rect) {
        positionCard(lastSelectionInfo.rect);
      }
    });
  })();

  // ---------------------------------------------------------------------
  // 選択検知・コード判定
  // ---------------------------------------------------------------------

  /** 選択テキストがコードっぽいかどうかのヒューリスティック判定 */
  function looksLikeCode(text, anchorNode) {
    if (!text) return false;

    // <pre>/<code> 内にあるか
    try {
      const el = anchorNode && anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
      if (el && el.closest && el.closest("pre, code")) return true;
    } catch {
      /* noop */
    }

    const lineCount = text.split("\n").length;
    const hasSymbols = /[{}();]/.test(text);
    const hasCodeTokens = /\b(function|const|let|var|return|import|class|def|=>|public|private|static|void|int\s)\b/.test(
      text
    );

    if (lineCount >= 2 && (hasSymbols || hasCodeTokens)) return true;
    if (hasSymbols && hasCodeTokens) return true;
    return false;
  }

  /** 選択範囲を含む最も近いブロック要素を探す */
  function findBlockAncestor(node) {
    const blockTags = new Set(["P", "LI", "PRE", "DIV", "SECTION", "ARTICLE", "TD", "TH", "BLOCKQUOTE", "MAIN"]);
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
      if (blockTags.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  /** テキストの空白を1つに畳み、指定長で切り詰める */
  function collapseAndTruncate(text, maxLen) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
  }

  let debounceTimer = null;

  function onSelectionMaybeChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleSelection, 150);
  }

  function handleSelection() {
    if (!enabled) {
      hidePopup();
      return;
    }
    // 自分のカード/ポップアップ内のクリックによる選択は無視
    const active = document.activeElement;
    if (active === host) return;

    let sel;
    try {
      sel = window.getSelection();
    } catch {
      return;
    }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hidePopup();
      return;
    }

    const text = sel.toString().trim();
    if (!text) {
      hidePopup();
      return;
    }

    let range;
    let rect;
    try {
      range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
    } catch {
      hidePopup();
      return;
    }

    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hidePopup();
      return;
    }

    const anchorNode = sel.anchorNode;
    const blockEl = findBlockAncestor(anchorNode);
    const paragraph = collapseAndTruncate(blockEl ? blockEl.textContent || "" : "", 1200);

    lastSelectionInfo = {
      selection: text,
      context: {
        paragraph,
        title: document.title || "",
        url: location.href,
      },
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
    };

    const isCode = looksLikeCode(text, anchorNode);
    showPopupNearRect(rect, isCode);
  }

  document.addEventListener("mouseup", onSelectionMaybeChanged, true);
  document.addEventListener("selectionchange", onSelectionMaybeChanged);

  // スクロール時はポップアップを隠す（カードは維持: ドラッグ後の追従は行わない）
  window.addEventListener(
    "scroll",
    () => {
      hidePopup();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hidePopup();
      hideCard();
    }
  });

  // ポップアップ/カード以外をクリックしたら閉じる
  document.addEventListener(
    "mousedown",
    (e) => {
      // shadow host 内のクリックはここには来ない（別ツリーのため e.target は host になる）
      if (e.target === host) return;
      hidePopup();
    },
    true
  );

  // ---------------------------------------------------------------------
  // Service Worker とのメッセージング
  // ---------------------------------------------------------------------

  /** chrome.* 呼び出しを安全にラップする（context invalidated 対策） */
  function safeSendMessage(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // extension context invalidated 等のエラーは lastError で受け取る
        if (chrome.runtime.lastError) {
          callback && callback(null);
          return;
        }
        callback && callback(response);
      });
    } catch {
      callback && callback(null);
    }
  }

  safeSendMessage({ type: "getState" }, (response) => {
    if (response && typeof response.enabled === "boolean") {
      enabled = response.enabled;
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "setEnabled") {
        enabled = !!message.enabled;
        if (!enabled) {
          hidePopup();
          hideCard();
        }
      } else if (message.type === "triggerMode") {
        if (!enabled) return;
        // 現在の選択を再取得（ショートカット発火時点の選択を使う）
        handleSelection();
        if (lastSelectionInfo && lastSelectionInfo.selection) {
          runMode(message.mode, lastSelectionInfo);
        }
      }
    });
  } catch {
    // content script 読み込みタイミング等で chrome.runtime が使えない場合は無視
  }

  // ---------------------------------------------------------------------
  // モード実行（Port によるストリーミング）
  // ---------------------------------------------------------------------

  function closePort() {
    if (activePort) {
      try {
        activePort.disconnect();
      } catch {
        /* noop */
      }
    }
    activePort = null;
    activeRequestId = null;
  }

  function renderBody() {
    try {
      cardBodyEl.innerHTML = window.PranslateMarkdown.render(answerBuffer);
    } catch {
      cardBodyEl.textContent = answerBuffer;
    }
  }

  function showLoading() {
    cardBodyEl.innerHTML = `<div class="pr-loading"><span class="pr-spinner"></span><span>生成中...</span></div>`;
  }

  function showError(message, mode, info) {
    cardBodyEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "pr-error";
    const msg = document.createElement("div");
    msg.textContent = message || "エラーが発生しました。";
    wrap.appendChild(msg);
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "pr-retry";
    retryBtn.textContent = "再試行";
    retryBtn.addEventListener("click", () => {
      runMode(mode, info);
    });
    wrap.appendChild(retryBtn);
    cardBodyEl.appendChild(wrap);
  }

  /**
   * 指定モードで現在の選択情報に対するリクエストを実行する。
   * @param {"translate"|"code"|"term"} mode
   * @param {{selection:string, context:object, rect:object}} info
   */
  function runMode(mode, info) {
    if (!info || !info.selection) return;

    // 直前のリクエストがあれば閉じる
    closePort();

    answerBuffer = "";
    cardTitleEl.textContent = MODE_LABELS[mode] || mode;
    cardBadgeEl.classList.add("pr-hidden");
    setActiveFooterButton(mode);
    showLoading();

    // カードを選択範囲の近くに、必ず画面内に収まるよう表示する
    showCard();
    positionCard(info.rect);

    let requestId;
    try {
      requestId = crypto.randomUUID();
    } catch {
      requestId = `pr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    let port;
    try {
      port = chrome.runtime.connect({ name: "pranslate" });
    } catch {
      showError("拡張機能との接続に失敗しました。ページを再読み込みしてください。", mode, info);
      return;
    }

    activePort = port;
    activeRequestId = requestId;

    port.onMessage.addListener((msg) => {
      if (!msg || msg.requestId !== activeRequestId) return;
      if (msg.type === "chunk") {
        answerBuffer += msg.text || "";
        renderBody();
      } else if (msg.type === "done") {
        answerBuffer = typeof msg.fullText === "string" ? msg.fullText : answerBuffer;
        renderBody();
        cardBadgeEl.classList.toggle("pr-hidden", !msg.cached);
      } else if (msg.type === "error") {
        showError(msg.message, mode, info);
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) {
        activePort = null;
        activeRequestId = null;
      }
    });

    try {
      port.postMessage({
        type: "run",
        requestId,
        mode,
        selection: info.selection,
        context: info.context,
      });
    } catch {
      showError("メッセージの送信に失敗しました。", mode, info);
    }
  }
})();
