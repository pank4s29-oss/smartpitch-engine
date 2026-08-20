const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call } = require('./_lib/provider');
const { isSensitiveIndustry } = require('./_lib/compliance');

// 這支取代了原本的文案生成（generation-requests-hub.js）。
// 對應企劃書「痛點驗證層」與「成效回饋迴路」的精神：報告裡的每一個數字都是程式碼依
// audience_pain_points / product_solutions 的實際資料算出來的，不是 AI 猜的；AI 只負責
// 寫一小段導讀文字，而且用純文字回傳（不要求 JSON），就算 AI 這段失敗，報告主體依然完整
// 回傳，不會像過去的文案生成那樣整支請求被 Gemini 的穩定性問題拖垮。
//   POST /api/insight-reports       (無 id，產出新報告)
//   GET  /api/insight-reports/:id   (有 id，讀取已產出的報告)

const NARRATIVE_BUDGET_MS = Number(process.env.NARRATIVE_AI_BUDGET_MS || 20000);
const NARRATIVE_MAX_TOKENS = 500;

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

async function buildReport(profile, painPoints) {
  // 解決方案改為在「產品／服務設定」填寫一次，套用到底下所有痛點——
  // 只要產品名稱與解決方案說明都有填，就視為每一筆痛點都已配對到解決方案。
  const hasSolution = !!(profile.product_name && profile.solution_description);
  const solutionSummary = hasSolution ? {
    product_name: profile.product_name,
    core_selling_point: profile.core_selling_point,
  } : null;

  const pairs = painPoints.map(p => {
    const evidenceCount = Array.isArray(p.evidence_source) ? p.evidence_source.length : 0;
    return {
      pain_point_id: p.id,
      surface_problem: p.surface_problem,
      deep_desire: p.deep_desire,
      detail: p.detail || null,
      source: p.source,
      review_status: p.review_status || 'unreviewed',
      confidence_score: round2(p.confidence_score),
      evidence_count: evidenceCount,
      solution: solutionSummary,
    };
  });

  const total = pairs.length;
  const withEvidence = pairs.filter(p => p.evidence_count > 0).length;
  const confirmed = pairs.filter(p => p.review_status === 'confirmed' || p.review_status === 'edited').length;
  const unreviewed = pairs.filter(p => p.review_status === 'unreviewed').length;
  const rejected = pairs.filter(p => p.review_status === 'rejected').length;
  const withSolution = hasSolution ? total : 0;
  const confidenceValues = pairs.map(p => p.confidence_score).filter(v => v !== null);
  const avgConfidence = confidenceValues.length
    ? round2(confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length)
    : null;
  // fit_score 是舊版「每個痛點各自配對解決方案」時才有意義的指標，現在解決方案是全域套用，不再適用。
  const avgFit = null;

  const riskFlags = [];
  if (isSensitiveIndustry(profile.domain_tag)) {
    riskFlags.push('屬敏感產業（醫療／金融等），任何對外文案或主張建議先經人工複核。');
  }
  if (total === 0) {
    riskFlags.push('此產品/服務設定尚未建立任何受眾痛點，報告僅能顯示空白結果，建議先匯入語料或手動新增痛點。');
  } else {
    if (withEvidence / total < 0.34) {
      riskFlags.push(`目前僅 ${withEvidence}/${total} 筆痛點有真實語料佐證，多數仍屬 AI 推測或手動輸入，建議優先補充顧客語料以提高可信度。`);
    }
    if (unreviewed / total > 0.5) {
      riskFlags.push(`有 ${unreviewed}/${total} 筆痛點尚未經過人工複核，建議先確認（confirmed）再作為決策依據。`);
    }
    if (!hasSolution) {
      riskFlags.push('尚未在「產品／服務設定」中填寫解決方案說明，目前所有痛點都還沒有對應的解決方案，無法納入下一步的內容或產品規劃。');
    }
  }

  const framework = profile.price_tier === 'low'
    ? { name: 'PAS', reason: '低單價／快速決策，初步建議採用 Problem-Agitate-Solution 強化立即痛點與行動誘因。' }
    : { name: 'AIDA', reason: '高客單／建立信任，初步建議採用 AIDA 強化信任累積與長期價值。' };

  return {
    domain_profile: { domain_tag: profile.domain_tag, audience: profile.audience, price_tier: profile.price_tier },
    coverage: {
      total_pain_points: total,
      with_evidence: withEvidence,
      confirmed, unreviewed, rejected,
      with_matched_solution: withSolution,
      avg_confidence_score: avgConfidence,
      avg_fit_score: avgFit,
    },
    risk_flags: riskFlags,
    framework_recommendation: framework,
    pain_points: pairs,
  };
}

async function generateNarrative(profile, report) {
  const top = [...report.pain_points]
    .sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
    .slice(0, 3);

  const system = '你是受眾策略顧問。只能輸出一段不含標題、不含條列符號的繁體中文導讀文字，總長度不超過 200 字，語氣專業精簡。';
  const prompt = `領域：${profile.domain_tag}／受眾：${profile.audience}
痛點總數：${report.coverage.total_pain_points}，有語料佐證：${report.coverage.with_evidence}，已人工確認：${report.coverage.confirmed}，平均置信度：${report.coverage.avg_confidence_score ?? '無資料'}
最具佐證力的痛點：${top.map(p => `「${p.surface_problem}」（置信度 ${p.confidence_score ?? '無'}）`).join('、') || '（尚無資料）'}
風險提示：${report.risk_flags.join('；') || '無'}

請寫一段導讀，說明目前受眾洞察的驗證程度、哪個痛點最值得優先投入，以及建議的下一步。`;

  const raw = await call({ system, prompt, maxTokens: NARRATIVE_MAX_TOKENS, budgetMs: NARRATIVE_BUDGET_MS });
  return raw.trim();
}

async function handleCreate(req, res, user) {
  const { profile_id } = req.body || {};
  if (!profile_id) return sendError(res, 400, '缺少必要欄位（profile_id）。');

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profile_id}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const painPoints = await restRequest(`audience_pain_points?domain_profile_id=eq.${profile_id}&user_id=eq.${user.id}&select=*`);

    const report = await buildReport(profile, painPoints);

    // AI 導讀是加分項，不是必要項：失敗就標記 narrative 為 null，整份報告依然完整回傳。
    try {
      report.narrative = await generateNarrative(profile, report);
    } catch (narrativeErr) {
      report.narrative = null;
      report.narrative_error = narrativeErr.message;
    }

    const [saved] = await restRequest('insight_reports', {
      method: 'POST',
      prefer: 'return=representation',
      body: { user_id: user.id, domain_profile_id: profile_id, status: 'completed', report },
    });

    return res.status(200).json({ id: saved.id, status: 'completed', report: saved.report });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleGet(req, res, user, id) {
  try {
    const [saved] = await restRequest(`insight_reports?id=eq.${id}&user_id=eq.${user.id}&select=*`);
    if (!saved) return sendError(res, 404, '找不到對應的報告。');
    return res.status(200).json({ id: saved.id, status: saved.status, report: saved.report });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 列出某個領域設定過去產出的報告（不含 id 時用 ?domain_profile_id= 篩選），供「歷史報告」列表使用。
async function handleList(req, res, user) {
  const { domain_profile_id } = req.query || {};
  try {
    let query = `insight_reports?user_id=eq.${user.id}&select=id,domain_profile_id,status,created_at,coverage:report->coverage&order=created_at.desc&limit=20`;
    if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
    const items = await restRequest(query);
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id } = req.query || {};
  if (id) {
    if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
    return handleGet(req, res, user, id);
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
  return handleCreate(req, res, user);
};
