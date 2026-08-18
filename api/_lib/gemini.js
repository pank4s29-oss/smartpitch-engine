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

// 每次嘗試的 fetch timeout。刻意壓在較短的秒數，讓「重試 + 跨供應商備援」的總耗時
// 仍能落在呼叫端 Vercel 函式的 maxDuration 預算內（suggest.js 45s／generation-requests 60s）。
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 8000);

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

// 帶 timeout 的 fetch。原本的版本完全沒有設定 timeout，Google 那端一旦變慢，
// 這個 fetch 會一直掛著，直到 Vercel 平台自己在 maxDuration 到點時把整支函式砍掉，
// 變成使用者端看到的 504（而且因為是平台層砍斷，不會進到我們的 catch，拿不到有意義的錯誤訊息）。
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

async function requestGemini(model, { system, prompt, maxTokens }) {
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
    REQUEST_TIMEOUT_MS
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
    // 通常是 maxOutputTokens 額度被 thinking 佔滿，或本身被截斷成空字串。
    // 明確丟錯，避免呼叫端把空字串丟給 JSON.parse 產生看不懂的「Unexpected end of JSON input」。
    throw new Error(
      `Gemini 回應內容為空（finishReason: ${candidate.finishReason || '未知'}）。` +
      '常見原因是 maxOutputTokens 額度被思考過程用完，可提高呼叫時的 maxTokens 再試一次。'
    );
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    // 原本這裡只有 console.warn，仍把截斷的文字丟回去，導致呼叫端的 JSON.parse 對著不完整的
    // JSON 失敗、丟出看不出原因的 SyntaxError。現在直接在這裡截斷失敗，錯誤訊息才會講清楚原因。
    throw new Error(
      'Gemini 回應被截斷（maxOutputTokens 額度用完，finishReason: MAX_TOKENS）。' +
      '請提高呼叫時的 maxTokens 後再試一次。'
    );
  }
  return text;
}

// 呼叫 Gemini：429/503（含 body 內對應的 error.code / error.status）這類暫時性錯誤會自動重試，
// 重試間隔採指數退避；主模型 + 備援模型都失敗後，若有設定 ANTHROPIC_API_KEY，最後改打 Claude 當
// 跨供應商備援，避免單一供應商過載就讓整個功能掛掉。
// 非暫時性錯誤（例如金鑰無效、模型不存在／已下架、request 格式錯誤）不重試，直接丟出，
// 因為換模型或跨供應商也解決不了同一個請求本身的問題。
async function callGemini({ system, prompt, maxTokens = 3000 }) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 GEMINI_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }

  // 指數退避：0ms → 800ms → 2000ms。搭配每次嘗試 REQUEST_TIMEOUT_MS（預設 8s）的上限，
  // 3 次嘗試的最壞情況總耗時約 8+0.8+8+2+8 ≈ 26.8 秒，在 suggest.js（45s）與
  // generation-requests（60s）的 maxDuration 預算內都還留有緩衝。
  const attempts = [
    { model: GEMINI_MODEL, delayBefore: 0 },
    { model: GEMINI_MODEL, delayBefore: 800 },
    { model: GEMINI_FALLBACK_MODEL, delayBefore: 2000 },
  ];

  let lastErrorText = '';
  for (let i = 0; i < attempts.length; i++) {
    const { model, delayBefore } = attempts[i];
    if (delayBefore) await new Promise(r => setTimeout(r, delayBefore));

    let res;
    try {
      res = await requestGemini(model, { system, prompt, maxTokens });
    } catch (err) {
      // fetchWithTimeout 對逾時丟出的錯誤帶有 retryable 標記，當作跟 429/503 同等對待。
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
      // 非暫時性錯誤（例如金鑰無效、模型不存在／已下架、request 格式錯誤）不重試，直接丟出。
      throw new Error('Gemini API 呼叫失敗：' + text);
    }
    // 429/503（或 body 內對應碼）：繼續下一次嘗試
  }

  // 主模型與備援模型都用盡重試預算，若有設定 Claude 金鑰，最後試一次跨供應商備援。
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { callClaude } = require('./anthropic');
      console.warn('Gemini 主模型與備援模型皆過載，改用 Claude 作為跨供應商備援。');
      return await callClaude({ system, prompt, maxTokens });
    } catch (fallbackErr) {
      throw new Error(
        `Gemini API 呼叫失敗（主模型與備援模型 ${GEMINI_FALLBACK_MODEL} 皆過載或被限流，已重試 ${attempts.length} 次），` +
        `跨供應商備援 Claude 也失敗：${fallbackErr.message}。原始 Gemini 錯誤：${lastErrorText}`
      );
    }
  }

  throw new Error(
    `Gemini API 呼叫失敗（主模型與備援模型 ${GEMINI_FALLBACK_MODEL} 皆過載或被限流，已重試 ${attempts.length} 次）：` + lastErrorText
  );
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callGemini, parseJSON };
