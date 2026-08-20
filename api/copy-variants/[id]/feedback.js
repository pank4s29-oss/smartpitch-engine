const { getUserFromRequest, restRequest, sendError } = require('../../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');

  const { id } = req.query;
  const { adopted } = req.body || {};

  try {
    const updated = await restRequest(`copy_variants?id=eq.${id}&user_id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { adopted: adopted !== false },
    });
    if (!updated.length) return sendError(res, 404, '找不到對應的文案。');
    return res.status(200).json(updated[0]);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
