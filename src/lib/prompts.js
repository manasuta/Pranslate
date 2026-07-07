/**
 * Pranslate プロンプト設計モジュール
 *
 * 3つのモード（translate / code / term）に応じて、Gemini API に渡す
 * systemInstruction と userText を組み立てる。依存ライブラリなし。
 */

/**
 * 共通システムプロンプト。
 * 短く・繰り返さず・前置きなしで答えることを徹底させる。
 */
export const SYSTEM_PROMPT = [
  "あなたは、英語のプログラミング教材を読む日本語話者の学習を助けるアシスタントです。",
  "選択テキストと文脈をもとに、短く簡潔に Markdown で答えてください。",
  "ルール:",
  "- 入力（英文や選択テキスト）をそのまま再掲しない。",
  "- 前置き・挨拶・謝罪・締めの一言は書かない。答えだけを返す。",
  "- できるだけコンパクトに。冗長な説明や不要な箇条書きは避ける。",
  "- Markdown は最小限に使う。コードはコードフェンスで囲む。",
].join("\n");

/**
 * モード別の追加指示。
 * translate: 訳のみ / code: コードの動作説明 / term: 用語のやさしい解説
 */
const MODE_INSTRUCTIONS = {
  translate:
    "タスク: 選択テキストの自然な日本語訳のみを返す。解説・注釈・英文の再掲は一切不要。",
  code:
    "タスク: 選択されたコードが何をするかを簡潔に説明する。まず1行で要点、必要なら短い補足を2〜3行まで。",
  term:
    "タスク: 選択された用語・概念を、初学者にも分かるよう、やさしく簡潔に解説する。2〜4文程度を目安にする。",
};

/**
 * 文字列でない・未定義のフィールドを空文字として扱うためのガード。
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * モードとページ情報から Gemini API 用のメッセージを組み立てる。
 *
 * @param {"translate"|"code"|"term"} mode 説明モード（不明な値は "term" にフォールバック）
 * @param {{ selection?: string, paragraph?: string, title?: string, url?: string }} payload
 *   selection: ユーザーが選択したテキスト（処理対象）
 *   paragraph: 選択箇所を含む周辺段落（文脈）
 *   title: ページタイトル / url: ページ URL
 * @returns {{ systemInstruction: string, userText: string }}
 */
export function buildMessages(mode, payload) {
  // 未知のモードは用語解説として扱う（最も汎用的で安全なため）
  const instruction = MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.term;
  const systemInstruction = `${SYSTEM_PROMPT}\n\n${instruction}`;

  const p = payload && typeof payload === "object" ? payload : {};
  const title = toText(p.title);
  const url = toText(p.url);
  const paragraph = toText(p.paragraph);
  const selection = toText(p.selection);

  // ラベル付きの区切りで「文脈」と「処理対象の選択テキスト」を明確に分ける
  const lines = [];
  if (title) lines.push(`ページタイトル: ${title}`);
  if (url) lines.push(`URL: ${url}`);
  if (paragraph) {
    lines.push("", "【文脈（選択箇所を含む段落）】", paragraph);
  }
  lines.push("", "【選択テキスト（これに対して答える）】", selection);

  return { systemInstruction, userText: lines.join("\n").trim() };
}
