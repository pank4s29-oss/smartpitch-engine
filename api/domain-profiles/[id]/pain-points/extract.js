const { getUserFromRequest, restRequest, sendError } = require('../../../_lib/supabase');
const { call, parseJSON } = require('../../../_lib/provider');

// 單次最多分析幾筆語料。跟 suggest.js 一樣的 budget 邏輯：筆數越多 prompt 越長，
// 這裡限制批次大小，讓單次呼叫時間可預期、不會把 maxDuration 撐爆。
const MAX_BATCH_SIZE = 20;
const AI_BUDGET_MS = Number(process.env.EXTRACT_AI_BUDGET_MS || 25000);
const MAX_TOKENS = 3000;

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');

  const { id: profileId } = req.query;
  const { feedback_ids } = req.body || {};

  if (!Array.isArray(feedback_ids) || !feedback_ids.length) {
    return sendError(res, 400, '請至少選擇一筆語料進行分析（feedback_ids）。');
  }
  if (feedback_ids.length > MAX_BATCH_SIZE) {
    return sendError(res, 400, `單次最多分析 ${MAX_BATCH_SIZE} 筆語料，請分批進行。`);
  }

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    // 只抓屬於此使用者、此領域設定的語料，避免用別人的 feedback_id 混進來。
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

    const raw = await call({ system, prompt, maxTokens: MAX_TOKENS, budgetMs: AI_BUDGET_MS });
    const parsed = parseJSON(raw);
    if (!parsed || !Array.isArray(parsed.pain_points)) {
      throw new Error('模型回應格式不符預期（缺少 pain_points 陣列），請稍後再試一次。');
    }
    if (!parsed.pain_points.length) {
      return res.status(200).json({ pain_points: [], message: '這批語料中沒有萃取到有明確佐證的痛點，可嘗試選擇其他語料。' });
    }

    // confidence_score 不採用模型自評，改用「有多少比例的語料支持這個痛點」計算，
    // 對應企劃書「痛點驗證層」的精神：置信度要來自證據統計，而不是 AI 主觀猜測。
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

    // 回寫每筆語料的 extracted_pain_point_ids，讓語料端也能看到「這篇被萃取出了哪些痛點」。
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
};
