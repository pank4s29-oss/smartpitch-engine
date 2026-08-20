const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { call, parseJSON } = require('../_lib/provider');

// 這支合併了原本 3 支獨立檔案：
//   POST /api/domain-profiles/:id/pain-points          (action 未帶)
//   GET  /api/domain-profiles/:id/pain-points/suggest   (action=suggest)
//   POST /api/domain-profiles/:id/pain-points/extract   (action=extract)
// 對應的 vercel.json rewrites 會把這三個路徑都導到這支檔案，前端網址不需要改。

const SUGGEST_AI_BUDGET_MS = Number(process.env.SUGGEST_AI_BUDGET_MS || 40000);
const EXTRACT_AI_BUDGET_MS = Number(process.env.EXTRACT_AI_BUDGET_MS || 25000);
const EXTRACT_MAX_BATCH_SIZE = 20;

async function handleCreate(req, res, user, profileId) {
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
  const { surface_problem, deep_desire, source } = req.body || {};
  if (!surface_problem || !deep_desire) {
    return sendError(res, 400, '請填寫表層問題與深層渴望。');
  }
  try {
    const owned = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=id`);
    if (!owned.length) return sendError(res, 404, '找不到對應的領域設定。');

    const [point] = await restRequest('audience_pain_points', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id: profileId,
        surface_problem,
        deep_desire,
        source: source || 'user_input',
      },
    });
    return res.status(200).json(point);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleSuggest(req, res, user, profileId) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    const system = '你是市場洞察分析師。只能輸出合法的 JSON 陣列，不要有任何前後說明文字或 Markdown 圍籬。';
    const prompt = `領域：${profile.domain_tag}
目標受眾：${profile.audience}
價格帶：${profile.price_tier === 'low' ? '低單價／快速決策' : '高客單價／建立信任'}

請提出 3 組該受眾常見的痛點草稿，每組包含 surface_problem（表層問題，一句話）與 deep_desire（背後的深層渴望，一句話）。
輸出格式：[{"surface_problem":"...","deep_desire":"..."}, ...]`;

    const raw = await call({ system, prompt, maxTokens: 800, budgetMs: SUGGEST_AI_BUDGET_MS });
    const suggestions = parseJSON(raw);
    return res.status(200).json(suggestions);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleExtract(req, res, user, profileId) {
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
  const { feedback_ids } = req.body || {};
  if (!Array.isArray(feedback_ids) || !feedback_ids.length) {
    return sendError(res, 400, '請至少選擇一筆語料進行分析（feedback_ids）。');
  }
  if (feedback_ids.length > EXTRACT_MAX_BATCH_SIZE) {
    return sendError(res, 400, `單次最多分析 ${EXTRACT_MAX_BATCH_SIZE} 筆語料，請分批進行。`);
  }

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    const idFilter = feedback_ids.map(id => `"${id}"`).join(',');
    const feedbacks = await restRequest(
      `raw_customer_feedback?id=in.(${idFilter})&user_id=eq.${user.id}&domain_profile_id=eq.${profileId}&select=id,raw_text`
    );
    if (!feedbacks.length) return sendError(res, 404, '找不到對應的語料，請確認是否已歸類到此領域設定。');

    const system = `你是市場洞察分析師，專長是從真實顧客語料中萃取痛點，而不是憑常識推測。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
規則：
1. 每個痛點都必須有語料佐證，evidence_indices 要列出所有支持這個痛點的語料編號（從 0 開始）。
2. quote 從對應語料原文擷取最能代表這個痛點的一小段（不超過 40 字），不可整段照抄。
3. 不要輸出語料裡完全沒有依據、純粹用常識腦補的痛點。
4. 同一個痛點如果在多筆語料中都有出現，要合併成一條、evidence_indices 列出全部相關編號，不要重複拆成多條。`;

    const prompt = `【領域】${profile.domain_tag}
【目標受眾】${profile.audience}

以下是 ${feedbacks.length} 筆真實顧客語料（編號從 0 開始）：
${feedbacks.map((f, i) => `[${i}] ${f.raw_text.slice(0, 800)}`).join('\n')}

請萃取這些語料中反映出的受眾痛點，每個痛點包含：
- surface_problem：表層問題（一句話）
- deep_desire：背後的深層渴望（一句話）
- evidence_indices：支持此痛點的語料編號陣列，例如 [0,2]
- quote：從語料中擷取的代表性原文片段（不超過 40 字）

輸出格式：
{"pain_points":[{"surface_problem":"...","deep_desire":"...","evidence_indices":[0,2],"quote":"..."}]}`;

    const raw = await call({ system, prompt, maxTokens: 3000, budgetMs: EXTRACT_AI_BUDGET_MS });
    const parsed = parseJSON(raw);
    if (!parsed || !Array.isArray(parsed.pain_points)) {
      throw new Error('模型回應格式不符預期（缺少 pain_points 陣列），請稍後再試一次。');
    }
    if (!parsed.pain_points.length) {
      return res.status(200).json({ pain_points: [], message: '這批語料中沒有萃取到有明確佐證的痛點，可嘗試選擇其他語料。' });
    }

    const rows = parsed.pain_points.map(p => {
      const indices = Array.isArray(p.evidence_indices) ? p.evidence_indices.filter(i => feedbacks[i]) : [];
      const evidence_source = indices.map(i => ({ raw_customer_feedback_id: feedbacks[i].id, quote: p.quote || null }));
      return {
        user_id: user.id,
        domain_profile_id: profileId,
        surface_problem: p.surface_problem,
        deep_desire: p.deep_desire,
        source: 'raw_feedback_extraction',
        evidence_source,
        confidence_score: indices.length ? Math.min(1, indices.length / feedbacks.length) : null,
        review_status: 'unreviewed',
      };
    }).filter(r => r.surface_problem && r.deep_desire && r.evidence_source.length);

    if (!rows.length) {
      return res.status(200).json({ pain_points: [], message: '模型回傳的痛點缺少有效佐證，未寫入資料庫，可嘗試選擇其他語料。' });
    }

    const savedPoints = await restRequest('audience_pain_points', {
      method: 'POST',
      prefer: 'return=representation',
      body: rows,
    });

    const pointIdsByFeedback = new Map();
    savedPoints.forEach(point => {
      (point.evidence_source || []).forEach(e => {
        const list = pointIdsByFeedback.get(e.raw_customer_feedback_id) || [];
        list.push(point.id);
        pointIdsByFeedback.set(e.raw_customer_feedback_id, list);
      });
    });
    await Promise.all(feedbacks
      .filter(f => pointIdsByFeedback.has(f.id))
      .map(f => restRequest(`raw_customer_feedback?id=eq.${f.id}`, {
        method: 'PATCH',
        body: { extracted_pain_point_ids: pointIdsByFeedback.get(f.id) },
      }))
    );

    return res.status(200).json({ pain_points: savedPoints });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id: profileId, action } = req.query || {};
  if (!profileId) return sendError(res, 400, '缺少 domain profile id。');

  if (action === 'suggest') return handleSuggest(req, res, user, profileId);
  if (action === 'extract') return handleExtract(req, res, user, profileId);
  if (!action) return handleCreate(req, res, user, profileId);
  return sendError(res, 400, '不支援的 action。');
};
