const { getUserFromRequest, restRequest, sendError } = require('../../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');

  const { id } = req.query;

  try {
    await restRequest(`raw_customer_feedback?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
