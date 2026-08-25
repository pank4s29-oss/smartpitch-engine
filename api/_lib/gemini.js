const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 2026/08 現行穩定版本；gemini-2.5-flash-lite 即將於 10 月停用，不要用它。
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// 主模型撞到 429（頻率限制）／503（過載）時，最後改打這個備援模型。
// gemini-2.5-flash 已被 Google 下架（新申請的 key 打不到），改用官方目前推薦的 3.6。
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.7-flash';

// Gemini 3.x 系列預設會先做一段「思考」再輸出，thinking 會吃掉 maxOutputTokens 的額度。
// 我們這三個呼叫情境（建議草稿／文案生成／範例文案分類）都是照格式輸出結構化 JSON，
// 不需要深度推理，把 thinking 壓到最低，把 token 額度留給真正要的輸出。
// 注意：gemini-3.7-flash 不支援 MINIMAL，只能用 LOW/MEDIUM/HIGH；LOW 是目前所有 3.x 模型都支援的最低值。
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'LOW';

// 沒有呼叫端明確傳入 budgetMs 時的保守預設值。
const DEFAULT_BUDGET_MS = Number(process.env.GEMINI_DEFAULT_BUDGET_MS || 25000);

// ── 修正重點 1 ────────────────────────────────────────────────────────
// 舊版 computeAttemptTimeout 用「maxTokens * MS_PER_TOKEN」估算單次該等多久，
// 對 maxTokens 較小的請求（例如 suggest.js 的 800）估出來的值遠低於
// MIN_ATTEMPT_TIMEOUT_MS，於是永遠被下限鎖死在 12000ms——即使呼叫端傳進來的
// budgetMs 明明還有 40 秒空間，也完全沒被拿來延長單次等待時間。
// 而 Google 官方目前處於高負載狀態，正常回應可能要 10~20 幾秒，用 12 秒去等，
// 幾乎注定會在 Gemini 真正回應之前就先被我們自己 abort 掉。
//
// 新做法：單次逾時改成「剩餘預算 ÷ 剩餘嘗試次數」（fair share），並取
// token 估算值與 fair share 兩者中較大的一個，確保只要預算夠，每次嘗試
// 都會拿到接近「這次呼叫剩餘時間允許的最大值」，而不是被一個跟 budget
// 無關的下限卡死。
const MIN_ATTEMPT_TIMEOUT_MS = 12000;
const MAX_ATTEMPT_TIMEOUT_MS = 35000;
const MS_PER_TOKEN = 4; // 粗估：maxTokens * 4ms 作為單次嘗試該給的基準時間下限

// ── 修正重點 2 ────────────────────────────────────────────────────────
// 目前沒有接 ANTHROPIC_API_KEY 跨供應商備援，完全靠 Gemini 自己扛。
// 在同一個過載的主模型上重試兩次，不如把預算分給主模型與備援模型各一次、
// 但每次都給足夠長的等待時間——兩個不同模型各試一次夠久的機會，
// 通常比同一個模型試兩次太短的機會更容易成功。
const PLAN = [
  { model: GEMINI_MODEL, delayBefore: 0 },
  { model: GEMINI_FALLBACK_MODEL, delayBefore: 1000 },
];

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

// 診斷用：把 HTTP status / body 內的 error.status 轉成人類可讀的分類。
// 429/RESOURCE_EXHAUSTED＝你自己的用量已經超過 RPM/TPM/RPD 額度（免費額度尤其容易撞到，
// 目前 gemini-3.x flash 系列免費額度大約只有 10 RPM），這是「量」的問題，重試通常沒用；
// 503/UNAVAILABLE 才是 Google 那邊真的撐不住，屬於暫時性問題，重試才有意義。
function classifyFailure(status, bodyText) {
  let bodyStatus = null, bodyCode = null;
  try {
    const parsed = JSON.parse(bodyText);
    bodyStatus = parsed && parsed.error && parsed.error.status;
    bodyCode = parsed && parsed.error && parsed.error.code;
  } catch (_) { /* body 不是 JSON */ }
  if (status === 429 || bodyStatus === 'RESOURCE_EXHAUSTED' || bodyCode === 429) {
    return 'QUOTA_EXCEEDED（配額/速率限制已用盡，通常是免費額度的 RPM 或 RPD 上限，重試沒有用，要等額度恢復或升級付費層）';
  }
  if (status === 503 || bodyStatus === 'UNAVAILABLE' || bodyCode === 503) {
    return 'SERVICE_OVERLOADED（Google 那端真的過載，屬於暫時性問題，值得重試）';
  }
  return `UNKNOWN（HTTP ${status}${bodyStatus ? '／body status: ' + bodyStatus : ''}）`;
}

// 把成功回應轉成純文字（呼叫端自行決定是否解析 JSON）。
// 注意：res.json() 失敗（HTTP body 不完整）視為「暫時性、可重試」的錯誤；
// 其餘（被安全過濾擋下、內容被截斷、內容為空）是模型本身輸出的問題，
// 換一次模型未必會改善，但仍值得讓上層重試迴圈去換下一個模型試試看，
// 因此這裡統一都標記 retryable，交由呼叫端決定要不要繼續嘗試。
async function extractText(res) {
  let data;
  try {
    data = await res.json();
  } catch (err) {
    // 常見於 Google 高負載時 gateway 提前切斷連線、回傳不完整的 body，
    // 此時 HTTP status 可能仍是 200，但 body 被腰斬，JSON.parse 會丟出
    // 「Unexpected end of JSON input」。這是暫時性錯誤，值得重試。
    throw Object.assign(
      new Error('Gemini 回應內容不完整（HTTP body 可能被提前截斷，常見於高負載時）：' + err.message),
      { retryable: true }
    );
  }
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

// 單次嘗試該給多久：token 估算值（下限用）與「剩餘預算平均分給剩餘嘗試次數」
// 兩者取較大值，確保只要預算夠，就不會被一個跟 budget 無關的下限卡死。
function computeAttemptTimeout(maxTokens, remainingBudgetMs, attemptsLeft) {
  const tokenBased = Math.min(Math.max(maxTokens * MS_PER_TOKEN, MIN_ATTEMPT_TIMEOUT_MS), MAX_ATTEMPT_TIMEOUT_MS);
  const usableBudget = Math.max(0, remainingBudgetMs - 500); // 留 500ms 安全邊界給後續處理
  const fairShare = Math.floor(usableBudget / Math.max(1, attemptsLeft));
  const timeout = Math.min(MAX_ATTEMPT_TIMEOUT_MS, Math.max(tokenBased, fairShare));
  return Math.max(2000, Math.min(timeout, usableBudget));
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
async function callGemini({ system, prompt, maxTokens = 3000, budgetMs }) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 GEMINI_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }

  const totalBudget = budgetMs || DEFAULT_BUDGET_MS;
  const fallbackReserve = computeFallbackReserve(totalBudget);
  const geminiBudget = totalBudget - fallbackReserve;

  const start = Date.now();

  let lastErrorText = '';
  let hadQuotaExceeded = false; // 是否曾遇到 429/RESOURCE_EXHAUSTED——這種情況重試沒有意義，要如實告知使用者
  for (let i = 0; i < PLAN.length; i++) {
    const { model, delayBefore } = PLAN[i];
    const attemptsLeft = PLAN.length - i;

    // 注意：這裡用 geminiBudget（已扣掉保留給 Claude 的額度），不是 totalBudget。
    let remaining = geminiBudget - (Date.now() - start);
    if (remaining < 3000) break; // 剩餘的 Gemini 額度太少，再嘗試也只會被強制中斷，不值得

    if (delayBefore) {
      await sleep(Math.min(delayBefore, Math.max(remaining - 2000, 0)));
      remaining = geminiBudget - (Date.now() - start);
      if (remaining < 3000) break;
    }

    const attemptTimeout = computeAttemptTimeout(maxTokens, remaining, attemptsLeft);

    const attemptStart = Date.now();
    let res;
    try {
      res = await requestGemini(model, { system, prompt, maxTokens }, attemptTimeout);
    } catch (err) {
      const elapsed = Date.now() - attemptStart;
      console.error(`[gemini] 嘗試 #${i + 1} model=${model} timeout=${attemptTimeout}ms 實際耗時=${elapsed}ms → 逾時（分類：TIMEOUT，可能是 attemptTimeout 太短，也可能是 Google 那端真的很慢）`);
      if (err.retryable) {
        lastErrorText = err.message;
        continue;
      }
      throw err;
    }

    if (res.ok) {
      try {
        const text = await extractText(res);
        // 驗證這次輸出本身是不是合法 JSON。Gemini 在高負載／thinking 預算緊繃時，
        // finishReason 有時候不會正確回報成 MAX_TOKENS，但實際輸出的 JSON 仍然是
        // 卡在某個屬性中間、沒有正常收尾的半成品。與其把這個半成品往外送，讓呼叫端
        // 在完全不同的檔案裡才 JSON.parse 失敗、丟出看不出原因的
        // 「Unexpected end of JSON input」，不如在這裡就先驗證過：驗證失敗就當作
        // 這次嘗試失敗，繼續換下一個模型重試，同時把原始內容記下來方便除錯。
        try {
          parseJSON(text);
        } catch (parseErr) {
          console.error(
            `[gemini] 嘗試 #${i + 1} model=${model} 輸出不是合法 JSON（很可能是輸出被截斷，` +
            `但 Google 未正確回報 finishReason:MAX_TOKENS）：${parseErr.message}\n` +
            `原始輸出（前 500 字，供除錯用）：${text.slice(0, 500)}`
          );
          lastErrorText = `模型輸出的 JSON 格式不完整：${parseErr.message}`;
          continue;
        }
        if (model !== GEMINI_MODEL) console.warn(`Gemini 主模型（${GEMINI_MODEL}）過載，已改用備援模型 ${model} 成功回應。`);
        return text;
      } catch (err) {
        console.error(`[gemini] 嘗試 #${i + 1} model=${model} HTTP 200 但內容解析失敗：${err.message}`);
        if (err.retryable) {
          lastErrorText = err.message;
          continue; // HTTP body 不完整等暫時性問題：換下一次嘗試（可能是備援模型）
        }
        throw err; // 內容被安全過濾擋下等，非暫時性問題，不用再試
      }
    }

    const text = await res.text();
    lastErrorText = text;
    const classification = classifyFailure(res.status, text);
    if (classification.startsWith('QUOTA_EXCEEDED')) hadQuotaExceeded = true;
    console.error(`[gemini] 嘗試 #${i + 1} model=${model} HTTP ${res.status} → ${classification}\n原始 body（前 300 字）：${text.slice(0, 300)}`);
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

  if (hadQuotaExceeded) {
    throw new Error(
      '目前這個時段的 AI 免費額度（每分鐘可呼叫次數）已用完，重試也沒有用，請等 1 分鐘左右再試一次。' +
      '若這個狀況經常發生，建議到 Vercel 專案的 Environment Variables 加上 ANTHROPIC_API_KEY（會自動在 Gemini 額度用盡時改用 Claude），' +
      '或考慮升級 Gemini 的付費方案以提高速率上限。'
    );
  }
  throw new Error(
    `Gemini API 呼叫失敗（主模型與備援模型 ${GEMINI_FALLBACK_MODEL} 皆過載或逾時，已在預算內盡可能重試）：` + lastErrorText
  );
}

// 呼叫 Gemini，附帶一張或多張圖片（base64）+ 文字 prompt，用於 OCR／圖片內容分析。
// 注意：跟 callGemini 不同，這裡刻意不套用檔案開頭那整套多次重試／fair-share timeout
// 的邏輯——圖片分析是使用者上傳一張截圖後明確點擊觸發的單次操作，量體遠低於文案生成，
// 不需要那套為了「批次生成不能被限流卡死」設計的複雜重試機制；單次嘗試 Gemini 主模型，
// 失敗且有設定 ANTHROPIC_API_KEY 時，改試 Claude 的圖片分析當作跨供應商備援即可。
async function requestGeminiVision(model, { system, prompt, images, maxTokens }, timeoutMs) {
  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{
          role: 'user',
          parts: [
            ...images.map(img => ({ inline_data: { mime_type: img.media_type, data: img.data } })),
            { text: prompt },
          ],
        }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
        safetySettings: SAFETY_SETTINGS,
      }),
    },
    timeoutMs
  );
}

async function callGeminiVision({ system, prompt, images, maxTokens = 1500, budgetMs }) {
  if (!Array.isArray(images) || !images.length) {
    throw new Error('缺少要分析的圖片內容。');
  }
  const timeoutMs = Math.min(MAX_ATTEMPT_TIMEOUT_MS, Math.max(MIN_ATTEMPT_TIMEOUT_MS, budgetMs || DEFAULT_BUDGET_MS));

  if (GEMINI_API_KEY) {
    try {
      const res = await requestGeminiVision(GEMINI_MODEL, { system, prompt, images, maxTokens }, timeoutMs);
      if (res.ok) return await extractText(res);
      const text = await res.text();
      console.error(`[gemini-vision] model=${GEMINI_MODEL} HTTP ${res.status} → ${text.slice(0, 300)}`);
    } catch (err) {
      console.error(`[gemini-vision] model=${GEMINI_MODEL} 呼叫失敗：${err.message}`);
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const { callClaudeVision } = require('./anthropic');
    console.warn('[gemini-vision] Gemini 圖片分析失敗或未設定 GEMINI_API_KEY，改用 Claude 作為跨供應商備援。');
    return await callClaudeVision({ system, prompt, images, maxTokens, timeoutMs });
  }

  throw new Error('AI 圖片辨識功能呼叫失敗（Gemini 未回應，且未設定 ANTHROPIC_API_KEY 可供備援），請稍後再試一次。');
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callGemini, callGeminiVision, parseJSON };
