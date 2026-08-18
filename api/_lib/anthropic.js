const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// 跟 gemini.js 的 REQUEST_TIMEOUT_MS 同一邏輯：避免 fetch 沒有 timeout、
// 一路掛到 Vercel 平台自己在 maxDuration 到點時砍斷函式（變成使用者端的 504）。
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 15000);

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
async function callClaude({ system, prompt, maxTokens = 3000 }) {
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
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Claude API 呼叫失敗：' + text);
  }
  const data = await res.json();
  return data.content.map(b => b.text || '').join('\n');
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callClaude, parseJSON };
