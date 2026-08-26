const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call } = require('./_lib/provider');
const { isSensitiveIndustry } = require('./_lib/compliance');
const { buildMatrix } = require('./ad-copies-hub');
const { buildReportDocx } = require('./_lib/report-docx');

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

// 目標受眾改為可複選陣列（domain_profiles.audiences），統一組成一句話用於報告內容與 AI 導讀 prompt。
function audienceLine(profile) {
  const list = Array.isArray(profile.audiences) ? profile.audiences : [];
  return list.length ? list.join('、') : (profile.audience || '（未設定）');
}

const CONSTRAINT_LABELS = {
  no_face: '不露臉',
  no_short_video: '不使用短影音',
  text_only: '純文字與圖文排版',
};

// 呈現媒介限制目前只在建立設定時寫入資料庫，過去沒有任何地方讀取、對報告內容毫無影響——
// 這裡把它接進報告，讓「有限制」這件事變成報告會實際考量的變數，而不是存了但沒人用的欄位。
function constraintsLabel(profile) {
  return Array.isArray(profile.business_constraints) && profile.business_constraints.length
    ? profile.business_constraints.map(c => CONSTRAINT_LABELS[c] || c).join('、')
    : null;
}

// ── 把「真實廣告成效」跟「痛點清單」兜起來 ──────────────────────────────────
// 這是這份報告跟 Meta 廣告後台真正拉開差異的地方：Meta 後台只知道某支廣告的 CTR/CPA/
// CVR/ROAS，不知道那支廣告打的是哪個受眾痛點；本系統在標籤化廣告文案時已經幫每則
// 文案標了 primary_pain_tag（白話痛點標籤），但那只是 AI 現場取的自由文字，跟痛點清單
// 裡的 surface_problem／deep_desire 沒有資料庫層級的關聯。這裡用字元 bigram 相似度
// （跟 pain-points-hub.js 痛點去重合併用的是同一套簡單方法，不需要另外呼叫 AI）盡量把
// 兩邊兜起來，兜得上的痛點就能同時顯示「語料佐證程度」與「真實廣告成效」兩種驗證。
// 門檻刻意比痛點去重寬鬆：那邊比對的是同一套邏輯產生的兩個候選痛點，用詞高度相近；
// 這裡比對的是「AI 幫廣告文案取的短標籤」跟「顧客原始語料整理出的痛點句子」，寫法
// 落差本來就比較大，門檻抓太高會導致明明打中同一個痛點卻配不到。
function norm(s) {
  return (s || '').trim().toLowerCase();
}
function bigrams(s) {
  const clean = norm(s).replace(/[\s、，。！？~～\-()（）「」『』]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  if (!set.size && clean) set.add(clean);
  return set;
}
function bigramSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
const AD_PERFORMANCE_MATCH_THRESHOLD = 0.18;

// 幫每一筆痛點（pairs 裡的元素，會直接被修改）附上 ad_performance 欄位（配不到就是
// null）。回傳配對到的筆數，供 coverage 統計與 AI 導讀使用。
function attachAdPerformance(pairs, matrixRows) {
  if (!Array.isArray(matrixRows) || !matrixRows.length) {
    pairs.forEach(p => { p.ad_performance = null; });
    return 0;
  }
  let matchedCount = 0;
  pairs.forEach(p => {
    let best = null, bestScore = 0;
    matrixRows.forEach(row => {
      const score = Math.max(
        bigramSimilarity(row.pain_tag, p.surface_problem),
        bigramSimilarity(row.pain_tag, p.deep_desire)
      );
      if (score > bestScore) { bestScore = score; best = row; }
    });
    if (best && bestScore >= AD_PERFORMANCE_MATCH_THRESHOLD) {
      p.ad_performance = {
        matched_pain_tag: best.pain_tag,
        weighted_ctr: best.weighted_ctr,
        weighted_cpa: best.weighted_cpa,
        weighted_cvr: best.weighted_cvr,
        weighted_roas: best.weighted_roas,
        sample_size: best.sample_size,
        low_confidence: best.low_confidence,
        match_score: round2(bestScore),
      };
      matchedCount++;
    } else {
      p.ad_performance = null;
    }
  });
  return matchedCount;
}

async function buildReport(profile, painPoints, adMatrix) {
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

  // 把「真實廣告成效」跟這批痛點兜起來——這是報告跟 Meta 廣告後台拉開差異的核心，
  // 讓使用者不用自己再跑去效益驗證矩陣對照，一份報告就能同時看到「語料佐證程度」
  // 跟「真實廣告成效驗證」兩種證據。
  const adPerformanceMatchedCount = attachAdPerformance(pairs, adMatrix ? adMatrix.pain_point_matrix : null);

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

  // 廣告成效亮點：跟風險提示分開放，這裡是「值得放心投入」的正向訊號，不是警示，
  // 混在 risk_flags 裡使用者容易誤以為是問題。只挑成效最好的前 2 筆，避免整份報告
  // 被落落長的清單淹沒——真正的逐項數據使用者可以在下方展開逐項分析查看。
  const adHighlights = [];
  if (total > 0 && (!adMatrix || !adMatrix.pain_point_matrix || !adMatrix.pain_point_matrix.length)) {
    adHighlights.push('目前尚無任何已回灌成效數據的廣告文案可比對，痛點驗證程度僅能參考語料佐證，建議上線廣告並回灌真實花費數據後再回來看這個對照。');
  } else if (adPerformanceMatchedCount > 0) {
    [...pairs]
      .filter(p => p.ad_performance && p.ad_performance.weighted_ctr != null)
      .sort((a, b) => b.ad_performance.weighted_ctr - a.ad_performance.weighted_ctr)
      .slice(0, 2)
      .forEach(p => {
        const ctrPct = Math.round(p.ad_performance.weighted_ctr * 10000) / 100;
        adHighlights.push(
          `「${p.surface_problem}」不只有語料佐證，實際投放的廣告點閱率也達 ${ctrPct}%（依 ${p.ad_performance.sample_size} 則廣告換算${p.ad_performance.low_confidence ? '，樣本數過少僅供初步參考' : ''}），是目前唯二／少數同時通過語料與廣告成效驗證的痛點之一。`
        );
      });
  }

  const framework = profile.price_tier === 'low'
    ? { name: 'PAS', reason: '低單價／快速決策，初步建議採用 Problem-Agitate-Solution 強化立即痛點與行動誘因。' }
    : { name: 'AIDA', reason: '高客單／建立信任，初步建議採用 AIDA 強化信任累積與長期價值。' };

  return {
    domain_profile: {
      domain_tag: profile.domain_tag,
      audiences: Array.isArray(profile.audiences) ? profile.audiences : (profile.audience ? [profile.audience] : []),
      price_tier: profile.price_tier,
      business_constraints: constraintsLabel(profile),
    },
    coverage: {
      total_pain_points: total,
      with_evidence: withEvidence,
      confirmed, unreviewed, rejected,
      with_matched_solution: withSolution,
      avg_confidence_score: avgConfidence,
      avg_fit_score: avgFit,
      with_ad_performance: adPerformanceMatchedCount,
    },
    risk_flags: riskFlags,
    ad_performance_highlights: adHighlights,
    framework_recommendation: framework,
    pain_points: pairs,
  };
}

async function generateNarrative(profile, report) {
  const top = [...report.pain_points]
    .sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
    .slice(0, 3);

  // 廣告成效表現最好的痛點（若有），讓導讀能明確區分「只有語料佐證」跟「連真實廣告
  // 成效都驗證過」兩種等級的痛點——這是這份導讀跟單純看 Meta 後台數字的差別所在。
  const topAdPerformance = [...report.pain_points]
    .filter(p => p.ad_performance && p.ad_performance.weighted_ctr != null)
    .sort((a, b) => b.ad_performance.weighted_ctr - a.ad_performance.weighted_ctr)
    .slice(0, 3);

  const constraints = constraintsLabel(profile);
  const system = `你是受眾策略顧問。只能輸出一段不含標題、不含條列符號的繁體中文導讀文字，總長度不超過 220 字，語氣專業精簡。
用詞規則：避免使用「知識變現」「商業底層邏輯」「賦能」「價值主張」之類的行銷黑話或包裝過的策略術語，
改用一般人看得懂的白話描述，讓沒有行銷背景的使用者也能直接理解並採取行動。
若下方提供了「真實廣告成效」資料，請明確區分「只有語料佐證」與「已有真實廣告成效驗證」這兩種等級的
痛點差異，優先建議把資源放在兩者兼具的痛點上；若某個高置信度的痛點目前還沒有對應的廣告成效數據，
也請提醒使用者這是可以優先安排測試、用真實花費數據驗證的方向。`;
  const prompt = `領域：${profile.domain_tag}／受眾：${audienceLine(profile)}
痛點總數：${report.coverage.total_pain_points}，有語料佐證：${report.coverage.with_evidence}，已人工確認：${report.coverage.confirmed}，平均置信度：${report.coverage.avg_confidence_score ?? '無資料'}
已有真實廣告成效驗證的痛點數：${report.coverage.with_ad_performance ?? 0}／${report.coverage.total_pain_points}
最具語料佐證力的痛點：${top.map(p => `「${p.surface_problem}」（置信度 ${p.confidence_score ?? '無'}）`).join('、') || '（尚無資料）'}
真實廣告成效表現最好的痛點：${topAdPerformance.length
    ? topAdPerformance.map(p => `「${p.surface_problem}」（加權點閱率 ${Math.round(p.ad_performance.weighted_ctr * 10000) / 100}%，樣本 ${p.ad_performance.sample_size} 則廣告${p.ad_performance.low_confidence ? '，樣本數過少' : ''}）`).join('、')
    : '（目前尚無任何痛點對應到有成效數據的廣告文案）'}
風險提示：${report.risk_flags.join('；') || '無'}
呈現媒介限制：${constraints || '無特別限制'}

請寫一段導讀，說明目前受眾洞察的驗證程度（語料佐證與真實廣告成效驗證兩者都要考慮）、哪個痛點最值得
優先投入資源，以及建議的下一步。若設有呈現媒介限制，下一步建議需要能在該限制下執行。`;

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

    // 真實廣告成效矩陣是加分項，不是必要項：拿不到（例如尚無任何廣告文案，或運算失敗）
    // 就當作沒有資料，report 主體照樣完整產出，只是少了「廣告成效對照」這一段。
    let adMatrix = null;
    try {
      adMatrix = await buildMatrix(user, profile_id);
    } catch (matrixErr) {
      adMatrix = null;
    }

    const report = await buildReport(profile, painPoints, adMatrix);

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

// 潛在受眾地圖頁面新增的「匯出結果」功能：同一支報告，多加一個 ?format=docx 查詢參數
// 就能直接下載成 Word 文件（可離線保存或寄送客戶），不需要另外開一支 API。
// 沒有帶 format（或帶其他值）維持原本回傳 JSON 的行為，前端渲染報告內容用的是這條路徑。
async function handleGetDocx(res, user, saved) {
  try {
    const buffer = await buildReportDocx(saved.report, '匯出時間：' + new Date(saved.created_at || Date.now()).toLocaleString('zh-TW'));
    const dp = (saved.report && saved.report.domain_profile) || {};
    const safeName = (dp.domain_tag || '洞察報告').replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}_${saved.id}.docx"`);
    return res.status(200).send(buffer);
  } catch (err) {
    return sendError(res, 500, '匯出 Word 文件失敗：' + err.message);
  }
}

async function handleGet(req, res, user, id) {
  try {
    const [saved] = await restRequest(`insight_reports?id=eq.${id}&user_id=eq.${user.id}&select=*`);
    if (!saved) return sendError(res, 404, '找不到對應的報告。');
    if ((req.query || {}).format === 'docx') return handleGetDocx(res, user, saved);
    return res.status(200).json({ id: saved.id, status: saved.status, report: saved.report });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 列出過去產出的報告：
//   - 帶 domain_profile_id：只列出該產品/服務設定底下的報告（既有的「歷史報告」用途）。
//   - 不帶：列出這個使用者名下「所有」產品/服務設定產出過的報告，供「洞察報告資料庫」
//     瀏覽模式使用——依領域／受眾／價格帶篩選的邏輯留在前端做（比對 domain_profile_id
//     對應到已經載入的產品/服務設定清單），這裡只負責把資料撈出來，不用另外處理跨表格的
//     篩選查詢字串，降低出錯風險。
async function handleList(req, res, user) {
  const { domain_profile_id } = req.query || {};
  try {
    let query = `insight_reports?user_id=eq.${user.id}&select=id,domain_profile_id,status,created_at,coverage:report->coverage&order=created_at.desc`;
    query += domain_profile_id ? `&domain_profile_id=eq.${domain_profile_id}&limit=20` : `&limit=100`;
    const items = await restRequest(query);
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`insight_reports?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id } = req.query || {};
  if (id) {
    if (req.method === 'DELETE') return handleDelete(req, res, user, id);
    if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
    return handleGet(req, res, user, id);
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
  return handleCreate(req, res, user);
};
