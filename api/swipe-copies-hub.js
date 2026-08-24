const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call, parseJSON } = require('./_lib/provider');

// 這支合併了原本 2 支獨立檔案：
//   GET/POST      /api/swipe-copies      (無 id)
//   PUT/DELETE    /api/swipe-copies/:id  (有 id)
// 對應的 vercel.json rewrites 會把兩個路徑都導到這支檔案，前端網址不需要改。

const AI_BUDGET_MS = Number(process.env.SWIPE_AI_BUDGET_MS || 25000);
const TEMPLATE_AI_BUDGET_MS = Number(process.env.SWIPE_TEMPLATE_AI_BUDGET_MS || 25000);
const EDITABLE_FIELDS = ['industry_tag', 'framework_tag', 'emotion_tags', 'angle_type', 'block_breakdown', 'raw_content', 'extracted_pain_points'];

// 分析一篇廣告文案，回傳結構化結果。handleCreate（第一次分析）跟 handleReanalyze
// （用新邏輯重跑舊資料）共用同一套邏輯，避免兩處各寫一次 Prompt 之後不小心兜不起來。
//
// 分析重點的優先順序（也直接寫進了 system prompt）：
//   ①這篇文案鎖定的受眾痛點是什麼
//   ②文案為什麼判斷「打這個痛點」對這個受眾有效（why_targeted）
//   ③受眾透過這個產品/服務想被看見、想成為的形象或身份認同（identity_appeal）
// 情緒訴求手法（emotion_tags／angle_type）只是輔助資訊，重要性次之——這跟舊版「以情緒/框架
// 分類為主、痛點為附帶產物」的順序是反過來的。
//
// 另外舊版規則寫「文案幾乎沒有訴諸具體痛點就可以回傳空陣列」，導致很多主打品牌形象或情感訴求、
// 沒有把問題講得很白的文案（其實這類文案在真實世界很常見）分析完痛點是空的，帶入功能自然也沒東西
// 可帶。新版改成：只要文案裡看得出鎖定對象與語氣，就要求 AI 合理反推受眾痛點與身份渴望，
// 真正完全沒有受眾線索（例如純規格條列）才允許回傳空陣列。
async function analyzeSwipeCopy(raw_content, industryHint) {
  const system = `你是廣告文案策略分析師，同時也是市場洞察分析師。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
可用的文案區塊類型（block type）僅限於：hook, pain_agitate, solution, trust_proof, emotional_close, urgency, cta。
分析時請把「這篇文案鎖定了受眾的什麼痛點、為什麼判斷打這個痛點有效、受眾想被看見的形象是什麼」放在第一優先，
情緒訴求手法（emotion_tags／angle_type）只是輔助資訊，重要性次之，不要花太多篇幅在情緒標籤上。`;

  const prompt = `請分析以下廣告文案，並輸出：
- industry_tag：產業／領域（若使用者已提供提示「${industryHint || '無'}」，優先採用或修正它）
- framework_tag：主要行銷框架（如 AIDA、PAS，或最貼近的描述）
- block_breakdown：依文案實際內容拆解出的區塊順序，陣列，例如 ["hook","pain_agitate","solution","cta"]
- pain_points：這篇文案鎖定的受眾痛點與洞察，1-4 組，這是整份分析「最重要」的部分，每組包含：
  - surface_problem：表層問題（一句話，受眾自己意識得到的困擾）
  - deep_desire：背後的深層渴望（一句話）
  - why_targeted：文案為什麼判斷「打這個痛點」對這個受眾有效——依文案的訴求方式、產品定位、使用情境、語氣等
    脈絡合理推斷，寫 1-2 句具體原因，不要寫「因為很痛」這種空泛答案
  - identity_appeal：受眾透過這個產品/服務想被看見、想成為的形象或身份認同（1-2 句，要具體，例如「想被視為
    懂得在忙碌生活中把自己照顧好的專業人士」，而不是只寫「變健康」）
  - quote：文案中最能代表這個痛點的原文片段（不超過 40 字，不可整段照抄全文）
  即使文案主要走品牌形象／情感訴求、沒有直接寫出「問題句」，也請根據語氣、承諾、使用情境、鎖定的生活場景等
  線索合理反推受眾痛點與身份渴望，不要只因為沒有出現直白的問題描述就回傳空陣列；只有在文案完全找不到任何
  受眾線索（例如純規格條列、純法律聲明）時，才可以回傳空陣列。
- emotion_tags：這篇文案訴諸的情緒，陣列，1-3 個（次要資訊，供參考即可）
- angle_type：文案角度（fear／aspiration／logic 三選一，選最貼近的，次要資訊）

文案內容：
"""
${raw_content}
"""

輸出格式：{"industry_tag":"...","framework_tag":"...","block_breakdown":["..."],"pain_points":[{"surface_problem":"...","deep_desire":"...","why_targeted":"...","identity_appeal":"...","quote":"..."}],"emotion_tags":["..."],"angle_type":"..."}`;

  const raw = await call({ system, prompt, maxTokens: 1400, budgetMs: AI_BUDGET_MS });
  const classified = parseJSON(raw);
  const extractedPainPoints = (Array.isArray(classified.pain_points) ? classified.pain_points : [])
    .filter(p => p && p.surface_problem && p.deep_desire)
    .map(p => ({
      surface_problem: p.surface_problem,
      deep_desire: p.deep_desire,
      why_targeted: p.why_targeted || null,
      identity_appeal: p.identity_appeal || null,
      quote: p.quote || null,
    }));

  return {
    industry_tag: classified.industry_tag,
    framework_tag: classified.framework_tag,
    emotion_tags: classified.emotion_tags || [],
    angle_type: classified.angle_type,
    block_breakdown: classified.block_breakdown || [],
    extractedPainPoints,
  };
}

// ── 高轉化文案 → 填空模板 ──────────────────────────────────────────────
// 對應企劃書「Swipe 高轉化模板自動帶入」：把手法庫裡一篇已分析過的文案，改寫成使用者可以
// 直接套自己產品資訊的「填空模板」，而不是要使用者自己去揣摩怎麼仿寫。
// 設計原則：
//   ①保留原文案的結構／區塊順序／修辭節奏，但把跟特定產品、品牌、數字綁定的具體內容抽成
//     用中括號標示的佔位符（例如 [產品名稱]、[核心痛點]），輸出時不可逐字沿用原文句子。
//   ②依 block_breakdown 既有的區塊順序逐一改寫，不用另外設計新的區塊拆解邏輯，直接沿用
//     swipe_copies 分析時已經拆好的結構。
//   ③結果快取在 swipe_copies.fill_in_template（jsonb），避免使用者每次點開都重打一次 AI；
//     只有明確要求 regenerate=true 才會覆蓋重新產生。
async function generateFillInTemplate(swipe) {
  const blockOrder = Array.isArray(swipe.block_breakdown) && swipe.block_breakdown.length
    ? swipe.block_breakdown
    : ['hook', 'pain_agitate', 'solution', 'cta'];

  const system = `你是廣告文案策略師，任務是把一篇已分析過的廣告文案改寫成「可重複使用的填空模板」，
供使用者套用在自己的產品/服務上，而不是直接沿用這篇文案的內容。只能輸出合法 JSON，不能有任何前後
說明文字或 Markdown 圍籬。
規則：
1. 保留原文案的結構、修辭手法、句子節奏與情緒強度，但把所有跟「特定產品、品牌、數字、專有名詞、
   具體情境」綁定的內容改寫成用中括號標示的佔位符，例如 [產品名稱]、[核心痛點]、[具體數字或期限]、
   [信任背書]、[目標受眾的具體處境]。
2. 絕對不可逐字沿用原文案的句子——這是「改寫成可重複使用的模板」，不是摘錄，佔位符以外的
   句子也要是重新撰寫過的版本，只保留寫作手法、語氣與節奏。
3. 除非某個區塊的功能性質上就不需要客製內容（例如純粹的過場語氣詞），否則每個區塊的 template
   文字裡至少要有一個佔位符。
4. fill_guide 用一句話說明使用者在這個區塊該填入什麼、要注意什麼（例如語氣拿捏、建議長度）。
5. usage_note 是整份模板的使用說明（2-3 句），提醒使用者套用時務必換成自己產品的真實資訊，
   且此模板僅供參考手法架構，實際成效會因產業與受眾不同而有落差，不保證效果，發布前建議人工複核。`;

  const prompt = `以下是一篇已分析過的廣告文案（僅供學習其結構與手法，輸出時不可逐字複製原文字句）：
"""
${swipe.raw_content.slice(0, 2000)}
"""

【文案區塊順序】${blockOrder.join(' → ')}
【產業／領域】${swipe.industry_tag || '未分類'}
【行銷框架】${swipe.framework_tag || '未分類'}

請依照上方區塊順序，逐一改寫成填空模板，輸出格式：
{"blocks":[{"type":"hook","template":"...（含佔位符的改寫版本，不可逐字沿用原文）","fill_guide":"..."}, ...依區塊順序，共 ${blockOrder.length} 組],"usage_note":"..."}`;

  const raw = await call({ system, prompt, maxTokens: 1600, budgetMs: TEMPLATE_AI_BUDGET_MS });
  const parsed = parseJSON(raw);
  if (!parsed || !Array.isArray(parsed.blocks) || !parsed.blocks.length) {
    throw new Error('模型回應格式不符預期（缺少 blocks 陣列），請稍後再試一次。');
  }
  const blocks = parsed.blocks
    .filter(b => b && b.type && b.template)
    .map(b => ({ type: b.type, template: b.template, fill_guide: b.fill_guide || null }));
  if (!blocks.length) throw new Error('模型未能產生有效的模板區塊，請稍後再試一次。');

  return { blocks, usage_note: parsed.usage_note || null, generated_at: new Date().toISOString() };
}

// GET /api/swipe-copies/:id/template（可加 ?regenerate=true 強制重新產生並覆蓋快取）。
// 有快取且未要求重新產生時直接回傳快取內容，不消耗 AI 額度。
async function handleTemplate(req, res, user, id) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  const regenerate = (req.query || {}).regenerate === 'true';
  try {
    const [swipe] = await restRequest(
      `swipe_copies?id=eq.${id}&user_id=eq.${user.id}&select=id,raw_content,block_breakdown,industry_tag,framework_tag,fill_in_template`
    );
    if (!swipe) return sendError(res, 404, '找不到對應的範例文案。');

    if (!regenerate && swipe.fill_in_template) {
      return res.status(200).json({ template: swipe.fill_in_template, cached: true });
    }

    const template = await generateFillInTemplate(swipe);

    const [updated] = await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { fill_in_template: template },
    });

    return res.status(200).json({ template: (updated && updated.fill_in_template) || template, cached: false });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 資料庫瀏覽模式：依產業／框架／角度（下拉選單，候選值來自 handleFacets）與關鍵字（q，
// 對文案內文做 ilike 模糊比對）篩選。has_pain_points 因為要判斷「陣列長度 > 0」而不是
// 單純 null／not null，PostgREST 的 filter 語法不好表達，所以篩選條件本身丟給資料庫做，
// 這一項留在應用層做最後過濾——量體不大（單一使用者的手法庫），效能可以接受。
async function handleList(req, res, user) {
  const { q, industry_tag, framework_tag, angle_type, has_pain_points } = req.query || {};
  try {
    let query = `swipe_copies?user_id=eq.${user.id}&select=*&order=created_at.desc`;
    if (industry_tag) query += `&industry_tag=eq.${encodeURIComponent(industry_tag)}`;
    if (framework_tag) query += `&framework_tag=eq.${encodeURIComponent(framework_tag)}`;
    if (angle_type) query += `&angle_type=eq.${encodeURIComponent(angle_type)}`;
    if (q && q.trim()) query += `&raw_content=ilike.${encodeURIComponent('*' + q.trim() + '*')}`;

    let items = await restRequest(query);
    if (has_pain_points === 'true') {
      items = items.filter(x => Array.isArray(x.extracted_pain_points) && x.extracted_pain_points.length > 0);
    }
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 篩選下拉選單的候選值：只回傳這個使用者的手法庫裡「實際存在」的產業／框架／角度，
// 不用寫死清單，也不會出現選了之後篩不出任何結果的選項。
async function handleFacets(req, res, user) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  try {
    const rows = await restRequest(`swipe_copies?user_id=eq.${user.id}&select=industry_tag,framework_tag,angle_type`);
    const uniqSorted = key => [...new Set(rows.map(r => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    return res.status(200).json({
      industry_tag: uniqSorted('industry_tag'),
      framework_tag: uniqSorted('framework_tag'),
      angle_type: uniqSorted('angle_type'),
    });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreate(req, res, user) {
  const { raw_content, source_url, industry_tag } = req.body || {};
  if (!raw_content || !raw_content.trim()) return sendError(res, 400, '請貼上要分析的文案內容。');

  try {
    const analysis = await analyzeSwipeCopy(raw_content, industry_tag);

    const [saved] = await restRequest('swipe_copies', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        raw_content,
        source_url: source_url || null,
        industry_tag: analysis.industry_tag,
        framework_tag: analysis.framework_tag,
        emotion_tags: analysis.emotion_tags,
        angle_type: analysis.angle_type,
        block_breakdown: analysis.block_breakdown,
        extracted_pain_points: analysis.extractedPainPoints,
      },
    });
    return res.status(200).json(saved);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 用新邏輯重新分析一篇「已經存在」的範例文案——主要是給在舊版規則下被分析成
// 「沒有可用痛點」的舊資料一個機會，不用刪掉重貼一次。
async function handleReanalyze(req, res, user, id) {
  try {
    const [existing] = await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}&select=raw_content,industry_tag`);
    if (!existing) return sendError(res, 404, '找不到對應的範例文案。');

    const analysis = await analyzeSwipeCopy(existing.raw_content, existing.industry_tag);

    const [updated] = await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        industry_tag: analysis.industry_tag,
        framework_tag: analysis.framework_tag,
        emotion_tags: analysis.emotion_tags,
        angle_type: analysis.angle_type,
        block_breakdown: analysis.block_breakdown,
        extracted_pain_points: analysis.extractedPainPoints,
        // 重新分析可能改變區塊拆解或分類，先前快取的填空模板是依舊分析結果產生，
        // 不清掉的話會出現「模板」跟「分析結果」對不起來的情況，寧可讓使用者下次點開時
        // 重新產生一次，也不要顯示過時的模板。
        fill_in_template: null,
        edited_at: new Date().toISOString(),
      },
    });
    if (!updated) return sendError(res, 404, '找不到對應的範例文案。');
    return res.status(200).json(updated);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleUpdate(req, res, user, id) {
  if (req.body && req.body.reanalyze === true) return handleReanalyze(req, res, user, id);

  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    if (req.body && req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length) return sendError(res, 400, '沒有要更新的欄位。');
  // 原文或區塊拆解一旦被手動改過，舊的填空模板就不再對應目前內容，清掉快取讓下次重新產生。
  if (patch.raw_content !== undefined || patch.block_breakdown !== undefined) patch.fill_in_template = null;
  patch.edited_at = new Date().toISOString();

  try {
    const updated = await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: patch,
    });
    if (!updated.length) return sendError(res, 404, '找不到對應的範例文案。');
    return res.status(200).json(updated[0]);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`swipe_copies?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id, action } = req.query || {};

  if (action === 'facets') return handleFacets(req, res, user);

  if (id && action === 'template') return handleTemplate(req, res, user, id);

  if (id) {
    if (req.method === 'PUT') return handleUpdate(req, res, user, id);
    if (req.method === 'DELETE') return handleDelete(req, res, user, id);
    return sendError(res, 405, '不支援的方法。');
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};
