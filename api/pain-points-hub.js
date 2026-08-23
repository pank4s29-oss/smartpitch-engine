const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call, parseJSON } = require('./_lib/provider');

// 這支合併了原本 3 支獨立檔案：
//   POST /api/domain-profiles/:id/pain-points          (action 未帶)
//   GET  /api/domain-profiles/:id/pain-points/suggest   (action=suggest)
//   POST /api/domain-profiles/:id/pain-points/extract   (action=extract)
// 對應的 vercel.json rewrites 會把這三個路徑都導到這支檔案，前端網址不需要改。

const SUGGEST_AI_BUDGET_MS = Number(process.env.SUGGEST_AI_BUDGET_MS || 40000);
const EXTRACT_AI_BUDGET_MS = Number(process.env.EXTRACT_AI_BUDGET_MS || 25000);
const SEGMENTS_AI_BUDGET_MS = Number(process.env.SEGMENTS_AI_BUDGET_MS || 30000);
const EXTRACT_MAX_BATCH_SIZE = 20;

const norm = s => (s || '').trim().toLowerCase();

// ── 跨批次去重合併 ──────────────────────────────────────────────────────
// 語料量一大，使用者通常得分好幾批送去分析（單批最多 EXTRACT_MAX_BATCH_SIZE 筆），
// 同一個痛點很容易在不同批次裡各自被 AI 萃取出來一次，變成好幾筆幾乎一樣的紀錄，
// 稀釋掉「這個痛點到底有多少真實佐證」的可信度。
// 這裡用「字元 bigram」做 Jaccard 相似度來判斷兩個痛點是否應視為同一個——中文沒有天然的
// 分詞界線，bigram 是不需要額外 NLP 套件、也不用再多打一次 AI 的簡單做法（AI 呼叫額度本來就
// 吃緊，能用純運算解決的步驟就不要再消耗額度）。
function bigrams(s) {
  const clean = norm(s).replace(/[\s、，。！？~～\-()（）「」『』]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  if (!set.size && clean) set.add(clean); // 只有 1 個字時退化成整串比對，避免 bigram 集合永遠是空的
  return set;
}
function bigramSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
// 表層問題與深層渴望都要達到一定相似度才視為同一個痛點——只有其中一句像，
// 常常只是主題相近但實際上是不同的痛點，不應該被合併成一筆。
const DUP_SURFACE_THRESHOLD = 0.45;
const DUP_DESIRE_THRESHOLD = 0.35;
function findExistingMatch(candidate, existingPoints, usedIds) {
  let best = null, bestScore = 0;
  for (const ep of existingPoints) {
    if (usedIds.has(ep.id)) continue; // 同一批次裡若有兩個 candidate 都很像，只讓最像的那個去合併，避免互相覆蓋
    const surfaceSim = bigramSimilarity(candidate.surface_problem, ep.surface_problem);
    const desireSim = bigramSimilarity(candidate.deep_desire, ep.deep_desire);
    if (surfaceSim >= DUP_SURFACE_THRESHOLD && desireSim >= DUP_DESIRE_THRESHOLD) {
      const score = surfaceSim + desireSim;
      if (score > bestScore) { bestScore = score; best = ep; }
    }
  }
  return best;
}

async function handleList(req, res, user, profileId) {
  try {
    const points = await restRequest(
      `audience_pain_points?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=*&order=created_at.desc`
    );
    return res.status(200).json(points);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreate(req, res, user, profileId) {
  const { surface_problem, deep_desire, detail, source } = req.body || {};
  if (!surface_problem || !deep_desire) {
    return sendError(res, 400, '請填寫表層問題與深層渴望。');
  }
  try {
    const owned = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=id`);
    if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const [point] = await restRequest('audience_pain_points', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id: profileId,
        surface_problem,
        deep_desire,
        detail: detail || null,
        source: source || 'user_input',
      },
    });
    return res.status(200).json(point);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 人工複核：確認／修改／駁回一筆痛點。這是「痛點驗證層」的核心操作，
// 使用者標註的結果（review_status）會直接影響 insight-reports 報告裡的覆蓋率統計。
async function handleReview(req, res, user, profileId) {
  const { pain_point_id, review_status, surface_problem, deep_desire, detail } = req.body || {};
  if (!pain_point_id) return sendError(res, 400, '缺少 pain_point_id。');
  if (!['confirmed', 'edited', 'rejected', 'unreviewed'].includes(review_status)) {
    return sendError(res, 400, 'review_status 必須是 confirmed／edited／rejected／unreviewed 其中之一。');
  }
  const patch = { review_status };
  if (review_status === 'edited') {
    if (surface_problem) patch.surface_problem = surface_problem;
    if (deep_desire) patch.deep_desire = deep_desire;
    if (detail !== undefined) patch.detail = detail;
  }
  try {
    const updated = await restRequest(
      `audience_pain_points?id=eq.${pain_point_id}&domain_profile_id=eq.${profileId}&user_id=eq.${user.id}`,
      { method: 'PATCH', prefer: 'return=representation', body: patch }
    );
    if (!updated.length) return sendError(res, 404, '找不到對應的痛點。');
    return res.status(200).json(updated[0]);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 刪除一筆痛點。pain_point_id 放在 request body（與 PATCH 複核的慣例一致）。
// 若舊資料底下還掛著 product_solutions（舊版每個痛點各自的解決方案），先一併清掉，
// 避免外鍵約束擋下刪除。
async function handleDelete(req, res, user, profileId) {
  const { pain_point_id } = req.body || {};
  if (!pain_point_id) return sendError(res, 400, '缺少 pain_point_id。');
  try {
    await restRequest(
      `product_solutions?pain_point_id=eq.${pain_point_id}&user_id=eq.${user.id}`,
      { method: 'DELETE' }
    ).catch(() => {}); // 舊資料表可能沒有對應資料，刪除失敗不影響主流程

    await restRequest(
      `audience_pain_points?id=eq.${pain_point_id}&domain_profile_id=eq.${profileId}&user_id=eq.${user.id}`,
      { method: 'DELETE' }
    );
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, `刪除失敗：${err.message}`);
  }
}

async function dispatchDefault(req, res, user, profileId) {
  if (req.method === 'GET') return handleList(req, res, user, profileId);
  if (req.method === 'POST') return handleCreate(req, res, user, profileId);
  if (req.method === 'PATCH') return handleReview(req, res, user, profileId);
  if (req.method === 'DELETE') return handleDelete(req, res, user, profileId);
  return sendError(res, 405, '不支援的方法。');
}

async function handleSuggest(req, res, user, profileId) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const system = '你是市場洞察分析師。只能輸出合法的 JSON 陣列，不要有任何前後說明文字或 Markdown 圍籬。';
    const prompt = `領域：${profile.domain_tag}
目標受眾：${profile.audience}
價格帶：${profile.price_tier === 'low' ? '低單價／快速決策' : '高客單價／建立信任'}

請提出 3 組該受眾常見的痛點草稿，每組包含：
- surface_problem：表層問題（一句話）
- deep_desire：背後的深層渴望（一句話）
- detail：完整陳述（4-6 句，150-250 字），內容至少涵蓋：①這個痛點通常在什麼具體情境或時間點浮現、②背後的成因或誘發因素、③對受眾造成的實際影響（時間、金錢、情緒、人際關係等面向擇要說明）、④這個受眾過去可能嘗試過但沒有真正解決的做法。寫得像是可以直接放進受眾研究報告的一段敘述，讓使用者不用再腦補就能理解全貌。

輸出格式：[{"surface_problem":"...","deep_desire":"...","detail":"..."}, ...]`;

    const raw = await call({ system, prompt, maxTokens: 1400, budgetMs: SUGGEST_AI_BUDGET_MS });
    const suggestions = parseJSON(raw);
    return res.status(200).json(suggestions);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleExtract(req, res, user, profileId) {
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
  const { feedback_ids } = req.body || {};
  if (!Array.isArray(feedback_ids) || !feedback_ids.length) {
    return sendError(res, 400, '請至少選擇一筆語料進行分析（feedback_ids）。');
  }
  if (feedback_ids.length > EXTRACT_MAX_BATCH_SIZE) {
    return sendError(res, 400, `單次最多分析 ${EXTRACT_MAX_BATCH_SIZE} 筆語料，請分批進行。`);
  }

  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const idFilter = feedback_ids.map(id => `"${id}"`).join(',');
    const feedbacks = await restRequest(
      `raw_customer_feedback?id=in.(${idFilter})&user_id=eq.${user.id}&domain_profile_id=eq.${profileId}&select=id,raw_text`
    );
    if (!feedbacks.length) return sendError(res, 404, '找不到對應的語料，請確認是否已歸類到此產品/服務設定。');

    const system = `你是市場洞察分析師，專長是從真實顧客語料中萃取痛點，而不是憑常識推測。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
規則：
1. 每個痛點都必須有語料佐證，evidence_indices 要列出所有支持這個痛點的語料編號（從 0 開始）。
2. quote 從對應語料原文擷取最能代表這個痛點的一小段（不超過 40 字），不可整段照抄。
3. detail 是給使用者看的完整陳述（4-6 句，150-250 字），至少涵蓋：①這個痛點通常在語料描述的什麼情境或時間點出現、②語料中透露出的成因、③造成的實際困擾或後果（具體一點，不要只寫「很困擾」）、④語料中有沒有透露出使用者曾嘗試過什麼因應方式、效果如何。內容必須根據語料本身，不可額外腦補語料沒提到的細節；若語料資訊不足以支撐某一項，可以省略該項，但整體仍需具體、不可流於空泛套語。
4. 不要輸出語料裡完全沒有依據、純粹用常識腦補的痛點。
5. 同一個痛點如果在多筆語料中都有出現，要合併成一條、evidence_indices 列出全部相關編號，不要重複拆成多條。`;

    const prompt = `【領域】${profile.domain_tag}
【目標受眾】${profile.audience}

以下是 ${feedbacks.length} 筆真實顧客語料（編號從 0 開始）：
${feedbacks.map((f, i) => `[${i}] ${f.raw_text.slice(0, 800)}`).join('\n')}

請萃取這些語料中反映出的受眾痛點，每個痛點包含：
- surface_problem：表層問題（一句話）
- deep_desire：背後的深層渴望（一句話）
- detail：完整陳述（4-6 句，150-250 字），具體說明發生情境、成因、實際影響與過去嘗試過的因應方式，根據語料內容撰寫
- evidence_indices：支持此痛點的語料編號陣列，例如 [0,2]
- quote：從語料中擷取的代表性原文片段（不超過 40 字）

輸出格式：
{"pain_points":[{"surface_problem":"...","deep_desire":"...","detail":"...","evidence_indices":[0,2],"quote":"..."}]}`;

    const raw = await call({ system, prompt, maxTokens: 5000, budgetMs: EXTRACT_AI_BUDGET_MS });
    const parsed = parseJSON(raw);
    if (!parsed || !Array.isArray(parsed.pain_points)) {
      throw new Error('模型回應格式不符預期（缺少 pain_points 陣列），請稍後再試一次。');
    }
    if (!parsed.pain_points.length) {
      return res.status(200).json({ pain_points: [], message: '這批語料中沒有萃取到有明確佐證的痛點，可嘗試選擇其他語料。' });
    }

    const candidates = parsed.pain_points.map(p => {
      const indices = Array.isArray(p.evidence_indices) ? p.evidence_indices.filter(i => feedbacks[i]) : [];
      const evidence_source = indices.map(i => ({ raw_customer_feedback_id: feedbacks[i].id, quote: p.quote || null }));
      return {
        surface_problem: p.surface_problem,
        deep_desire: p.deep_desire,
        detail: p.detail || null,
        evidence_source,
      };
    }).filter(c => c.surface_problem && c.deep_desire && c.evidence_source.length);

    if (!candidates.length) {
      return res.status(200).json({ pain_points: [], message: '模型回傳的痛點缺少有效佐證，未寫入資料庫，可嘗試選擇其他語料。' });
    }

    // 全域置信度：分母改用「這個產品/服務設定底下匯入過的所有語料筆數」，而不是這次分析的
    // 批次大小。使用者常常得把語料拆成好幾批送去分析（單批最多 EXTRACT_MAX_BATCH_SIZE 筆），
    // 如果分母只看當下這批，同一個痛點的置信度會因為切分方式不同而忽高忽低，
    // 沒辦法反映「這個痛點在你全部語料中的實際佔比」。
    const allFeedbackIds = await restRequest(
      `raw_customer_feedback?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=id`
    );
    const totalFeedbackCount = Math.max(allFeedbackIds.length, feedbacks.length);

    // 跨批次去重合併：跟這個產品/服務設定底下「已存在」的痛點比對，相似度夠高就合併證據，
    // 而不是各自散落成好幾筆幾乎一樣的紀錄（見檔案開頭的 findExistingMatch 說明）。
    const existingPoints = await restRequest(
      `audience_pain_points?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&select=id,surface_problem,deep_desire,evidence_source,review_status`
    );

    const usedExistingIds = new Set();
    const toInsert = [];
    const toMerge = [];
    candidates.forEach(c => {
      const match = findExistingMatch(c, existingPoints, usedExistingIds);
      if (!match) { toInsert.push(c); return; }
      usedExistingIds.add(match.id);
      const existingEvidence = Array.isArray(match.evidence_source) ? match.evidence_source : [];
      const seenFeedbackIds = new Set(existingEvidence.map(e => e.raw_customer_feedback_id));
      const newEvidence = c.evidence_source.filter(e => !seenFeedbackIds.has(e.raw_customer_feedback_id));
      toMerge.push({ existing: match, mergedEvidence: existingEvidence.concat(newEvidence), hasNewEvidence: newEvidence.length > 0 });
    });

    const insertRows = toInsert.map(c => ({
      user_id: user.id,
      domain_profile_id: profileId,
      surface_problem: c.surface_problem,
      deep_desire: c.deep_desire,
      detail: c.detail,
      source: 'raw_feedback_extraction',
      evidence_source: c.evidence_source,
      confidence_score: Math.min(1, c.evidence_source.length / totalFeedbackCount),
      review_status: 'unreviewed',
    }));

    const savedNew = insertRows.length
      ? await restRequest('audience_pain_points', { method: 'POST', prefer: 'return=representation', body: insertRows })
      : [];

    const savedMerged = [];
    for (const m of toMerge) {
      if (!m.hasNewEvidence) { savedMerged.push(m.existing); continue; } // 沒有新證據就不用多打一次 PATCH
      const patch = {
        evidence_source: m.mergedEvidence,
        confidence_score: Math.min(1, m.mergedEvidence.length / totalFeedbackCount),
      };
      // 已經被使用者確認／編輯過的痛點，尊重使用者的判斷，不覆蓋文字內容，
      // 只補上新的證據並重新計算置信度。
      const [updated] = await restRequest(
        `audience_pain_points?id=eq.${m.existing.id}&user_id=eq.${user.id}`,
        { method: 'PATCH', prefer: 'return=representation', body: patch }
      );
      savedMerged.push(updated || m.existing);
    }

    const allSaved = [...savedNew, ...savedMerged];

    const pointIdsByFeedback = new Map();
    allSaved.forEach(point => {
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

    const message = toMerge.length
      ? `已萃取 ${candidates.length} 筆痛點：${savedNew.length} 筆為新痛點，另外 ${toMerge.length} 筆與既有痛點高度相似，已合併證據並更新置信度（不會出現重複的痛點卡片）。`
      : `已萃取 ${savedNew.length} 筆有語料佐證的痛點。`;

    return res.status(200).json({ pain_points: allSaved, created_count: savedNew.length, merged_count: toMerge.length, message });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 潛在／隱藏受眾地圖：從目前已通過複核（或至少未被駁回）的痛點出發，
// 讓 AI 反推「這些痛點分別可能對應到哪些更細分的受眾輪廓」——不寫入資料庫，
// 每次呼叫都是即時分析，就像 suggest 一樣是可重複產生的草稿性質。
async function handleSegments(req, res, user, profileId) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const points = await restRequest(
      `audience_pain_points?domain_profile_id=eq.${profileId}&user_id=eq.${user.id}&review_status=neq.rejected&select=id,surface_problem,deep_desire`
    );
    if (!points.length) {
      return res.status(200).json({ segments: [], message: '尚無可分析的痛點（已駁回的痛點不計入），請先建立或萃取痛點。' });
    }

    const system = `你是受眾區隔顧問。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
任務：從一份受眾痛點清單，反推出可能存在的「潛在／隱藏受眾」——也就是表面上都屬於同一個目標受眾，
但實際上動機、情境或急迫程度不同的細分族群。每個痛點可以同時屬於多個族群。
規則：
1. 抓出 2-5 個有區別度的族群。每個族群都必須比「目前設定的目標受眾」更細分、更具體，絕對不能只是把
   目標受眾的描述換句話說、加一兩個形容詞，或原封不動地重述。如果反推出來的族群跟目標受眾幾乎無法
   區分，就不要輸出這個族群。
2. 每個族群要有清楚的區隔依據（情境、動機、急迫程度、決策角色等），不能只靠年齡或性別區分。
3. matched_indices 只能填入下方清單中實際存在的編號，不可捏造。
4. differentiation 欄位要明確寫出「這個族群跟目前設定的目標受眾『${profile.audience}』具體有什麼不同」，
   不能只寫「更精準」這種空泛描述，要講清楚差在哪個面向。
5. 若清單裡的痛點明顯無法反映出多元受眾（例如全部指向同一種情境），可以回傳少於 2 個族群，並在對應的 note 欄位說明原因。`;

    const prompt = `【領域】${profile.domain_tag}
【目前設定的目標受眾（反推出的族群不可與此重複或僅為換句話說）】${profile.audience}

【痛點清單】（編號從 0 開始）
${points.map((p, i) => `[${i}] 表層問題：${p.surface_problem}／深層渴望：${p.deep_desire}`).join('\n')}

請輸出：
{"segments":[{"segment_name":"...","description":"這個族群是誰、他們的處境與典型情境（2-4句，具體描述，不要空泛）","rationale":"為什麼這些痛點特別打中他們（2-3句）","differentiation":"跟目前目標受眾『${profile.audience}』具體差在哪裡（1-2句）","matched_indices":[0,2]}],"note":"若整體區隔度不高，說明原因（選填）"}`;

    const raw = await call({ system, prompt, maxTokens: 1800, budgetMs: SEGMENTS_AI_BUDGET_MS });
    const parsed = parseJSON(raw);
    const rawSegments = parsed && Array.isArray(parsed.segments) ? parsed.segments : [];

    // 安全網：即使 Prompt 已明確要求不可與目標受眾重疊，仍用簡單的正規化字串比對擋掉
    // 明顯只是把 audience 原文換句話說（去除空白／標點後幾乎完全相同或互相包含）的族群，
    // 避免「潛在受眾」清單裡出現一個其實就是原本受眾的重複項。
    const normalize = s => (s || '').replace(/[\s、，。！？~～\-()（）「」『』]/g, '').toLowerCase();
    const audienceNorm = normalize(profile.audience);
    const isDuplicateOfAudience = text => {
      const t = normalize(text);
      if (!t || !audienceNorm) return false;
      return t === audienceNorm || t.includes(audienceNorm) || audienceNorm.includes(t);
    };

    const segments = rawSegments
      .filter(s => !isDuplicateOfAudience(s.segment_name) && !isDuplicateOfAudience(s.description))
      .map(s => {
        const indices = Array.isArray(s.matched_indices) ? s.matched_indices.filter(i => points[i]) : [];
        return {
          segment_name: s.segment_name || '未命名族群',
          description: s.description || '',
          rationale: s.rationale || '',
          differentiation: s.differentiation || '',
          matched_pain_point_ids: indices.map(i => points[i].id),
        };
      }).filter(s => s.matched_pain_point_ids.length);

    return res.status(200).json({ segments, note: parsed && parsed.note, based_on_count: points.length });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 從「產業文案手法庫」已分析過的範例文案中，找出領域相近的文案裡萃取出的受眾痛點，
// 作為草稿讓使用者一鍵帶入——邏輯與 handleSuggest 相同（回傳草稿、不直接寫入），
// 差別是這裡的草稿來自真實廣告文案的萃取結果，而不是模型憑空發想。
async function handleFromSwipe(req, res, user, profileId) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${profileId}&user_id=eq.${user.id}&select=domain_tag`);
    if (!profile) return sendError(res, 404, '找不到對應的產品/服務設定。');

    const swipes = await restRequest(
      `swipe_copies?user_id=eq.${user.id}&select=id,industry_tag,extracted_pain_points&extracted_pain_points=not.is.null`
    );

    const domainNorm = norm(profile.domain_tag);
    const matched = swipes.filter(s => {
      const tag = norm(s.industry_tag);
      return tag && domainNorm && (tag.includes(domainNorm) || domainNorm.includes(tag));
    });

    const seen = new Set();
    const suggestions = [];
    matched.forEach(s => {
      (Array.isArray(s.extracted_pain_points) ? s.extracted_pain_points : []).forEach(p => {
        const key = norm(p.surface_problem);
        if (!p.surface_problem || !p.deep_desire || seen.has(key)) return;
        seen.add(key);
        // detail 組成順序呼應分析時的優先順序：先講「為什麼鎖定這個痛點」與「受眾想被看見的形象」，
        // 這兩項才是真正有洞察價值的部分；原文引用放最後，只是佐證用途。
        const detailParts = [];
        if (p.why_targeted) detailParts.push(`為什麼鎖定這個痛點：${p.why_targeted}`);
        if (p.identity_appeal) detailParts.push(`受眾想被看見的形象／身份認同：${p.identity_appeal}`);
        if (p.quote) detailParts.push(`文案原文片段：「${p.quote}」`);
        suggestions.push({
          surface_problem: p.surface_problem,
          deep_desire: p.deep_desire,
          detail: detailParts.length ? detailParts.join('\n') : null,
          from_swipe_copy_id: s.id,
          from_industry_tag: s.industry_tag,
        });
      });
    });

    if (!suggestions.length) {
      return res.status(200).json({
        suggestions: [],
        message: matched.length
          ? '找到相近產業的文案，但尚未從中萃取出可用的痛點。'
          : '文案手法庫中尚無相同或相近領域的已分析文案。',
      });
    }

    return res.status(200).json({ suggestions: suggestions.slice(0, 10) });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id: profileId, action } = req.query || {};
  if (!profileId) return sendError(res, 400, '缺少 domain profile id。');

  if (action === 'suggest') return handleSuggest(req, res, user, profileId);
  if (action === 'extract') return handleExtract(req, res, user, profileId);
  if (action === 'segments') return handleSegments(req, res, user, profileId);
  if (action === 'from-swipe') return handleFromSwipe(req, res, user, profileId);
  if (!action) return dispatchDefault(req, res, user, profileId);
  return sendError(res, 400, '不支援的 action。');
};
