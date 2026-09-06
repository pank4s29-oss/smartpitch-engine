const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call, parseJSON } = require('./_lib/provider');

// 競品定位比較模組（商業企劃書 P1 項目）。
//   GET    /api/competitor-brands?domain_profile_id=xxx            列出這組設定底下的競品
//   GET    /api/competitor-brands?domain_profile_id=xxx&action=compare  AI 差異化定位分析（不寫入資料庫，
//                                                                    每次呼叫即時運算，競品異動後重新點擊即可拿到最新結果）
//   POST   /api/competitor-brands                                  新增一筆競品
//   PATCH  /api/competitor-brands?id=xxx                            編輯既有競品
//   DELETE /api/competitor-brands?id=xxx                            刪除既有競品
// 對應 vercel.json 的 rewrites，前端路徑統一用 /api/competitor-brands...。

const COMPARE_AI_BUDGET_MS = Number(process.env.COMPETITOR_COMPARE_AI_BUDGET_MS || 30000);
const MAX_BRAND_NAME_LENGTH = 60;
const MAX_COMPETITORS_FOR_COMPARE = 12; // 避免一次塞太多競品進 prompt，拖慢分析也稀釋重點

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceRangeLine(min, max, currency) {
  if (min === null && max === null) return '未提供';
  const cur = currency || 'TWD';
  if (min !== null && max !== null) return `${cur} ${min}–${max}`;
  if (min !== null) return `${cur} ${min} 以上`;
  return `${cur} ${max} 以下`;
}

async function loadProfile(user, profileId) {
  const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
  return profile || null;
}

async function handleList(req, res, user, profileId) {
  try {
    const rows = await restRequest(
      `competitor_brands?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.asc`
    );
    return res.status(200).json(rows);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 純運算，不呼叫 AI 以外的資料庫寫入：每次點擊都用當下最新的產品設定與競品清單即時分析，
// 不留歷史版本——理由跟 insight-reports-hub 的報告設計一致，避免「分析結果跟畫面上的競品
// 清單對不上」的問題。少量競品、短 prompt，重新運算的成本不高，不需要額外快取一層。
async function handleCompare(req, res, user, profileId) {
  try {
    const profile = await loadProfile(user, profileId);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const competitors = await restRequest(
      `competitor_brands?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.asc`
    );
    if (!competitors.length) {
      return res.status(200).json({ message: '尚未新增任何競品品牌，請先新增至少 1 個競品再進行差異化分析。' });
    }

    const ourAudiences = Array.isArray(profile.audiences) && profile.audiences.length
      ? profile.audiences.join('、') : (profile.audience || '未設定');
    const ourPriceLine = priceRangeLine(profile.price_range_min, profile.price_range_max, profile.price_currency);
    const ourPositionNote = profile.price_position_note || '（未填寫，僅有低單價／高客單的粗略分類）';
    const ourPriceTierLabel = profile.price_tier === 'high' ? '高客單／建立信任' : '低單價／快速決策';

    const list = competitors.slice(0, MAX_COMPETITORS_FOR_COMPARE);
    const competitorLines = list.map((c, i) =>
      `[${i}] 品牌：${c.brand_name}／價位帶：${priceRangeLine(c.price_range_min, c.price_range_max, c.price_currency)}／` +
      `主打受眾：${c.target_audience || '未提供'}／定位摘要：${c.positioning_summary || '未提供'}`
    ).join('\n');

    const system = `你是品牌定位與定價策略顧問。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
任務：比較「我方」的價位與受眾定位，跟使用者輸入的每一個競品品牌，找出價格帶是否重疊、受眾是否重疊，
並提出具體、可執行的差異化建議，不要輸出空泛的行銷詞（例如「提升品牌價值」「打造獨特優勢」這類沒有具體
內容的話）。若我方的價位帶或定位說明尚未填寫，仍要盡力依「低單價／高客單」的粗略分類進行比較，並在
price_gap_summary 中提醒使用者若能補上具體價位帶，分析會更準確。`;

    const prompt = `【我方】
產業／領域：${profile.domain_tag}
目標受眾：${ourAudiences}
價位帶：${ourPriceLine}（策略分類：${ourPriceTierLabel}）
定位說明：${ourPositionNote}

【競品清單】（編號從 0 開始，共 ${list.length} 個）
${competitorLines}

請輸出：
{
  "price_gap_summary": "整體來看，我方價位帶與這些競品的重疊或缺口狀況（2-4 句，需指出具體與哪個編號的品牌重疊或有明顯價差）",
  "competitor_insights": [{"index": 0, "differentiation_point": "針對這個競品，我方具體可以強調的差異化重點（1-2 句，具體、可執行，不要空泛）"}],
  "recommended_positioning": "綜合以上比較，建議我方可以採用的一句話定位語句（15-40 字，具體描述『對誰、解決什麼、跟競品不同在哪』）",
  "risk_flags": ["若有價格帶或受眾與特定競品高度重疊、可能造成混淆的風險，逐條列出，最多 3 條；沒有明顯風險則回傳空陣列"]
}`;

    const raw = await call({ system, prompt, maxTokens: 1400, budgetMs: COMPARE_AI_BUDGET_MS });
    const parsed = parseJSON(raw) || {};

    const insights = Array.isArray(parsed.competitor_insights) ? parsed.competitor_insights : [];
    const competitorInsights = insights
      .filter(i => i && list[i.index])
      .map(i => ({
        id: list[i.index].id,
        brand_name: list[i.index].brand_name,
        differentiation_point: i.differentiation_point || '',
      }));

    return res.status(200).json({
      price_gap_summary: parsed.price_gap_summary || '',
      competitor_insights: competitorInsights,
      recommended_positioning: parsed.recommended_positioning || '',
      risk_flags: Array.isArray(parsed.risk_flags) ? parsed.risk_flags.filter(Boolean).slice(0, 3) : [],
      based_on_competitor_count: list.length,
      truncated: competitors.length > list.length,
    });
  } catch (err) {
    return sendError(res, 500, `差異化分析失敗：${err.message}`);
  }
}

async function handleCreate(req, res, user) {
  const {
    domain_profile_id, brand_name, price_range_min, price_range_max, price_currency,
    target_audience, positioning_summary, differentiation_notes, source_url,
  } = req.body || {};
  if (!domain_profile_id || !brand_name || !brand_name.trim()) {
    return sendError(res, 400, '請填寫要比較的產品/服務設定與競品品牌名稱。');
  }
  if (brand_name.trim().length > MAX_BRAND_NAME_LENGTH) {
    return sendError(res, 400, `品牌名稱請控制在 ${MAX_BRAND_NAME_LENGTH} 字以內。`);
  }
  const min = numOrNull(price_range_min);
  const max = numOrNull(price_range_max);
  if (min !== null && max !== null && min > max) {
    return sendError(res, 400, '價位下限不能大於上限。');
  }
  try {
    const profile = await loadProfile(user, domain_profile_id);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const [row] = await restRequest('competitor_brands', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id,
        brand_name: brand_name.trim(),
        price_range_min: min,
        price_range_max: max,
        price_currency: (price_currency || 'TWD').trim() || 'TWD',
        target_audience: (target_audience || '').trim(),
        positioning_summary: (positioning_summary || '').trim(),
        differentiation_notes: (differentiation_notes || '').trim(),
        source_url: source_url ? source_url.trim() : null,
      },
    });
    return res.status(200).json(row);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleUpdate(req, res, user, id) {
  const {
    brand_name, price_range_min, price_range_max, price_currency,
    target_audience, positioning_summary, differentiation_notes, source_url,
  } = req.body || {};
  const patch = {};
  if (brand_name !== undefined) {
    if (!brand_name.trim()) return sendError(res, 400, '品牌名稱不可為空。');
    if (brand_name.trim().length > MAX_BRAND_NAME_LENGTH) return sendError(res, 400, `品牌名稱請控制在 ${MAX_BRAND_NAME_LENGTH} 字以內。`);
    patch.brand_name = brand_name.trim();
  }
  if (price_range_min !== undefined) patch.price_range_min = numOrNull(price_range_min);
  if (price_range_max !== undefined) patch.price_range_max = numOrNull(price_range_max);
  if (price_currency !== undefined) patch.price_currency = (price_currency || 'TWD').trim() || 'TWD';
  if (target_audience !== undefined) patch.target_audience = (target_audience || '').trim();
  if (positioning_summary !== undefined) patch.positioning_summary = (positioning_summary || '').trim();
  if (differentiation_notes !== undefined) patch.differentiation_notes = (differentiation_notes || '').trim();
  if (source_url !== undefined) patch.source_url = source_url ? source_url.trim() : null;
  if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
  patch.updated_at = new Date().toISOString();

  try {
    // 只改動下限或只改動上限其中一邊時，仍要跟資料庫裡既有的另一邊比較，避免存進
    // 「下限大於上限」的髒資料（例如原本 min=100/max=500，這次只把 max 改成 50）。
    if (patch.price_range_min !== undefined || patch.price_range_max !== undefined) {
      const [existing] = await restRequest(`competitor_brands?id=eq.${id}&user_id=eq.${user.id}&select=price_range_min,price_range_max`);
      if (!existing) return sendError(res, 404, '找不到對應的競品資料。');
      const effectiveMin = patch.price_range_min !== undefined ? patch.price_range_min : existing.price_range_min;
      const effectiveMax = patch.price_range_max !== undefined ? patch.price_range_max : existing.price_range_max;
      if (effectiveMin !== null && effectiveMax !== null && effectiveMin > effectiveMax) {
        return sendError(res, 400, '價位下限不能大於上限。');
      }
    }
    const updated = await restRequest(`competitor_brands?id=eq.${id}&user_id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: patch,
    });
    if (!updated.length) return sendError(res, 404, '找不到對應的競品資料。');
    return res.status(200).json(updated[0]);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`competitor_brands?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id, domain_profile_id, action } = req.query || {};

  if (req.method === 'GET' && action === 'compare') {
    if (!domain_profile_id) return sendError(res, 400, '缺少 domain_profile_id。');
    return handleCompare(req, res, user, domain_profile_id);
  }

  if (id) {
    if (req.method === 'PATCH') return handleUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleDelete(req, res, user, id);
    return sendError(res, 405, '不支援的方法。');
  }

  if (req.method === 'GET') {
    if (!domain_profile_id) return sendError(res, 400, '缺少 domain_profile_id。');
    return handleList(req, res, user, domain_profile_id);
  }
  if (req.method === 'POST') return handleCreate(req, res, user);

  return sendError(res, 405, '不支援的方法。');
};
