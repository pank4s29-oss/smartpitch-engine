const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  const { ad_copy_id } = req.query || {};
  if (!ad_copy_id) return sendError(res, 400, '缺少 ad_copy_id。');
  if (req.method !== 'GET') return sendError(res, 405, '目前只支援讀取成效歷史。');

  try {
    const [adCopy] = await restRequest(`ad_copies?id=eq.${ad_copy_id}&user_id=eq.${user.id}&select=id,raw_content,ai_tags,match_status`);
    if (!adCopy) return sendError(res, 404, '找不到對應的廣告文案。');
    const rows = await restRequest(
      `ad_performance_history?ad_copy_id=eq.${ad_copy_id}&user_id=eq.${user.id}&select=*&order=reporting_period_start.desc.nullslast,synced_at.desc`
    );
    return res.status(200).json({ ad_copy: adCopy, history: rows });
  } catch (err) {
    return sendError(res, 500, `讀取成效歷史失敗：${err.message}`);
  }
};
