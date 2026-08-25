const crypto = require('crypto');
const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { call, parseJSON } = require('./_lib/provider');

// 這支對應企劃書的「Meta 廣告效益驗證引擎」核心模組。
//   POST /api/ad-copies                      建立/回灌單一廣告文案＋成效（新文案才會打 AI）
//   POST /api/ad-copies?action=batch-import   CSV 匯入用（前端解析 CSV 後送結構化 items 陣列）
//   POST /api/ad-copies?action=meta-sync      向 Meta Graph API 拉取廣告與洞察報告，跑同一套流程
//   GET  /api/ad-copies                       列出目前使用者（可依 domain_profile_id 過濾）的廣告文案
//   GET  /api/ad-copies?action=matrix         算出「痛點轉換矩陣」＋「高 CTR 結構模板」並存檔
//   GET  /api/ad-copies?action=matrix&id=...  讀取先前算好的矩陣快照
//
// 對應 vercel.json 需新增的 rewrites，見同資料夾 vercel.additions.json。

const TAGGING_AI_BUDGET_MS = Number(process.env.AD_TAGGING_AI_BUDGET_MS || 20000);
const TAGGING_MAX_TOKENS = 500; // 輕量標籤化，不需要長輸出，才能真正做到「低 API 消耗」
const MAX_BATCH_SIZE = 200;
const MIN_SAMPLE_SIZE_FOR_MATRIX = 2; // 少於這個文案數的痛點標籤，樣本太少，矩陣中會標記為低信度而非直接排除

// ── 文字正規化與 Hash ──────────────────────────────────────────────────────
// 刻意只做 trim／空白壓縮／統一換行，不做語意層級的模糊比對：這裡要抓的是
// 「同一份文案」，近似但不同的改寫版本本來就該被視為不同素材各自計算成效，
// 不能因為模糊比對而把兩則實際成效不同的文案的數據混在一起算。
function normalizeForHash(text) {
  return (text || '').trim().replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}
function contentHash(text) {
  return crypto.createHash('md5').update(normalizeForHash(text), 'utf8').digest('hex');
}

// ── 成效欄位計算 ────────────────────────────────────────────────────────────
function round4(n) {
  return n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10000) / 10000;
}
function computeMetrics({ spend, impressions, clicks, conversions, revenue }) {
  const ctr = impressions ? clicks / impressions : null;
  const cpc = clicks ? spend / clicks : null;
  const cpa = conversions ? spend / conversions : null;
  const cvr = clicks ? conversions / clicks : null;
  const roas = revenue !== null && revenue !== undefined && spend ? revenue / spend : null;
  return { ctr: round4(ctr), cpc: round4(cpc), cpa: round4(cpa), cvr: round4(cvr), roas: round4(roas) };
}
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ── Gemini 輕量標籤化（單次呼叫，終身不變） ──────────────────────────────────
// 刻意壓低 maxTokens、prompt 也不要求任何解釋性文字——這是整個新架構「API 消耗量
// 降低 80%-90%」的關鍵：只在文案第一次出現時打這一次，之後不管重複匯入幾次、
// 成效更新幾次，都只是純資料庫寫入，0 API 消耗。
async function tagAdCopy(raw_content, domainTag) {
  const system = `你是廣告文案標籤分類器。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
任務單一且明確：判斷這則廣告文案主要打的是什麼受眾痛點、用什麼結構與手法——這是分類標籤，
不是深度分析，輸出要精簡、不要長篇解釋。`;
  const prompt = `【產業／領域提示】${domainTag || '未提供，請自行從文案內容判斷'}

廣告文案內容：
"""
${raw_content.slice(0, 1500)}
"""

請輸出：
- primary_pain_tag：這則文案主打的痛點，簡短白話標籤（4-12字，例如「沒時間運動」「怕踩雷亂花錢」）
- secondary_pain_tags：次要痛點標籤，0-2 個，同樣簡短
- structure_blocks：依文案實際內容拆解出的區塊順序，陣列，只能用這些值：
  hook, pain_agitate, solution, trust_proof, emotional_close, urgency, cta
- hook_type：開頭手法，從這些選一個最貼近的：question（提問）、statistic（數據／事實）、
  story（故事／情境）、direct_offer（直接優惠）、bold_claim（斷言／反常識）、pain_callout（直接點名痛點）
- emotion_tag：主要訴求情緒，從這些選一個：fear（恐懼／焦慮）、aspiration（渴望／夢想）、
  logic（理性／邏輯）、trust（信任／安全感）、urgency（急迫／稀缺）
- target_audience_guess：從文案內容猜測的目標受眾，一句話（10-20字）

輸出格式：
{"primary_pain_tag":"...","secondary_pain_tags":["..."],"structure_blocks":["hook","..."],"hook_type":"...","emotion_tag":"...","target_audience_guess":"..."}`;

  const raw = await call({ system, prompt, maxTokens: TAGGING_MAX_TOKENS, budgetMs: TAGGING_AI_BUDGET_MS });
  const parsed = parseJSON(raw);
  if (!parsed || !parsed.primary_pain_tag) {
    throw new Error('模型回應格式不符預期（缺少 primary_pain_tag）。');
  }
  return {
    primary_pain_tag: parsed.primary_pain_tag,
    secondary_pain_tags: Array.isArray(parsed.secondary_pain_tags) ? parsed.secondary_pain_tags.slice(0, 2) : [],
    structure_blocks: Array.isArray(parsed.structure_blocks) ? parsed.structure_blocks : [],
    hook_type: parsed.hook_type || null,
    emotion_tag: parsed.emotion_tag || null,
    target_audience_guess: parsed.target_audience_guess || null,
  };
}

// ── 核心流程：單則文案的「進線」處理 ─────────────────────────────────────────
// 三個入口（手動新增／CSV 匯入／Meta API 同步）最終都會走到這裡，確保 hash 去重
// 與「新文案才觸發 AI」的規則只需要維護這一份邏輯。
async function ingestOne(user, { domain_profile_id, platform, raw_content, meta_ad_id, meta_campaign_name, performance }) {
  const text = (raw_content || '').trim();
  if (!text) return { skipped: true, reason: 'empty_content' };

  const hash = contentHash(text);
  const [existing] = await restRequest(
    `ad_copies?user_id=eq.${user.id}&content_hash=eq.${hash}&select=*`
  );

  let adCopy = existing;
  let aiCalled = false;

  if (!adCopy) {
    // 新文案：先寫入基礎資料（就算 AI 標籤化失敗，文案與成效數據依然要保得住），
    // 再嘗試打一次 Gemini。AI 失敗不擋匯入——這對應「即使 AI 這段失敗，資料閉環
    // 依然完整」的原則，跟 insight-reports-hub.js 的 narrative 容錯設計一致。
    const [inserted] = await restRequest('ad_copies', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id,
        domain_profile_id: domain_profile_id || null,
        content_hash: hash,
        raw_content: text,
        platform: platform || 'facebook',
        meta_ad_id: meta_ad_id || null,
        meta_campaign_name: meta_campaign_name || null,
      },
    });
    adCopy = inserted;

    try {
      let domainTag = null;
      if (domain_profile_id) {
        const [profile] = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=domain_tag`);
        domainTag = profile ? profile.domain_tag : null;
      }
      const tags = await tagAdCopy(text, domainTag);
      aiCalled = true;
      const [tagged] = await restRequest(`ad_copies?id=eq.${adCopy.id}&user_id=eq.${user.id}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: { ai_tags: tags, tagged_at: new Date().toISOString(), tagging_error: null },
      });
      adCopy = tagged || adCopy;
    } catch (tagErr) {
      aiCalled = true;
      await restRequest(`ad_copies?id=eq.${adCopy.id}&user_id=eq.${user.id}`, {
        method: 'PATCH',
        body: { tagging_error: tagErr.message },
      }).catch(() => {}); // 連記錄錯誤都失敗就算了，不影響主流程
    }
  }
  // 若已有標籤（existing 命中），直接跳過整段 AI 呼叫 —— 這就是「0 API 消耗」的分支。

  // 成效數據：不管文案是新是舊，只要這次請求有帶 performance，一律 upsert，
  // 這支操作完全不碰 AI。
  if (performance) {
    const spend = numOrNull(performance.spend);
    const impressions = numOrNull(performance.impressions);
    const clicks = numOrNull(performance.clicks);
    const conversions = numOrNull(performance.conversions);
    const revenue = numOrNull(performance.revenue);
    const metrics = computeMetrics({ spend, impressions, clicks, conversions, revenue });

    await restRequest('ad_performance_current?on_conflict=ad_copy_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        ad_copy_id: adCopy.id,
        user_id: user.id,
        spend, impressions, clicks, conversions, revenue,
        ...metrics,
        reporting_period_start: performance.reporting_period_start || null,
        reporting_period_end: performance.reporting_period_end || null,
        source: performance.source || 'csv',
        synced_at: new Date().toISOString(),
      },
    });
  }

  return { ad_copy: adCopy, reused_existing: !!existing, ai_called: aiCalled };
}

// ── 入口 1：單筆建立／回灌 ───────────────────────────────────────────────────
async function handleCreate(req, res, user) {
  const { domain_profile_id, platform, raw_content, meta_ad_id, meta_campaign_name, performance } = req.body || {};
  if (!raw_content || !raw_content.trim()) return sendError(res, 400, '請提供廣告文案內容（raw_content）。');

  try {
    if (domain_profile_id) {
      const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
      if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
    }
    const result = await ingestOne(user, { domain_profile_id, platform, raw_content, meta_ad_id, meta_campaign_name, performance });
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// ── 入口 2：CSV 批次匯入 ─────────────────────────────────────────────────────
// 前端負責解析 CSV 並映射欄位（作法比照 raw-feedback-hub.js 的 items 匯入模式），
// 這裡只吃結構化的 items 陣列，每筆對應一則廣告文案＋（選填）成效數據。
async function handleBatchImport(req, res, user) {
  const { domain_profile_id, platform, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return sendError(res, 400, '請提供至少一筆匯入資料（items）。');
  if (items.length > MAX_BATCH_SIZE) return sendError(res, 400, `單次最多匯入 ${MAX_BATCH_SIZE} 筆，請分批匯入。`);

  try {
    if (domain_profile_id) {
      const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
      if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
    }

    let created = 0, reused = 0, aiCalls = 0, skipped = 0;
    const errors = [];
    for (const item of items) {
      try {
        const result = await ingestOne(user, {
          domain_profile_id,
          platform: platform || item.platform,
          raw_content: item.raw_content,
          meta_ad_id: item.meta_ad_id,
          meta_campaign_name: item.meta_campaign_name,
          performance: item.performance || (item.spend !== undefined ? {
            spend: item.spend, impressions: item.impressions, clicks: item.clicks,
            conversions: item.conversions, revenue: item.revenue,
            reporting_period_start: item.reporting_period_start, reporting_period_end: item.reporting_period_end,
            source: 'csv',
          } : null),
        });
        if (result.skipped) { skipped++; continue; }
        if (result.reused_existing) reused++; else created++;
        if (result.ai_called) aiCalls++;
      } catch (itemErr) {
        errors.push(itemErr.message);
      }
    }

    return res.status(200).json({
      created, reused, skipped, ai_calls: aiCalls, total: items.length,
      errors: errors.slice(0, 10),
      message: `已處理 ${items.length} 筆：${created} 筆新文案（呼叫 AI ${aiCalls} 次）、${reused} 筆已存在（0 API 消耗，僅更新成效）、${skipped} 筆略過。`,
    });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// ── 入口 3：Meta Graph API 同步 ──────────────────────────────────────────────
// v1：使用者提供 ad account id 與 access token（不落地儲存 token，僅本次請求使用），
// 拉取該廣告帳號的洞察報告（含花費／曝光／點擊／轉換）與對應的文案素材，
// 走同一套 ingestOne 流程。access token 的長期授權（System User Token／OAuth 流程）
// 屬於帳號串接層級的工作，建議之後另外做一個獨立的「連接 Meta 帳號」設定頁面，
// 這裡先支援「貼入現有 token 手動同步」，讓資料閉環可以先跑起來。
const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';

async function fetchMetaInsights(adAccountId, accessToken, datePreset) {
  const fields = 'ad_id,ad_name,campaign_name,spend,impressions,clicks,actions,date_start,date_stop';
  const url = `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights` +
    `?level=ad&fields=${fields}&date_preset=${datePreset || 'last_30d'}&limit=200&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Meta Graph API 洞察報告呼叫失敗：${(data.error && data.error.message) || res.statusText}`);
  }
  return Array.isArray(data.data) ? data.data : [];
}

// 洞察報告只有數字，沒有文案本文，需要另外用 ad_id 撈廣告素材內文。
async function fetchAdCreativeText(adId, accessToken) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adId}` +
    `?fields=creative{body,title,object_story_spec}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) return null; // 素材撈取失敗不擋整批同步，該筆跳過即可
  const creative = data.creative || {};
  const storySpec = creative.object_story_spec || {};
  const linkData = storySpec.link_data || {};
  return creative.body || linkData.message || linkData.name || creative.title || null;
}

// 從 insights 的 actions 陣列中取出「轉換數」——Meta 對「轉換」的定義依廣告目標而異
// （purchase／lead／complete_registration…），這裡採寬鬆策略：把常見的轉換類 action_type
// 加總，讓不同目標的廣告都能有一個可用的 conversions 數字；若之後要更精準，
// 建議讓使用者在同步時指定要採計哪個 action_type。
const CONVERSION_ACTION_TYPES = new Set([
  'purchase', 'lead', 'complete_registration', 'submit_application', 'schedule',
]);
function extractConversions(actions) {
  if (!Array.isArray(actions)) return null;
  const total = actions
    .filter(a => CONVERSION_ACTION_TYPES.has(a.action_type))
    .reduce((sum, a) => sum + (Number(a.value) || 0), 0);
  return total || null;
}

async function handleMetaSync(req, res, user) {
  const { domain_profile_id, ad_account_id, access_token, date_preset, platform } = req.body || {};
  if (!ad_account_id || !access_token) {
    return sendError(res, 400, '請提供 ad_account_id 與 access_token（僅本次同步使用，系統不會儲存）。');
  }
  try {
    if (domain_profile_id) {
      const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
      if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
    }

    const insights = await fetchMetaInsights(ad_account_id, access_token, date_preset);
    if (!insights.length) {
      return res.status(200).json({ created: 0, reused: 0, ai_calls: 0, total: 0, message: '這個廣告帳號在指定期間內沒有洞察報告資料。' });
    }

    let created = 0, reused = 0, aiCalls = 0, skipped = 0;
    const errors = [];
    for (const row of insights) {
      try {
        const text = await fetchAdCreativeText(row.ad_id, access_token);
        if (!text) { skipped++; continue; }

        const spend = numOrNull(row.spend);
        const impressions = numOrNull(row.impressions);
        const clicks = numOrNull(row.clicks);
        const conversions = extractConversions(row.actions);

        const result = await ingestOne(user, {
          domain_profile_id, platform: platform || 'facebook', raw_content: text,
          meta_ad_id: row.ad_id, meta_campaign_name: row.campaign_name,
          performance: {
            spend, impressions, clicks, conversions, revenue: null,
            reporting_period_start: row.date_start, reporting_period_end: row.date_stop,
            source: 'meta_api',
          },
        });
        if (result.reused_existing) reused++; else created++;
        if (result.ai_called) aiCalls++;
      } catch (rowErr) {
        errors.push(rowErr.message);
      }
    }

    return res.status(200).json({
      created, reused, skipped, ai_calls: aiCalls, total: insights.length,
      errors: errors.slice(0, 10),
      message: `已從 Meta 同步 ${insights.length} 則廣告洞察報告：${created} 筆新文案（呼叫 AI ${aiCalls} 次）、${reused} 筆已存在僅更新成效、${skipped} 筆缺少可用素材文字已略過。`,
    });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// ── 列表 ────────────────────────────────────────────────────────────────────
async function handleList(req, res, user) {
  const { domain_profile_id, limit } = req.query || {};
  try {
    let query = `ad_copies?user_id=eq.${user.id}&select=*,performance:ad_performance_current(*)&order=created_at.desc`;
    if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
    query += `&limit=${Math.min(Number(limit) || 100, 300)}`;
    const items = await restRequest(query);
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// ── 痛點轉換矩陣 ＋ 高 CTR 結構模板 ───────────────────────────────────────────
// 純運算，不呼叫 AI：把 ad_copies.ai_tags（一次性標籤）跟 ad_performance_current
// （持續回灌的真實成效）交叉聚合，用真實 CTR/CPA/CVR/ROAS 取代 AI 的置信度猜測，
// 對應報告中「擺脫 AI 盲測，改以 ROAS/CTR 為客觀權重」。
function weightedAggregate(rows) {
  const sumSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const sumImpressions = rows.reduce((s, r) => s + (r.impressions || 0), 0);
  const sumClicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
  const sumConversions = rows.reduce((s, r) => s + (r.conversions || 0), 0);
  const sumRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  return {
    sample_size: rows.length,
    total_spend: round4(sumSpend),
    total_impressions: sumImpressions || null,
    total_clicks: sumClicks || null,
    total_conversions: sumConversions || null,
    // 用「總點擊/總曝光」而不是「各筆 CTR 平均」，避免小曝光量的極端 CTR 拉高平均值失真
    weighted_ctr: sumImpressions ? round4(sumClicks / sumImpressions) : null,
    weighted_cpa: sumConversions ? round4(sumSpend / sumConversions) : null,
    weighted_cvr: sumClicks ? round4(sumConversions / sumClicks) : null,
    weighted_roas: sumSpend ? round4(sumRevenue / sumSpend) : null,
  };
}

async function buildMatrix(user, domain_profile_id) {
  let query = `ad_copies?user_id=eq.${user.id}&select=id,ai_tags,performance:ad_performance_current(*)&ai_tags=not.is.null`;
  if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
  const copies = await restRequest(query);

  const withPerf = copies
    .filter(c => c.performance && (Array.isArray(c.performance) ? c.performance.length : true))
    .map(c => {
      const perf = Array.isArray(c.performance) ? c.performance[0] : c.performance;
      return { ai_tags: c.ai_tags, ...perf };
    })
    .filter(c => c.spend !== null && c.spend !== undefined);

  // ── 痛點轉換矩陣：依 primary_pain_tag 分組 ──
  const byPainTag = new Map();
  withPerf.forEach(row => {
    const tag = row.ai_tags && row.ai_tags.primary_pain_tag;
    if (!tag) return;
    if (!byPainTag.has(tag)) byPainTag.set(tag, []);
    byPainTag.get(tag).push(row);
  });
  const painPointMatrix = [...byPainTag.entries()].map(([pain_tag, rows]) => ({
    pain_tag,
    ...weightedAggregate(rows),
    low_confidence: rows.length < MIN_SAMPLE_SIZE_FOR_MATRIX,
  })).sort((a, b) => (b.weighted_ctr || 0) - (a.weighted_ctr || 0));

  // ── 高 CTR 結構模板：依「hook_type + structure_blocks 順序」分組 ──
  const byStructure = new Map();
  withPerf.forEach(row => {
    const tags = row.ai_tags || {};
    const key = `${tags.hook_type || '未分類'}｜${(tags.structure_blocks || []).join('→') || '未拆解'}`;
    if (!byStructure.has(key)) byStructure.set(key, { hook_type: tags.hook_type || null, structure_blocks: tags.structure_blocks || [], rows: [] });
    byStructure.get(key).rows.push(row);
  });
  const structureTemplates = [...byStructure.values()].map(g => ({
    hook_type: g.hook_type,
    structure_blocks: g.structure_blocks,
    ...weightedAggregate(g.rows),
    low_confidence: g.rows.length < MIN_SAMPLE_SIZE_FOR_MATRIX,
  })).sort((a, b) => (b.weighted_ctr || 0) - (a.weighted_ctr || 0));

  return {
    based_on_ad_copies: withPerf.length,
    total_tagged_ad_copies: copies.length,
    pain_point_matrix: painPointMatrix,
    high_ctr_structure_templates: structureTemplates,
    note: withPerf.length < MIN_SAMPLE_SIZE_FOR_MATRIX
      ? '目前有成效數據可用的廣告文案樣本數過少，矩陣結果僅供初步參考，建議累積更多真實花費數據後再作為決策依據。'
      : null,
  };
}

async function handleMatrixCreate(req, res, user) {
  const { domain_profile_id } = req.query || {};
  try {
    const report = await buildMatrix(user, domain_profile_id || null);
    const [saved] = await restRequest('pain_performance_matrix_reports', {
      method: 'POST',
      prefer: 'return=representation',
      body: { user_id: user.id, domain_profile_id: domain_profile_id || null, report },
    });
    return res.status(200).json({ id: saved.id, report: saved.report, created_at: saved.created_at });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// 刪除單一廣告文案——ad_performance_current 有 FK ON DELETE CASCADE，會一併清掉對應的成效列，
// 不用另外呼叫兩次刪除。這支主要給使用者清掉匯錯的 CSV 資料列或測試資料用。
async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`ad_copies?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { action, id } = req.query || {};

  if (action === 'batch-import') {
    if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleBatchImport(req, res, user);
  }
  if (action === 'meta-sync') {
    if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleMetaSync(req, res, user);
  }
  if (action === 'matrix') {
    if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleMatrixCreate(req, res, user);
  }

  if (id) {
    if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
    return handleDelete(req, res, user, id);
  }

  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};

// insight-reports-hub.js 會直接 require 這支檔案來重用同一份矩陣運算（純運算、不呼叫 AI），
// 讓洞察報告能把「真實廣告成效」跟痛點清單兜在一起，而不用另外發一次 HTTP 請求打自己的 API。
module.exports.buildMatrix = buildMatrix;
