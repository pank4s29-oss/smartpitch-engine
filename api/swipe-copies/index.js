const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { call, parseJSON } = require('../_lib/anthropic');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  if (req.method === 'POST') {
    const { raw_content, source_url, industry_tag } = req.body || {};
    if (!raw_content || !raw_content.trim()) return sendError(res, 400, '請貼上要分析的文案內容。');

    try {
      const system = `你是廣告文案結構分析師。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
可用的文案區塊類型（block type）僅限於：hook, pain_agitate, solution, trust_proof, emotional_close, urgency, cta。`;
      const prompt = `請分析以下廣告文案，並輸出：
- industry_tag：產業／領域（若使用者已提供提示「${industry_tag || '無'}」，優先採用或修正它）
- framework_tag：主要行銷框架（如 AIDA、PAS，或最貼近的描述）
- emotion_tags：這篇文案訴諸的情緒，陣列，1-3 個
- angle_type：文案角度（fear／aspiration／logic 三選一，選最貼近的）
- block_breakdown：依文案實際內容拆解出的區塊順序，陣列，例如 ["hook","pain_agitate","solution","cta"]

文案內容：
"""
${raw_content}
"""

輸出格式：{"industry_tag":"...","framework_tag":"...","emotion_tags":["..."],"angle_type":"...","block_breakdown":["..."]}`;

      const raw = await callClaude({ system, prompt, maxTokens: 500 });
      const classified = parseJSON(raw);

      const [saved] = await restRequest('swipe_copies', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          user_id: user.id,
          raw_content,
          source_url: source_url || null,
          industry_tag: classified.industry_tag,
          framework_tag: classified.framework_tag,
          emotion_tags: classified.emotion_tags || [],
          angle_type: classified.angle_type,
          block_breakdown: classified.block_breakdown || [],
        },
      });
      return res.status(200).json(saved);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'GET') {
    try {
      const items = await restRequest(`swipe_copies?user_id=eq.${user.id}&select=*&order=created_at.desc`);
      return res.status(200).json(items);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, '不支援的方法。');
};
