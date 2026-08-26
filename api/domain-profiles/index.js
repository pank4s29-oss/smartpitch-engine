const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');

const norm = s => (s || '').trim().toLowerCase();
const PRIMARY_CONVERSION_EVENTS = new Set(['lead', 'purchase', 'complete_registration', 'schedule', 'add_to_cart']);

// 目標受眾改為可複選陣列：統一在這裡做清理（trim、去空字串、去重複），
// 前端可能傳來字串（單一受眾，向後相容）或陣列（多個受眾），這裡一律正規化成
// 一個去重過、有序的字串陣列，避免髒資料（例如重複新增同一個受眾兩次）寫進資料庫。
function normalizeAudiences(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  const seen = new Set();
  const cleaned = [];
  for (const a of arr) {
    const trimmed = (a || '').trim();
    if (!trimmed) continue;
    const key = norm(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
  }
  return cleaned;
}

// 兩組受眾陣列是否視為「相同」：忽略大小寫／前後空白／順序，比較正規化後的集合。
function sameAudienceSet(a, b) {
  const setA = new Set((a || []).map(norm));
  const setB = new Set((b || []).map(norm));
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id } = req.query || {};

  if (req.method === 'POST') {
    const {
      domain_tag, audience, audiences, price_tier, constraints,
      product_name, core_selling_point, solution_description, trust_proof,
      primary_conversion_event, workflow_notes,
    } = req.body || {};
    // audiences 是新欄位（陣列）；audience（單一字串）保留相容，若前端還沒更新也不會壞掉。
    const audienceList = normalizeAudiences(audiences !== undefined ? audiences : audience);
    if (!domain_tag || !audienceList.length || !price_tier) {
      return sendError(res, 400, '請填寫產業／領域、至少一個目標受眾與價格帶。');
    }
    if (!product_name || !solution_description) {
      return sendError(res, 400, '請填寫產品／服務名稱與解決方案說明，這是後續萃取痛點與產出報告會用到的核心資訊。');
    }
    if (primary_conversion_event && !PRIMARY_CONVERSION_EVENTS.has(primary_conversion_event)) {
      return sendError(res, 400, '不支援的主要轉換事件。');
    }
    try {
      // 重複偵測：同一使用者底下，領域＋受眾組合（忽略大小寫、前後空白與順序）相同就視為重複，
      // 不直接建立新的一筆，而是回傳既有那筆讓前端詢問使用者是否改用它。
      const existing = await restRequest(`domain_profiles?user_id=eq.${user.id}&select=id,domain_tag,audiences`);
      const dup = existing.find(p => norm(p.domain_tag) === norm(domain_tag) && sameAudienceSet(p.audiences, audienceList));
      if (dup) {
        return res.status(409).json({
          error: '已經有一組領域／受眾完全相同的設定了。',
          duplicate: true,
          existing_id: dup.id,
          existing_label: `${dup.domain_tag}／${(dup.audiences || []).join('、')}`,
        });
      }

      const [profile] = await restRequest('domain_profiles', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          user_id: user.id,
          domain_tag,
          audiences: audienceList,
          price_tier,
          business_constraints: constraints || [],
          product_name,
          core_selling_point: core_selling_point || null,
          solution_description,
          trust_proof: trust_proof || null,
          primary_conversion_event: primary_conversion_event || 'lead',
          workflow_notes: workflow_notes || '',
        },
      });
      return res.status(200).json(profile);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'GET') {
    try {
      const profiles = await restRequest(
        `domain_profiles?user_id=eq.${user.id}&order=created_at.desc`
      );
      return res.status(200).json(profiles);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'DELETE' && (req.query || {}).action === 'clear-all') {
    // 清空這個使用者名下「所有」領域設定與其關聯資料（痛點、潛在受眾地圖、解決方案、
    // 語料歸類、洞察報告、文案生成紀錄）。依外鍵相依順序由子到父刪除，避免因約束擋下而失敗。
    // 不影響：尚未歸類到任何領域設定的語料（domain_profile_id 為 null）、產業文案手法庫。
    try {
      await restRequest(`copy_blocks?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`copy_variants?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`generation_params?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`generation_requests?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`audience_reports?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`insight_reports?user_id=eq.${user.id}`, { method: 'DELETE' }).catch(() => {});
      await restRequest(`product_solutions?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`ad_performance_history?user_id=eq.${user.id}`, { method: 'DELETE' }).catch(() => {});
      await restRequest(`ad_performance_current?user_id=eq.${user.id}`, { method: 'DELETE' }).catch(() => {});
      await restRequest(`ad_copies?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`audience_segments?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`audience_pain_points?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`raw_customer_feedback?user_id=eq.${user.id}&domain_profile_id=not.is.null`, { method: 'DELETE' });
      await restRequest(`domain_profiles?user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ cleared: true });
    } catch (err) {
      return sendError(res, 500, `清空失敗，可能有資料未能刪除：${err.message}`);
    }
  }

  if (req.method === 'PATCH') {
    if (!id) return sendError(res, 400, '缺少 id。');
    const {
      domain_tag, audience, audiences, price_tier, constraints,
      product_name, core_selling_point, solution_description, trust_proof,
      primary_conversion_event, workflow_notes,
    } = req.body || {};
    const patch = {};
    if (domain_tag !== undefined) patch.domain_tag = domain_tag;
    if (audiences !== undefined || audience !== undefined) {
      const audienceList = normalizeAudiences(audiences !== undefined ? audiences : audience);
      if (!audienceList.length) return sendError(res, 400, '至少需要保留一個目標受眾。');
      patch.audiences = audienceList;
    }
    if (price_tier !== undefined) patch.price_tier = price_tier;
    // business_constraints（呈現媒介限制，如「不露臉」「不使用短影音」）先前只有在建立時會寫入，
    // 編輯既有設定時漏掉了這個欄位，導致使用者事後修改限制條件永遠不會生效。
    if (constraints !== undefined) patch.business_constraints = constraints || [];
    if (product_name !== undefined) patch.product_name = product_name;
    if (core_selling_point !== undefined) patch.core_selling_point = core_selling_point;
    if (solution_description !== undefined) patch.solution_description = solution_description;
    if (trust_proof !== undefined) patch.trust_proof = trust_proof;
    if (primary_conversion_event !== undefined) {
      if (!PRIMARY_CONVERSION_EVENTS.has(primary_conversion_event)) return sendError(res, 400, '不支援的主要轉換事件。');
      patch.primary_conversion_event = primary_conversion_event;
    }
    if (workflow_notes !== undefined) patch.workflow_notes = workflow_notes || '';
    if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
    try {
      const updated = await restRequest(`domain_profiles?id=eq.${id}&user_id=eq.${user.id}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: patch,
      });
      if (!updated.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
      return res.status(200).json(updated[0]);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method === 'DELETE') {
    if (!id) return sendError(res, 400, '缺少 id。');
    try {
      await restRequest(`domain_profiles?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    } catch (err) {
      // 若資料庫設有外鍵約束（例如仍有痛點／語料掛在這個 profile 底下且非 cascade），
      // 刪除會被擋下，把原始錯誤訊息回傳讓使用者知道原因，而不是吞掉變成看不懂的失敗。
      return sendError(res, 409, `無法刪除，可能仍有關聯資料存在：${err.message}`);
    }
  }

  return sendError(res, 405, '不支援的方法。');
};
