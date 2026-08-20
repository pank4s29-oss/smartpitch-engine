const { getUserFromRequest, restRequest, sendError } = require('../../../_lib/supabase');

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id: profileId } = req.query;

  if (req.method === 'GET') {
    try {
      const solutions = await restRequest(
        `product_solutions?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.desc`
      );
      return res.status(200).json(solutions);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // 編輯既有的解決方案：用 ?solution_id= 指定要修改哪一筆，PATCH body 帶要更新的欄位。
  if (req.method === 'PATCH') {
    const { solution_id } = req.query || {};
    if (!solution_id) return sendError(res, 400, '缺少 solution_id。');
    const { product_name, core_selling_point, solution_description, trust_proof } = req.body || {};
    const patch = {};
    if (product_name !== undefined) patch.product_name = product_name;
    if (core_selling_point !== undefined) patch.core_selling_point = core_selling_point;
    if (solution_description !== undefined) patch.solution_description = solution_description;
    if (trust_proof !== undefined) patch.trust_proof = trust_proof || null;
    if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
    try {
      const updated = await restRequest(
        `product_solutions?id=eq.${solution_id}&domain_profile_id=eq.${profileId}&user_id=eq.${user.id}`,
        { method: 'PATCH', prefer: 'return=representation', body: patch }
      );
      if (!updated.length) return sendError(res, 404, '找不到對應的解決方案。');
      return res.status(200).json(updated[0]);
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // 刪除既有的解決方案，讓使用者可以重新配對。
  if (req.method === 'DELETE') {
    const { solution_id } = req.query || {};
    if (!solution_id) return sendError(res, 400, '缺少 solution_id。');
    try {
      await restRequest(
        `product_solutions?id=eq.${solution_id}&domain_profile_id=eq.${profileId}&user_id=eq.${user.id}`,
        { method: 'DELETE' }
      );
      return res.status(200).json({ deleted: true });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');

  const { pain_point_id, product_name, core_selling_point, solution_description, trust_proof } = req.body || {};
  if (!pain_point_id || !product_name || !core_selling_point || !solution_description) {
    return sendError(res, 400, '請完整填寫產品名稱、核心賣點與解決方案說明。');
  }

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=id`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    const [point] = await restRequest(`audience_pain_points?id=eq.${pain_point_id}&user_id=eq.${user.id}&domain_profile_id=eq.${profileId}&select=id`);
    if (!point) return sendError(res, 404, '找不到對應的痛點，或痛點不屬於此領域設定。');

    const [solution] = await restRequest('product_solutions', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id: profileId,
        pain_point_id,
        product_name,
        core_selling_point,
        solution_description,
        trust_proof: trust_proof || null,
      },
    });
    return res.status(200).json(solution);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
