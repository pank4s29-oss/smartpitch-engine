const { getUserFromRequest, restRequest, sendError } = require('../../../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');

  const { id: profileId } = req.query;
  const { surface_problem, deep_desire, source } = req.body || {};
  if (!surface_problem || !deep_desire) {
    return sendError(res, 400, '請填寫表層問題與深層渴望。');
  }

  try {
    // 先確認這個 domain_profile 確實屬於目前登入者，避免用別人的 profile_id 塞資料。
    const owned = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=id`);
    if (!owned.length) return sendError(res, 404, '找不到對應的領域設定。');

    const [point] = await restRequest('audience_pain_points', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id: profileId,
        surface_problem,
        deep_desire,
        source: source || 'user_input',
      },
    });
    return res.status(200).json(point);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
