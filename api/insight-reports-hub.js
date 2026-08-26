const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { buildReportDocx } = require('./_lib/report-docx');

// 原本這支是「洞察報告」：AI 導讀＋覆蓋率統計＋風險提示＋廣告成效比對，整份存成
// insight_reports 資料表裡的一筆快照，還有獨立的報告資料庫／歷史紀錄可以回顧舊版本。
//
// 現在改版：報告不再是「另外產出的一份分析」，而是直接把「受眾痛點列表」與「潛在受眾
// 地圖」這兩個系統本來就有、使用者已經在看的清單，原樣組成一份可離線保存／寄送客戶的
// 報告。不呼叫 AI、不寫入資料庫、不留歷史版本——每次打開都是當下最新的資料，跟畫面上
// 看到的完全一致，也不會有「報告裡的資料是舊的、跟畫面對不上」的問題。
//
// 同時拿掉「語料佐證」「置信度」這類欄位：使用者原本回饋這些名詞對非行銷背景的人來說
// 不好懂，而且顧客／網友在語料裡提到的內容，本來就不等於「這個受眾一定存在或一定被
// 打動」，用一個百分比置信度來包裝反而讓人誤以為是精準量化的證據。真正可信的驗證方式
// 是「Meta 廣告效益驗證」頁面裡的真實花費／點擊／轉換數據，那部分維持獨立，不混進這份
// 報告。
//
//   GET /api/insight-reports?profile_id=xxx            → 回傳 JSON，畫面上直接渲染用
//   GET /api/insight-reports?profile_id=xxx&format=docx → 回傳同一份資料的 Word 文件

// 已駁回的痛點不計入報告——這跟「潛在受眾地圖」分析時排除已駁回痛點的邏輯一致，
// 報告理應只呈現使用者還認可的痛點，而不是連使用者自己都否決掉的內容。
async function loadReportData(user, profileId) {
  const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
  if (!profile) return null;

  const painPoints = await restRequest(
    `audience_pain_points?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&review_status=neq.rejected&select=id,surface_problem,deep_desire,detail&order=created_at.asc`
  );
  const segments = await restRequest(
    `audience_segments?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.asc`
  );

  const hasSolution = !!(profile.product_name && profile.solution_description);
  const solution = hasSolution ? {
    product_name: profile.product_name,
    core_selling_point: profile.core_selling_point || null,
    solution_description: profile.solution_description,
    trust_proof: profile.trust_proof || null,
  } : null;

  return {
    domain_profile: {
      domain_tag: profile.domain_tag,
      audiences: Array.isArray(profile.audiences) ? profile.audiences : (profile.audience ? [profile.audience] : []),
      business_constraints: Array.isArray(profile.business_constraints) ? profile.business_constraints : [],
    },
    solution,
    pain_points: painPoints,
    segments,
  };
}

const CONSTRAINT_LABELS = {
  no_face: '不露臉',
  no_short_video: '不使用短影音',
  text_only: '純文字與圖文排版',
};

function constraintsLabel(list) {
  return (list || []).map(c => CONSTRAINT_LABELS[c] || c).join('、') || null;
}

async function handleGetDocx(res, data) {
  try {
    const buffer = await buildReportDocx(data, '匯出時間：' + new Date().toLocaleString('zh-TW'));
    const safeName = (data.domain_profile.domain_tag || '受眾報告').replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.docx"`);
    return res.status(200).send(buffer);
  } catch (err) {
    return sendError(res, 500, '匯出 Word 文件失敗：' + err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');

  const { profile_id, format } = req.query || {};
  if (!profile_id) return sendError(res, 400, '缺少必要欄位（profile_id）。');

  try {
    const data = await loadReportData(user, profile_id);
    if (!data) return sendError(res, 404, '找不到對應的產品/服務設定。');
    data.domain_profile.business_constraints_label = constraintsLabel(data.domain_profile.business_constraints);

    if (format === 'docx') return handleGetDocx(res, data);
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
