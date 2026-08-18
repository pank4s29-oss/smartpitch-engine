const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  if (req.method === 'POST') {
    const { domain_tag, audience, price_tier, constraints } = req.body || {};
    if (!domain_tag || !audience || !price_tier) {
      return sendError(res, 400, '請填寫產業／領域、目標受眾與價格帶。');
    }
    try {
      const [profile] = await restRequest('domain_profiles', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          user_id: user.id,
          domain_tag,
          audience,
          price_tier,
          business_constraints: constraints || [],
        },
      });
      return res.status(200).json(profile);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'GET') {
    try {
      const profiles = await restRequest(
        `domain_profiles?user_id=eq.${user.id}&order=created_at.desc`
      );
      return res.status(200).json(profiles);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, '不支援的方法。');
};
