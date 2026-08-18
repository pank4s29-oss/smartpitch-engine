const { getUserFromRequest, restRequest, sendError } = require('../../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');

  const { id } = req.query;

  try {
    const [request] = await restRequest(`generation_requests?id=eq.${id}&user_id=eq.${user.id}&select=*`);
    if (!request) return sendError(res, 404, '找不到對應的生成請求。');

    const variants = await restRequest(`copy_variants?request_id=eq.${id}&user_id=eq.${user.id}&select=*&order=created_at.asc`);

    return res.status(200).json({ id: request.id, status: request.status, strategy: request.strategy, variants });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
