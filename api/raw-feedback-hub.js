const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');

// 這支合併了原本 2 支獨立檔案：
//   GET/POST  /api/raw-feedback      (無 id)
//   DELETE    /api/raw-feedback/:id  (有 id)
// 對應的 vercel.json rewrites 會把兩個路徑都導到這支檔案，前端網址不需要改。

const VALID_SOURCE_TYPES = ['review', 'support_chat', 'survey', 'interview_transcript', 'social_comment', 'other'];
const MAX_TEXT_LENGTH = 5000;
const MAX_BATCH_SIZE = 50;

async function handleList(req, res, user) {
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

async function handleCreate(req, res, user) {
  const { domain_profile_id, source_type, raw_text, raw_texts } = req.body || {};

  if (!source_type || !VALID_SOURCE_TYPES.includes(source_type)) {
    return sendError(res, 400, `請提供有效的語料來源類型（${VALID_SOURCE_TYPES.join('、')} 其中之一）。`);
  }

  const texts = (Array.isArray(raw_texts) ? raw_texts : [raw_text])
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim());

  if (!texts.length) return sendError(res, 400, '請提供至少一筆語料內容（raw_text 或 raw_texts）。');
  if (texts.length > MAX_BATCH_SIZE) return sendError(res, 400, `單次最多匯入 ${MAX_BATCH_SIZE} 筆語料，請分批匯入。`);
  const tooLong = texts.find(t => t.length > MAX_TEXT_LENGTH);
  if (tooLong) return sendError(res, 400, `單篇語料內容不可超過 ${MAX_TEXT_LENGTH} 字，請縮短後再匯入（可考慮拆成多篇）。`);

  try {
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

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`raw_customer_feedback?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id } = req.query || {};
  if (id) {
    if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
    return handleDelete(req, res, user, id);
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};
