const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { call, parseJSON } = require('../_lib/provider');

// 這支合併了原本 2 支獨立檔案：
//   GET/POST      /api/swipe-copies      (無 id)
//   PUT/DELETE    /api/swipe-copies/:id  (有 id)
// 對應的 vercel.json rewrites 會把兩個路徑都導到這支檔案，前端網址不需要改。

const AI_BUDGET_MS = Number(process.env.SWIPE_AI_BUDGET_MS || 25000);
const EDITABLE_FIELDS = ['industry_tag', 'framework_tag', 'emotion_tags', 'angle_type', 'block_breakdown', 'raw_content'];

async function handleList(req, res, user) {
  try {
    const items = await restRequest(`swipe_copies?user_id=eq.${user.id}&select=*&order=created_at.desc`);
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreate(req, res, user) {
  const { raw_content, source_url, industry_tag } = req.body || {};
  if (!raw_content || !raw_content.trim()) return sendError(res, 400, '請貼上要分析的文案內容。');

  try {
    const system = `你是廣告文案結構分析師。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
可用的文案區塊類型（block type）僅限於：hook, pain_agitate, solution, trust_proof, emotional_close, urgency, cta。`;
    const prompt = `請分析以下廣告文案，並輸出：
- industry_tag：產業／領域（若使用者已提供提示「${industry_tag || '無'}」，優先採用或修正它）
- framework_tag：主要行銷框架（如 AIDA、PAS，或最貼近的描述）
- emotion_tags：這篇文案訴諸的情緒，陣列，1-3 個
- angle_type：文案角度（fear／aspiration／logic 三選一，選最貼近的）
- block_breakdown：依文案實際內容拆解出的區塊順序，陣列，例如 ["hook","pain_agitate","solution","cta"]

文案內容：
"""
${raw_content}
"""

輸出格式：{"industry_tag":"...","framework_tag":"...","emotion_tags":["..."],"angle_type":"...","block_breakdown":["..."]}`;

    const raw = await call({ system, prompt, maxTokens: 500, budgetMs: AI_BUDGET_MS });
    const classified = parseJSON(raw);

    const [saved] = await restRequest('swipe_copies', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        raw_content,
        source_url: source_url || null,
        industry_tag: classified.industry_tag,
        framework_tag: classified.framework_tag,
        emotion_tags: classified.emotion_tags || [],
        angle_type: classified.angle_type,
        block_breakdown: classified.block_breakdown || [],
      },
    });
    return res.status(200).json(saved);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleUpdate(req, res, user, id) {
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

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
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
    if (req.method === 'PUT') return handleUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleDelete(req, res, user, id);
    return sendError(res, 405, '不支援的方法。');
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};
