const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');

const norm = s => (s || '').trim().toLowerCase();

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id } = req.query || {};

  if (req.method === 'POST') {
    const {
      domain_tag, audience, price_tier, constraints,
      product_name, core_selling_point, solution_description, trust_proof,
    } = req.body || {};
    if (!domain_tag || !audience || !price_tier) {
      return sendError(res, 400, '請填寫產業／領域、目標受眾與價格帶。');
    }
    if (!product_name || !solution_description) {
      return sendError(res, 400, '請填寫產品／服務名稱與解決方案說明，這是後續萃取痛點與產出報告會用到的核心資訊。');
    }
    try {
      // 重複偵測：同一使用者底下，領域＋受眾（忽略大小寫與前後空白）相同就視為重複，
      // 不直接建立新的一筆，而是回傳既有那筆讓前端詢問使用者是否改用它。
      const existing = await restRequest(`domain_profiles?user_id=eq.${user.id}&select=id,domain_tag,audience`);
      const dup = existing.find(p => norm(p.domain_tag) === norm(domain_tag) && norm(p.audience) === norm(audience));
      if (dup) {
        return res.status(409).json({
          error: '已經有一組領域／受眾完全相同的設定了。',
          duplicate: true,
          existing_id: dup.id,
          existing_label: `${dup.domain_tag}／${dup.audience}`,
        });
      }

      const [profile] = await restRequest('domain_profiles', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          user_id: user.id,
          domain_tag,
          audience,
          price_tier,
          business_constraints: constraints || [],
          product_name,
          core_selling_point: core_selling_point || null,
          solution_description,
          trust_proof: trust_proof || null,
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
      await restRequest(`insight_reports?user_id=eq.${user.id}`, { method: 'DELETE' });
      await restRequest(`product_solutions?user_id=eq.${user.id}`, { method: 'DELETE' });
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
      domain_tag, audience, price_tier, constraints,
      product_name, core_selling_point, solution_description, trust_proof,
    } = req.body || {};
    const patch = {};
    if (domain_tag !== undefined) patch.domain_tag = domain_tag;
    if (audience !== undefined) patch.audience = audience;
    if (price_tier !== undefined) patch.price_tier = price_tier;
    // business_constraints（呈現媒介限制，如「不露臉」「不使用短影音」）先前只有在建立時會寫入，
    // 編輯既有設定時漏掉了這個欄位，導致使用者事後修改限制條件永遠不會生效。
    if (constraints !== undefined) patch.business_constraints = constraints || [];
    if (product_name !== undefined) patch.product_name = product_name;
    if (core_selling_point !== undefined) patch.core_selling_point = core_selling_point;
    if (solution_description !== undefined) patch.solution_description = solution_description;
    if (trust_proof !== undefined) patch.trust_proof = trust_proof;
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
