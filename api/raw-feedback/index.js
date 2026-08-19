const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');

const VALID_SOURCE_TYPES = ['review', 'support_chat', 'survey', 'interview_transcript', 'social_comment', 'other'];
// 單篇語料上限，避免使用者整份逐字稿貼進來把 AI 萃取的 prompt 撐爆。
const MAX_TEXT_LENGTH = 5000;
// 一次批次匯入的筆數上限（例如貼上一批顧客評論）。
const MAX_BATCH_SIZE = 50;

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  if (req.method === 'POST') {
    const { domain_profile_id, source_type, raw_text, raw_texts } = req.body || {};

    if (!source_type || !VALID_SOURCE_TYPES.includes(source_type)) {
      return sendError(res, 400, `請提供有效的語料來源類型（${VALID_SOURCE_TYPES.join('、')} 其中之一）。`);
    }

    // 支援兩種輸入：單篇 raw_text，或批次貼入的 raw_texts 陣列（例如一次貼多則評論）。
    const texts = (Array.isArray(raw_texts) ? raw_texts : [raw_text])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim());

    if (!texts.length) {
      return sendError(res, 400, '請提供至少一筆語料內容（raw_text 或 raw_texts）。');
    }
    if (texts.length > MAX_BATCH_SIZE) {
      return sendError(res, 400, `單次最多匯入 ${MAX_BATCH_SIZE} 筆語料，請分批匯入。`);
    }
    const tooLong = texts.find(t => t.length > MAX_TEXT_LENGTH);
    if (tooLong) {
      return sendError(res, 400, `單篇語料內容不可超過 ${MAX_TEXT_LENGTH} 字，請縮短後再匯入（可考慮拆成多篇）。`);
    }

    try {
      // domain_profile_id 為選填（語料也可以先匯入、之後再歸類到領域），但若有給，必須確認屬於目前使用者。
      if (domain_profile_id) {
        const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
        if (!owned.length) return sendError(res, 404, '找不到對應的領域設定。');
      }

      const rows = texts.map(raw_text => ({
        user_id: user.id,
        domain_profile_id: domain_profile_id || null,
        source_type,
        raw_text,
      }));

      const saved = await restRequest('raw_customer_feedback', {
        method: 'POST',
        prefer: 'return=representation',
        body: rows.length === 1 ? rows[0] : rows,
      });

      const savedList = Array.isArray(saved) ? saved : [saved];
      return res.status(200).json({ imported: savedList.length, items: savedList });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'GET') {
    const { domain_profile_id, limit } = req.query || {};
    try {
      let query = `raw_customer_feedback?user_id=eq.${user.id}&select=*&order=created_at.desc`;
      if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
      query += `&limit=${Math.min(Number(limit) || 50, 200)}`;

      const items = await restRequest(query);
      return res.status(200).json(items);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  return sendError(res, 405, '不支援的方法。');
};
