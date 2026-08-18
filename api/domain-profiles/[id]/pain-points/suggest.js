const { getUserFromRequest, restRequest, sendError } = require('../../../_lib/supabase');
const { call, parseJSON } = require('../../../_lib/anthropic');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');

  const { id: profileId } = req.query;

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    const system = '你是市場洞察分析師。只能輸出合法的 JSON 陣列，不要有任何前後說明文字或 Markdown 圍籬。';
    const prompt = `領域：${profile.domain_tag}
目標受眾：${profile.audience}
價格帶：${profile.price_tier === 'low' ? '低單價／快速決策' : '高客單價／建立信任'}

請提出 3 組該受眾常見的痛點草稿，每組包含 surface_problem（表層問題，一句話）與 deep_desire（背後的深層渴望，一句話）。
輸出格式：[{"surface_problem":"...","deep_desire":"..."}, ...]`;

    const raw = await callClaude({ system, prompt, maxTokens: 800 });
    const suggestions = parseJSON(raw);
    return res.status(200).json(suggestions);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
