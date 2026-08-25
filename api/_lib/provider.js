// 統一入口：依 LLM_PROVIDER 環境變數切換底層模型，呼叫端只需要
//   const { call, parseJSON } = require('./provider');
// 不用管現在接的是 Anthropic 還是 Gemini。
//
// 預設值：gemini（免費額度，但有速率限制，不適合高流量正式營運）
// 要切回 Claude：設環境變數 LLM_PROVIDER=anthropic
const PROVIDER = process.env.LLM_PROVIDER || 'gemini';

let call, callVision, parseJSON;

if (PROVIDER === 'anthropic') {
  const anthropic = require('./anthropic');
  call = anthropic.callClaude;
  callVision = anthropic.callClaudeVision;
  parseJSON = anthropic.parseJSON;
} else {
  const gemini = require('./gemini');
  call = gemini.callGemini;
  callVision = gemini.callGeminiVision; // 內建 Gemini 失敗時改用 Claude 的跨供應商備援，見 gemini.js。
  parseJSON = gemini.parseJSON;
}

module.exports = { call, callVision, parseJSON, PROVIDER };
