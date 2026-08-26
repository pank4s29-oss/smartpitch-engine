const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');

const REPORT_TYPES = new Set(['受眾分析', '產品／服務策略', '行銷企劃', '客戶提案', '其他']);

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

// 報告只保存「受眾潛在痛點列表」與「潛在受眾地圖」兩大主體，
// 不把佐證語料、置信度、廣告矩陣或其他內部計算欄位寫進快照。
function sanitizeSnapshot(input = {}) {
  const profile = input.domain_profile || {};
  const painPoints = cleanArray(input.pain_points).map(point => ({
    id: point.id || null,
    surface_problem: cleanText(point.surface_problem),
    deep_desire: cleanText(point.deep_desire),
    detail: cleanText(point.detail),
  })).filter(point => point.surface_problem || point.deep_desire);
  const segments = cleanArray(input.segments).map(segment => ({
    id: segment.id || null,
    segment_name: cleanText(segment.segment_name, '未命名族群'),
    description: cleanText(segment.description),
    rationale: cleanText(segment.rationale),
    differentiation: cleanText(segment.differentiation),
    matched_pain_point_ids: cleanArray(segment.matched_pain_point_ids),
    suggested_formats: cleanArray(segment.suggested_formats).map(item => ({
      format: cleanText(item && item.format),
      reason: cleanText(item && item.reason),
    })).filter(item => item.format),
  }));
  return {
    domain_profile: {
      domain_tag: cleanText(profile.domain_tag),
      audiences: cleanArray(profile.audiences).map(cleanText).filter(Boolean),
      business_constraints_label: cleanText(profile.business_constraints_label),
    },
    pain_points: painPoints,
    segments,
  };
}

async function loadCurrentSnapshot(user, profileId) {
  const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
  if (!profile) return null;
  const painPoints = await restRequest(
    `audience_pain_points?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&review_status=neq.rejected&select=id,surface_problem,deep_desire,detail&order=created_at.asc`
  );
  const segments = await restRequest(
    `audience_segments?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=id,segment_name,description,rationale,differentiation,matched_pain_point_ids,suggested_formats&order=created_at.asc`
  );
  const constraints = Array.isArray(profile.business_constraints) ? profile.business_constraints : [];
  const labels = { no_face: '不露臉', no_short_video: '不使用短影音', text_only: '純文字與圖文排版' };
  return sanitizeSnapshot({
    domain_profile: {
      domain_tag: profile.domain_tag,
      audiences: Array.isArray(profile.audiences) ? profile.audiences : (profile.audience ? [profile.audience] : []),
      business_constraints_label: constraints.map(value => labels[value] || value).join('、'),
    },
    pain_points: painPoints,
    segments,
  });
}

function normalizePayload(body = {}) {
  const title = cleanText(body.title);
  const reportType = cleanText(body.report_type, '受眾分析');
  if (!title) throw new Error('請填寫報告名稱。');
  if (!REPORT_TYPES.has(reportType)) throw new Error('不支援的報告性質。');
  return { title, report_type: reportType, description: cleanText(body.description), snapshot: sanitizeSnapshot(body.snapshot) };
}

async function listReports(user, query) {
  const profileFilter = query.domain_profile_id ? `&domain_profile_id=eq.${query.domain_profile_id}` : '';
  const typeFilter = query.report_type ? `&report_type=eq.${encodeURIComponent(query.report_type)}` : '';
  const rows = await restRequest(`audience_reports?user_id=eq.${user.id}${profileFilter}${typeFilter}&select=id,domain_profile_id,title,report_type,description,created_at,updated_at&order=updated_at.desc`);
  const profiles = await restRequest(`domain_profiles?user_id=eq.${user.id}&select=id,domain_tag,product_name,audiences`);
  const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
  return rows.map(row => ({ ...row, domain_profile: profileMap.get(row.domain_profile_id) || null }));
}

async function getReport(user, id) {
  const [row] = await restRequest(`audience_reports?id=eq.${id}&user_id=eq.${user.id}&select=*`);
  return row || null;
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  const query = req.query || {};
  const id = query.id || null;

  try {
    if (req.method === 'GET') {
      if (id) {
        const row = await getReport(user, id);
        if (!row) return sendError(res, 404, '找不到這份報告。');
        return res.status(200).json(row);
      }
      return res.status(200).json(await listReports(user, query));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const profileId = cleanText(body.domain_profile_id);
      if (!profileId) return sendError(res, 400, '缺少產品／服務設定。');
      const snapshot = body.snapshot ? sanitizeSnapshot(body.snapshot) : await loadCurrentSnapshot(user, profileId);
      if (!snapshot) return sendError(res, 404, '找不到對應的產品／服務設定。');
      const normalized = normalizePayload({ ...body, snapshot });
      const [created] = await restRequest('audience_reports', {
        method: 'POST',
        prefer: 'return=representation',
        body: { user_id: user.id, domain_profile_id: profileId, ...normalized },
      });
      return res.status(201).json(created);
    }

    if (req.method === 'PATCH') {
      if (!id) return sendError(res, 400, '缺少報告 id。');
      const existing = await getReport(user, id);
      if (!existing) return sendError(res, 404, '找不到這份報告。');
      const body = req.body || {};
      const patch = {};
      if (body.title !== undefined) patch.title = cleanText(body.title);
      if (body.report_type !== undefined) patch.report_type = cleanText(body.report_type);
      if (body.description !== undefined) patch.description = cleanText(body.description);
      if (body.snapshot !== undefined) patch.snapshot = sanitizeSnapshot(body.snapshot);
      if (patch.title !== undefined && !patch.title) return sendError(res, 400, '報告名稱不可為空白。');
      if (patch.report_type !== undefined && !REPORT_TYPES.has(patch.report_type)) return sendError(res, 400, '不支援的報告性質。');
      patch.updated_at = new Date().toISOString();
      const [updated] = await restRequest(`audience_reports?id=eq.${id}&user_id=eq.${user.id}`, {
        method: 'PATCH', prefer: 'return=representation', body: patch,
      });
      return res.status(200).json(updated);
    }

    if (req.method === 'DELETE') {
      if (!id) return sendError(res, 400, '缺少報告 id。');
      await restRequest(`audience_reports?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    }

    return sendError(res, 405, '不支援的方法。');
  } catch (err) {
    return sendError(res, 400, err.message);
  }
};
