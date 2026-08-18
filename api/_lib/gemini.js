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

const RETRYABLE_STATUS = new Set([429, 503]);

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

async function requestGemini(model, { system, prompt, maxTokens }) {
  return fetch(
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
    }
  );
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
    console.warn('Gemini 回應因 maxOutputTokens 被截斷，內容可能不完整（JSON.parse 稍後可能會失敗）。');
  }
  return text;
}

// 呼叫 Gemini：429/503 這類暫時性錯誤會自動重試，最後一次改打備援模型。
// 404（模型不存在或已下架）不重試，直接丟出，因為換模型也解決不了同一個模型的問題。
// 介面（參數/回傳值）刻意對齊 anthropic.js 的 callClaude，方便切換。
async function callGemini({ system, prompt, maxTokens = 3000 }) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 GEMINI_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }

  // 刻意把重試總延遲控制在 1 秒左右，避免在 Vercel 預設的 10 秒 function timeout 內被腰斬。
  const attempts = [
    { model: GEMINI_MODEL, delayBefore: 0 },
    { model: GEMINI_MODEL, delayBefore: 700 },
    { model: GEMINI_FALLBACK_MODEL, delayBefore: 300 },
  ];

  let lastErrorText = '';
  for (let i = 0; i < attempts.length; i++) {
    const { model, delayBefore } = attempts[i];
    if (delayBefore) await new Promise(r => setTimeout(r, delayBefore));

    const res = await requestGemini(model, { system, prompt, maxTokens });
    if (res.ok) {
      if (model !== GEMINI_MODEL) console.warn(`Gemini 主模型（${GEMINI_MODEL}）過載，已改用備援模型 ${model} 成功回應。`);
      return extractText(res);
    }

    const text = await res.text();
    lastErrorText = text;
    if (!RETRYABLE_STATUS.has(res.status)) {
      // 非暫時性錯誤（例如金鑰無效、模型不存在／已下架、request 格式錯誤）不重試，直接丟出。
      throw new Error('Gemini API 呼叫失敗：' + text);
    }
    // 429/503：繼續下一次嘗試
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
