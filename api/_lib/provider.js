// 統一入口：依 LLM_PROVIDER 環境變數切換底層模型，呼叫端只需要
//   const { call, parseJSON } = require('./provider');
// 不用管現在接的是 Anthropic 還是 Gemini。
//
// 開發/測試環境：LLM_PROVIDER=gemini（免費額度，但速率限制低）
// 正式環境：      LLM_PROVIDER=anthropic（預設值，未設定時走這條）
const PROVIDER = process.env.LLM_PROVIDER || 'anthropic';

let call, parseJSON;

if (PROVIDER === 'gemini') {
  const gemini = require('./gemini');
  call = gemini.callGemini;
  parseJSON = gemini.parseJSON;
} else {
  const anthropic = require('./anthropic');
  call = anthropic.callClaude;
  parseJSON = anthropic.parseJSON;
}

module.exports = { call, parseJSON, PROVIDER };
