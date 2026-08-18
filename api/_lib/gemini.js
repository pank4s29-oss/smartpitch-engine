const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 2026/08 現行穩定版本；gemini-2.5-flash-lite 即將於 10 月停用，不要用它。
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
// 主模型撞到 429（頻率限制）／503（過載）時，最後改打這個備援模型。
// gemini-2.5-flash 已被 Google 下架（新申請的 key 打不到），改用官方目前推薦的 3.6。
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';

// Gemini 3.x 系列預設會先做一段「思考」再輸出，thinking 會吃掉 maxOutputTokens 的額度。
// 我們這三個呼叫情境（建議草稿／文案生成／範例文案分類）都是照格式輸出結構化 JSON，
// 不需要深度推理，把 thinking 壓到最低，把 token 額度留給真正要的輸出。
// 注意：gemini-3.7-flash 不支援 MINIMAL，只能用 LOW/MEDIUM/HIGH；LOW 是目前所有 3.x 模型都支援的最低值。
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'LOW';

// 沒有呼叫端明確傳入 budgetMs 時的保守預設值。
const DEFAULT_BUDGET_MS = Number(process.env.GEMINI_DEFAULT_BUDGET_MS || 25000);
// 單次嘗試 timeout 的下限／上限。
const MIN_ATTEMPT_TIMEOUT_MS = 12000;
const MAX_ATTEMPT_TIMEOUT_MS = 35000;
const MS_PER_TOKEN = 4; // 粗估：maxTokens * 4ms 作為單次嘗試該給的基準時間

// ── 修正重點 ──────────────────────────────────────────────────────────
// 舊版做法：Gemini 三次嘗試（含重試間隔）把 budgetMs「用剩多少算多少」，
// 最後才檢查剩餘時間夠不夠 4 秒去試 Claude。
// 問題：3 次 12000ms 的嘗試 + 兩次重試間隔（800+1500ms）加起來就接近 38 秒，
// 在 40 秒的總預算下，Gemini 自己幾乎榨乾了全部時間，導致跨供應商備援
// 「理論上有機會用，但實際上永遠輪不到」——這正是你這次遇到的狀況。
//
// 新版做法：一開始就把一段固定的時間保留給 Claude 備援（前提是有設定
// ANTHROPIC_API_KEY），Gemini 的重試迴圈只能使用「總預算 - 保留額度」，
// 保證備援一定有真正可用、足夠讓 Claude 完成一次呼叫的時間，而不是
// 撿 Gemini 用剩的零頭。
const FALLBACK_RESERVE_RATIO = 0.3;
const FALLBACK_RESERVE_MIN_MS = 6000;
const FALLBACK_RESERVE_MAX_MS = 15000;
// ──────────────────────────────────────────────────────────────────────

// HTTP 傳輸層狀態碼視為可重試。
const RETRYABLE_STATUS = new Set([429, 503]);
// Google 有時候會在 body 裡巢狀回報的 error.code / error.status 跟外層 HTTP status 對不上
// （尤其高負載時，前面的 gateway 有時候用別的狀態碼包住同一個 body），
// 所以判斷是否重試時，兩邊都要看，只要有一邊命中就當作可重試。
const RETRYABLE_BODY_STATUS = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED']);

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 帶 timeout 的 fetch。
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`Gemini API 呼叫逾時（超過 ${timeoutMs}ms 無回應）`), { retryable: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requestGemini(model, { system, prompt, maxTokens }, timeoutMs) {
  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
        safetySettings: SAFETY_SETTINGS,
      }),
    },
    timeoutMs
  );
}

// 判斷這次失敗的回應是否值得重試：HTTP status 或 body 內的 error.code / error.status 有一邊命中就算。
function isRetryableResponse(status, bodyText) {
  if (RETRYABLE_STATUS.has(status)) return true;
  try {
    const parsed = JSON.parse(bodyText);
    const code = parsed && parsed.error && parsed.error.code;
    const bodyStatus = parsed && parsed.error && parsed.error.status;
    if (RETRYABLE_STATUS.has(code)) return true;
    if (bodyStatus && RETRYABLE_BODY_STATUS.has(bodyStatus)) return true;
  } catch (_) {
    // body 不是 JSON，就只看 HTTP status。
  }
  return false;
}

// 把成功回應轉成純文字（呼叫端自行決定是否解析 JSON）。丟出的錯誤都是「不該重試」的錯誤。
async function extractText(res) {
  const data = await res.json();
  if (!data.candidates || !data.candidates.length) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error('Gemini 未回傳內容' + (reason ? `（被安全過濾擋下：${reason}）` : '：' + JSON.stringify(data)));
  }
  const candidate = data.candidates[0];
  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini 回應被安全過濾擋下（finishReason: SAFETY）。');
  }

  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map(p => p.text || '').join('\n');

  if (!text.trim()) {
    throw new Error(
      `Gemini 回應內容為空（finishReason: ${candidate.finishReason || '未知'}）。` +
      '常見原因是 maxOutputTokens 額度被思考過程用完，可提高呼叫時的 maxTokens 再試一次。'
    );
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error(
      'Gemini 回應被截斷（maxOutputTokens 額度用完，finishReason: MAX_TOKENS）。' +
      '請提高呼叫時的 maxTokens 後再試一次。'
    );
  }
  return text;
}

function computeAttemptTimeout(maxTokens, remainingBudgetMs) {
  const base = Math.min(Math.max(maxTokens * MS_PER_TOKEN, MIN_ATTEMPT_TIMEOUT_MS), MAX_ATTEMPT_TIMEOUT_MS);
  // 留 500ms 安全邊界給後續處理（例如把結果轉成文字、丟回呼叫端）。
  return Math.max(2000, Math.min(base, remainingBudgetMs - 500));
}

// 依總預算與是否有跨供應商備援可用，算出這次要保留給 Claude 的時間。
// 沒有設定 ANTHROPIC_API_KEY 就不用保留，把整個預算讓給 Gemini 重試。
function computeFallbackReserve(totalBudget) {
  if (!process.env.ANTHROPIC_API_KEY) return 0;
  const target = totalBudget * FALLBACK_RESERVE_RATIO;
  return Math.min(FALLBACK_RESERVE_MAX_MS, Math.max(FALLBACK_RESERVE_MIN_MS, target));
}

// 呼叫 Gemini：429/503（含 body 內對應的 error.code / error.status）與逾時都視為暫時性錯誤會自動重試。
// budgetMs：這次呼叫（含所有重試與跨供應商備援）總共能花多少時間，由呼叫端依自己在 vercel.json
// 設定的 maxDuration 減去其他開銷（讀寫資料庫等）後算出，避免整體耗時超過函式的執行時限。
//
// 重點修正：Gemini 自己的重試迴圈只會使用「總預算 - 保留給 Claude 的額度」，
// 不會像舊版一樣把整個 budgetMs 都花在 Gemini 上，導致備援永遠沒有真正可用的時間。
async function callGemini({ system, prompt, maxTokens = 3000, budgetMs }) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 GEMINI_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }

  const totalBudget = budgetMs || DEFAULT_BUDGET_MS;
  const fallbackReserve = computeFallbackReserve(totalBudget);
  const geminiBudget = totalBudget - fallbackReserve;

  const start = Date.now();
  const plan = [
    { model: GEMINI_MODEL, delayBefore: 0 },
    { model: GEMINI_MODEL, delayBefore: 800 },
    { model: GEMINI_FALLBACK_MODEL, delayBefore: 1500 },
  ];

  let lastErrorText = '';
  for (let i = 0; i < plan.length; i++) {
    const { model, delayBefore } = plan[i];

    // 注意：這裡用 geminiBudget（已扣掉保留額度），不是 totalBudget。
    let remaining = geminiBudget - (Date.now() - start);
    if (remaining < 3000) break; // 剩餘的 Gemini 額度太少，再嘗試也只會被強制中斷，不值得

    if (delayBefore) {
      await sleep(Math.min(delayBefore, Math.max(remaining - 2000, 0)));
      remaining = geminiBudget - (Date.now() - start);
      if (remaining < 3000) break;
    }

    const attemptTimeout = computeAttemptTimeout(maxTokens, remaining);

    let res;
    try {
      res = await requestGemini(model, { system, prompt, maxTokens }, attemptTimeout);
    } catch (err) {
      if (err.retryable) {
        lastErrorText = err.message;
        continue;
      }
      throw err;
    }

    if (res.ok) {
      if (model !== GEMINI_MODEL) console.warn(`Gemini 主模型（${GEMINI_MODEL}）過載，已改用備援模型 ${model} 成功回應。`);
      return extractText(res);
    }

    const text = await res.text();
    lastErrorText = text;
    if (!isRetryableResponse(res.status, text)) {
      throw new Error('Gemini API 呼叫失敗：' + text);
    }
    // 429/503（或 body 內對應碼）：繼續下一次嘗試
  }

  // Gemini 兩個模型都失敗（或 Gemini 自己的額度已耗盡）。
  // 因為一開始就保留了 fallbackReserve，這裡理論上一定還有夠用的時間可以試 Claude
  // （除非 fallbackReserve 本身是 0，也就是沒有設定 ANTHROPIC_API_KEY）。
  const remainingForFallback = totalBudget - (Date.now() - start);
  if (process.env.ANTHROPIC_API_KEY && remainingForFallback > 4000) {
    try {
      const { callClaude } = require('./anthropic');
      console.warn('Gemini 主模型與備援模型皆過載或逾時，改用 Claude 作為跨供應商備援。');
      return await callClaude({ system, prompt, maxTokens, timeoutMs: remainingForFallback - 500 });
    } catch (fallbackErr) {
      throw new Error(
        `Gemini API 呼叫失敗（主模型與備援模型 ${GEMINI_FALLBACK_MODEL} 皆過載或逾時），` +
        `跨供應商備援 Claude 也失敗：${fallbackErr.message}。原始 Gemini 錯誤：${lastErrorText}`
      );
    }
  }

  throw new Error(
    `Gemini API 呼叫失敗（主模型與備援模型 ${GEMINI_FALLBACK_MODEL} 皆過載或逾時，已在預算內盡可能重試）：` + lastErrorText
  );
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callGemini, parseJSON };
