const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 2026/08 現行穩定版本；gemini-2.5-flash-lite 即將於 10 月停用，不要用它。
// 若你的帳號 free tier 尚未開放 3.7，AI Studio 會列出目前你能用的免費模型清單，改這個環境變數即可。
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

// 呼叫 Gemini，要求以純文字回傳（呼叫端自行決定是否解析 JSON）。
// 介面（參數/回傳值）刻意對齊 anthropic.js 的 callClaude，方便切換。
async function callGemini({ system, prompt, maxTokens = 3000 }) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI 生成功能目前尚未啟用（尚未設定 GEMINI_API_KEY）。此為測試階段，之後要啟用時，到 Vercel 專案的 Environment Variables 補上這組金鑰並重新部署即可。');
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Gemini 用獨立的 system_instruction 欄位，不是塞進 messages 裡。
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          // 三個呼叫端（suggest / 生成主流程 / swipe 分類）全部要求純 JSON 回應，
          // 開啟原生 JSON 模式讓 Gemini 直接照格式輸出，比純文字要求穩定很多。
          responseMimeType: 'application/json',
        },
        // 行銷/urgency 類文案容易被預設安全過濾誤判，這裡放寬到「僅擋高風險」。
        // 上線前務必實測審核類別是否符合你們的合規要求，必要時調整回較嚴格的等級。
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Gemini API 呼叫失敗：' + text);
  }

  const data = await res.json();

  // 整段被安全過濾擋下時，candidates 會是空的，錯誤原因在 promptFeedback。
  if (!data.candidates || !data.candidates.length) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error('Gemini 未回傳內容' + (reason ? `（被安全過濾擋下：${reason}）` : '：' + JSON.stringify(data)));
  }

  const candidate = data.candidates[0];

  // 內容因超過 maxOutputTokens 被截斷，或單一候選被安全過濾擋下。
  if (candidate.finishReason === 'MAX_TOKENS') {
    console.warn('Gemini 回應因 maxOutputTokens 被截斷，內容可能不完整（JSON.parse 稍後可能會失敗）。');
  } else if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini 回應被安全過濾擋下（finishReason: SAFETY）。');
  }

  const parts = (candidate.content && candidate.content.parts) || [];
  return parts.map(p => p.text || '').join('\n');
}

// 從模型回應中取出 JSON（去除可能的 ```json 圍籬）。
// 開了 responseMimeType 之後通常不會再有圍籬，這裡保留是為了向後相容、多一層保險。
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { callGemini, parseJSON };