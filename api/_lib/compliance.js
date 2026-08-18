// 依產業別可持續擴充；這裡先放最常見、最容易誤用的違規字句作為第一版規則庫。
const BLACKLIST = [
  '保證有效', '穩賺不賠', '根治', '100%有效', '無風險', '包治百病',
  '立即見效不復發', '醫學證實有效', '零副作用', '穩定獲利',
];

// 需要強制標記人工複核的產業關鍵字。
const SENSITIVE_INDUSTRIES = ['醫療', '醫美', '保健食品', '健康食品', '藥品', '金融', '投資', '理財', '命理', '算命', '塔羅'];

function scanBlacklist(text = '') {
  return BLACKLIST.filter(word => text.includes(word));
}

function isSensitiveIndustry(domainTag = '') {
  return SENSITIVE_INDUSTRIES.some(keyword => domainTag.includes(keyword));
}

// 簡易逐字重複檢查：把文案切成固定長度的片段，比對是否完整出現在任一篇範例文案原文中。
// 這是防止生成引擎「抄襲」範例文案資料庫的最後一道防線，不能只靠 Prompt 指示。
function hasVerbatimOverlap(body = '', swipeTexts = [], chunkLen = 30, stride = 10) {
  for (const source of swipeTexts) {
    if (!source) continue;
    for (let i = 0; i + chunkLen <= body.length; i += stride) {
      const chunk = body.slice(i, i + chunkLen);
      if (chunk.trim().length >= chunkLen && source.includes(chunk)) return true;
    }
  }
  return false;
}

module.exports = { scanBlacklist, isSensitiveIndustry, hasVerbatimOverlap };
