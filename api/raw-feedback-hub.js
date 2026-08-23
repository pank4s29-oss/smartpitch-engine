const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');

// 這支合併了原本 2 支獨立檔案：
//   GET/POST  /api/raw-feedback      (無 id)
//   DELETE    /api/raw-feedback/:id  (有 id)
// 對應的 vercel.json rewrites 會把兩個路徑都導到這支檔案，前端網址不需要改。

// 語料來源分類改為使用者自訂（原本是寫死的 6 種），這幾個是首次使用時自動帶入的預設值，
// 之後使用者可以自由新增／刪除，順序以「社群貼文分享」排最前面，對應主要蒐集來源。
const DEFAULT_LABELS = ['社群貼文分享', '顧客評論', '客服對話', '問卷回饋', '訪談逐字稿', '其他'];
const MAX_LABEL_LENGTH = 20;
const MAX_TEXT_LENGTH = 5000;
// CSV／結構化批次匯入常常一次就有上百列，原本 50 筆的上限對日常素材（例如整批匯出的評論）
// 太保守；前端會依這個上限自動切批送出，這裡只要放寬到合理範圍即可。
const MAX_BATCH_SIZE = 200;

// 把使用者輸入或 CSV 欄位裡的日期字串正規化成 ISO 字串；無法解析就當作沒有提供，不擋匯入。
function normalizeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 把評分正規化到 0-5 的範圍；無法解析或超出合理範圍就當作沒有提供，不擋匯入
// （評分本來就是輔助資訊，不應該因為格式不完美就讓整筆語料匯入失敗）。
function normalizeRating(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(5, n));
}

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
  const { domain_profile_id, source_type, raw_text, raw_texts, items } = req.body || {};

  const sourceType = (source_type || '').trim();
  if (!sourceType) return sendError(res, 400, '請選擇語料來源分類。');
  if (sourceType.length > MAX_LABEL_LENGTH) return sendError(res, 400, `分類名稱不可超過 ${MAX_LABEL_LENGTH} 字。`);

  // 兩種匯入路徑統一轉成同一種內部格式（rows）再寫入：
  //   1. items：結構化匯入（例如前端解析 CSV 後送來），每筆可以帶 occurred_at／rating／meta，
  //      讓語料除了純文字之外，還能保留「這則語料本身的日期、評分，以及其他原始欄位」這些脈絡。
  //   2. raw_text／raw_texts：既有的純文字貼上匯入，維持原本行為，日期/評分一律是空值。
  let rows;
  if (Array.isArray(items) && items.length) {
    rows = items
      .map(it => ({
        raw_text: typeof (it && it.raw_text) === 'string' ? it.raw_text.trim() : '',
        occurred_at: normalizeDate(it && it.occurred_at),
        rating: normalizeRating(it && it.rating),
        meta: (it && it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta)) ? it.meta : {},
      }))
      .filter(r => r.raw_text);
  } else {
    const texts = (Array.isArray(raw_texts) ? raw_texts : [raw_text])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim());
    rows = texts.map(text => ({ raw_text: text, occurred_at: null, rating: null, meta: {} }));
  }

  if (!rows.length) return sendError(res, 400, '請提供至少一筆語料內容（raw_text／raw_texts，或結構化的 items）。');
  if (rows.length > MAX_BATCH_SIZE) return sendError(res, 400, `單次最多匯入 ${MAX_BATCH_SIZE} 筆語料，請分批匯入。`);
  const tooLong = rows.find(r => r.raw_text.length > MAX_TEXT_LENGTH);
  if (tooLong) return sendError(res, 400, `單篇語料內容不可超過 ${MAX_TEXT_LENGTH} 字，請縮短後再匯入（可考慮拆成多篇）。`);

  try {
    if (domain_profile_id) {
      const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
      if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
    }

    const dbRows = rows.map(r => ({
      user_id: user.id,
      domain_profile_id: domain_profile_id || null,
      source_type: sourceType,
      raw_text: r.raw_text,
      occurred_at: r.occurred_at,
      rating: r.rating,
      meta: r.meta,
    }));

    const saved = await restRequest('raw_customer_feedback', {
      method: 'POST',
      prefer: 'return=representation',
      body: dbRows.length === 1 ? dbRows[0] : dbRows,
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

// ---- 語料來源分類管理 ----

async function handleListLabels(req, res, user) {
  try {
    let labels = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&select=*&order=sort_order.asc,created_at.asc`);
    if (!labels.length) {
      // 第一次使用，帶入預設分類，之後使用者可自由增刪。
      const rows = DEFAULT_LABELS.map((label, i) => ({ user_id: user.id, label, sort_order: i }));
      labels = await restRequest('feedback_source_labels', { method: 'POST', prefer: 'return=representation', body: rows });
      labels.sort((a, b) => a.sort_order - b.sort_order);
    }
    return res.status(200).json(labels);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreateLabel(req, res, user) {
  const label = (req.body && req.body.label || '').trim();
  if (!label) return sendError(res, 400, '請輸入分類名稱。');
  if (label.length > MAX_LABEL_LENGTH) return sendError(res, 400, `分類名稱不可超過 ${MAX_LABEL_LENGTH} 字。`);
  try {
    const existing = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&label=eq.${encodeURIComponent(label)}&select=id`);
    if (existing.length) return sendError(res, 409, '這個分類已經存在。');
    const countRes = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&select=sort_order&order=sort_order.desc&limit=1`);
    const nextOrder = countRes.length ? countRes[0].sort_order + 1 : 0;
    const [saved] = await restRequest('feedback_source_labels', {
      method: 'POST', prefer: 'return=representation', body: { user_id: user.id, label, sort_order: nextOrder },
    });
    return res.status(200).json(saved);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDeleteLabel(req, res, user, id) {
  try {
    await restRequest(`feedback_source_labels?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id, action } = req.query || {};

  if (action === 'source-types') {
    if (id) {
      if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
      return handleDeleteLabel(req, res, user, id);
    }
    if (req.method === 'GET') return handleListLabels(req, res, user);
    if (req.method === 'POST') return handleCreateLabel(req, res, user);
    return sendError(res, 405, '不支援的方法。');
  }

  if (id) {
    if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
    return handleDelete(req, res, user, id);
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};
