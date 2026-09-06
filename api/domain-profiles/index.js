const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { call, parseJSON } = require('../_lib/provider');

const norm = s => (s || '').trim().toLowerCase();
const PRIMARY_CONVERSION_EVENTS = new Set(['lead', 'purchase', 'complete_registration', 'schedule', 'add_to_cart']);

// 更精緻的價位帶（商業企劃書 P1 項目）：price_tier（low/high）維持不變，繼續作為既有分類依據
// （例如文案生成的預設區塊順序），這裡新增的具體價格區間與定位說明是「補充」而非「取代」，
// 兩者並存——沒填具體區間的舊資料仍可正常運作，只是競品比較等新功能的分析會比較粗略。
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

// ---------------- 競品定位比較（商業企劃書 P1 項目） ----------------
// 併入這支檔案而不是獨立成 api/competitor-brands-hub.js，是因為 Vercel Hobby 方案
// 一次部署最多只能有 12 個 Serverless Functions，原本 /api 底下已經剛好 12 個檔案，
// 再新增一個檔案會直接讓部署失敗。用 ?resource=competitors 分流，比照 ad-copies-hub.js
// 用 ?action= 在同一個檔案裡處理多種用途的既有作法，不增加函式數量。
//   GET    /api/competitor-brands?domain_profile_id=xxx                    列出這組設定底下的競品
//   GET    /api/competitor-brands?domain_profile_id=xxx&action=compare     AI 差異化定位分析（不寫入資料庫，
//                                                                          每次呼叫即時運算，競品異動後重新點擊即可拿到最新結果）
//   POST   /api/competitor-brands                                          新增一筆競品
//   PATCH  /api/competitor-brands?id=xxx                                    編輯既有競品
//   DELETE /api/competitor-brands?id=xxx                                    刪除既有競品
// 對應 vercel.json 的 rewrite：/api/competitor-brands -> /api/domain-profiles?resource=competitors

const COMPARE_AI_BUDGET_MS = Number(process.env.COMPETITOR_COMPARE_AI_BUDGET_MS || 30000);
const MAX_BRAND_NAME_LENGTH = 60;
const MAX_COMPETITORS_FOR_COMPARE = 12; // 避免一次塞太多競品進 prompt，拖慢分析也稀釋重點

function competitorPriceRangeLine(min, max, currency) {
  if (min === null && max === null) return '未提供';
  const cur = currency || 'TWD';
  if (min !== null && max !== null) return `${cur} ${min}–${max}`;
  if (min !== null) return `${cur} ${min} 以上`;
  return `${cur} ${max} 以下`;
}

async function competitorLoadProfile(user, profileId) {
  const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
  return profile || null;
}

async function competitorHandleList(req, res, user, profileId) {
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
// 不留歷史版本——理由跟報告資料庫的設計一致，避免「分析結果跟畫面上的競品清單對不上」的問題。
// 少量競品、短 prompt，重新運算的成本不高，不需要額外快取一層。
async function competitorHandleCompare(req, res, user, profileId) {
  try {
    const profile = await competitorLoadProfile(user, profileId);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const competitors = await restRequest(
      `competitor_brands?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.asc`
    );
    if (!competitors.length) {
      return res.status(200).json({ message: '尚未新增任何競品品牌，請先新增至少 1 個競品再進行差異化分析。' });
    }

    const ourAudiences = Array.isArray(profile.audiences) && profile.audiences.length
      ? profile.audiences.join('、') : (profile.audience || '未設定');
    const ourPriceLine = competitorPriceRangeLine(profile.price_range_min, profile.price_range_max, profile.price_currency);
    const ourPositionNote = profile.price_position_note || '（未填寫，僅有低單價／高客單的粗略分類）';
    const ourPriceTierLabel = profile.price_tier === 'high' ? '高客單／建立信任' : '低單價／快速決策';

    const list = competitors.slice(0, MAX_COMPETITORS_FOR_COMPARE);
    const competitorLines = list.map((c, i) =>
      `[${i}] 品牌：${c.brand_name}／價位帶：${competitorPriceRangeLine(c.price_range_min, c.price_range_max, c.price_currency)}／` +
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

async function competitorHandleCreate(req, res, user) {
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
    const profile = await competitorLoadProfile(user, domain_profile_id);
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

async function competitorHandleUpdate(req, res, user, id) {
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

async function competitorHandleDelete(req, res, user, id) {
  try {
    await restRequest(`competitor_brands?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCompetitorsResource(req, res, user) {
  const { id, domain_profile_id, action } = req.query || {};

  if (req.method === 'GET' && action === 'compare') {
    if (!domain_profile_id) return sendError(res, 400, '缺少 domain_profile_id。');
    return competitorHandleCompare(req, res, user, domain_profile_id);
  }

  if (id) {
    if (req.method === 'PATCH') return competitorHandleUpdate(req, res, user, id);
    if (req.method === 'DELETE') return competitorHandleDelete(req, res, user, id);
    return sendError(res, 405, '不支援的方法。');
  }

  if (req.method === 'GET') {
    if (!domain_profile_id) return sendError(res, 400, '缺少 domain_profile_id。');
    return competitorHandleList(req, res, user, domain_profile_id);
  }
  if (req.method === 'POST') return competitorHandleCreate(req, res, user);

  return sendError(res, 405, '不支援的方法。');
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  // 競品比較模組的請求走這裡分流，跟下面既有的 domain_profiles CRUD 完全獨立，
  // 兩邊的 `id` query 參數意義不同（分別是競品 id／產品設定 id），靠 resource 參數避免混淆。
  if ((req.query || {}).resource === 'competitors') {
    return handleCompetitorsResource(req, res, user);
  }

  const { id } = req.query || {};

  if (req.method === 'POST') {
    const {
      domain_tag, audience, audiences, price_tier, constraints,
      product_name, core_selling_point, solution_description, trust_proof,
      primary_conversion_event, workflow_notes,
      price_range_min, price_range_max, price_currency, price_position_note,
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
    const priceMin = numOrNull(price_range_min);
    const priceMax = numOrNull(price_range_max);
    if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
      return sendError(res, 400, '價位下限不能大於上限。');
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
          price_range_min: priceMin,
          price_range_max: priceMax,
          price_currency: (price_currency || 'TWD').trim() || 'TWD',
          price_position_note: (price_position_note || '').trim(),
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
      price_range_min, price_range_max, price_currency, price_position_note,
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
    if (price_range_min !== undefined) patch.price_range_min = numOrNull(price_range_min);
    if (price_range_max !== undefined) patch.price_range_max = numOrNull(price_range_max);
    if (price_currency !== undefined) patch.price_currency = (price_currency || 'TWD').trim() || 'TWD';
    if (price_position_note !== undefined) patch.price_position_note = (price_position_note || '').trim();
    if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
    try {
      // 只改動 min 或只改動 max 其中一邊時，仍要跟資料庫裡既有的另一邊比較，避免存進
      // 「下限大於上限」的髒資料（例如原本 min=100/max=500，這次只把 max 改成 50）。
      if (patch.price_range_min !== undefined || patch.price_range_max !== undefined) {
        const [existing] = await restRequest(`domain_profiles?id=eq.${id}&user_id=eq.${user.id}&select=price_range_min,price_range_max`);
        if (existing) {
          const effectiveMin = patch.price_range_min !== undefined ? patch.price_range_min : existing.price_range_min;
          const effectiveMax = patch.price_range_max !== undefined ? patch.price_range_max : existing.price_range_max;
          if (effectiveMin !== null && effectiveMax !== null && effectiveMin !== undefined && effectiveMax !== undefined && effectiveMin > effectiveMax) {
            return sendError(res, 400, '價位下限不能大於上限。');
          }
        }
      }
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
