const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 20000);

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Claude API 呼叫逾時（超過 ${timeoutMs}ms 無回應）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 呼叫 Claude，要求以純文字回傳（呼叫端自行決定是否解析 JSON）。
// timeoutMs：可由呼叫端覆寫（例如 gemini.js 用剩餘預算呼叫這裡當跨供應商備援時），
// 沒傳的話用 DEFAULT_TIMEOUT_MS。
async function callClaude({ system, prompt, maxTokens = 3000, timeoutMs }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 ANTHROPIC_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    Math.max(3000, timeoutMs || DEFAULT_TIMEOUT_MS)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Claude API 呼叫失敗：' + text);
  }
  const data = await res.json();
  return data.content.map(b => b.text || '').join('\n');
}

// 呼叫 Claude，附帶一張或多張圖片（base64）+ 文字 prompt，用於 OCR／圖片內容分析。
// 圖片一律放在 content 陣列最前面、文字 prompt 放最後，符合 Claude 官方建議的排列方式
// （圖片在前有助於模型在讀到問題之前先「看過」圖片）。
// 刻意不做像 callClaude 那樣複雜的多次重試/跨供應商備援——圖片分析目前都是使用者
// 明確點擊觸發的單次操作（上傳一張截圖、按下匯入），不是高流量的批次生成，
// 單次呼叫失敗時讓使用者看到明確錯誤訊息、自己重新點擊即可，不需要額外的重試機制
// 增加程式複雜度。
async function callClaudeVision({ system, prompt, images, maxTokens = 1500, timeoutMs }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('AI 圖片辨識功能目前尚未啟用（尚未設定 ANTHROPIC_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }
  if (!Array.isArray(images) || !images.length) {
    throw new Error('缺少要分析的圖片內容。');
  }
  const content = [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    })),
    { type: 'text', text: prompt },
  ];
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
      }),
    },
    Math.max(3000, timeoutMs || DEFAULT_TIMEOUT_MS)
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Claude API（圖片分析）呼叫失敗：' + text);
  }
  const data = await res.json();
  return data.content.map(b => b.text || '').join('\n');
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callClaude, callClaudeVision, parseJSON };
