const { getUserFromRequest, restRequest, sendError } = require('../../_lib/supabase');

const EDITABLE_FIELDS = ['industry_tag', 'framework_tag', 'emotion_tags', 'angle_type', 'block_breakdown', 'raw_content'];

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  const { id } = req.query;

  if (req.method === 'PUT') {
    const patch = {};
    for (const key of EDITABLE_FIELDS) {
      if (req.body && req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
    patch.edited_at = new Date().toISOString();

    try {
      const updated = await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: patch,
      });
      if (!updated.length) return sendError(res, 404, '找不到對應的範例文案。');
      return res.status(200).json(updated[0]);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'DELETE') {
    try {
      await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, '不支援的方法。');
};
