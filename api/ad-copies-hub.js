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

// 投放版位改為使用者自訂清單（比照語料來源分類 feedback_source_labels 的做法），
// 這幾個是首次使用時自動帶入的預設值，之後使用者可自由新增／刪除。
// value 是實際存進 ad_copies.platform 欄位（逗號分隔字串）的 slug，label 是畫面顯示文字；
// 預設的 4 個 value 刻意沿用舊版寫死時期就在用的 slug，讓既有資料的 platform 欄位不用轉換。
const DEFAULT_PLACEMENTS = [
  { label: 'Facebook', value: 'facebook' },
  { label: 'Instagram', value: 'instagram' },
  { label: 'Audience Network', value: 'audience_network' },
  { label: 'Messenger', value: 'messenger' },
];
const MAX_PLACEMENT_LABEL_LENGTH = 20;

// 把使用者輸入的顯示名稱轉成適合存進 platform 欄位的 slug：轉小寫、非英數字元換成底線，
// 避免使用者輸入「TikTok 廣告」之類含空白/中文的名稱時，跟既有的逗號分隔字串格式衝突。
function slugifyPlacement(label) {
  const base = (label || '').trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'placement';
}

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
  const cpm = impressions ? spend * 1000 / impressions : null;
  const cpa = conversions ? spend / conversions : null;
  const cvr = clicks ? conversions / clicks : null;
  const roas = revenue !== null && revenue !== undefined && spend ? revenue / spend : null;
  return { ctr: round4(ctr), cpc: round4(cpc), cpm: round4(cpm), cpa: round4(cpa), cvr: round4(cvr), roas: round4(roas) };
}
function historyPeriodKey(performance) {
  const start = performance && performance.reporting_period_start;
  const end = performance && performance.reporting_period_end;
  if (start || end) return `${start || 'unknown'}_${end || start || 'unknown'}`;
  return new Date().toISOString().slice(0, 10);
}
async function savePerformanceHistory(user, adCopyId, performance, metrics) {
  if (!performance) return;
  const spend = numOrNull(performance.spend);
  const reach = numOrNull(performance.reach);
  const impressions = numOrNull(performance.impressions);
  const clicks = numOrNull(performance.clicks);
  const conversions = numOrNull(performance.conversions);
  const revenue = numOrNull(performance.revenue);
  const body = {
    user_id: user.id,
    ad_copy_id: adCopyId,
    period_key: historyPeriodKey(performance),
    reporting_period_start: performance.reporting_period_start || null,
    reporting_period_end: performance.reporting_period_end || null,
    source: performance.source || 'manual',
    conversion_event: performance.conversion_event || 'lead',
    spend, reach, impressions,
    frequency: numOrNull(performance.frequency),
    clicks,
    outbound_clicks: numOrNull(performance.outbound_clicks),
    landing_page_views: numOrNull(performance.landing_page_views),
    add_to_cart: numOrNull(performance.add_to_cart),
    initiate_checkout: numOrNull(performance.initiate_checkout),
    conversions, revenue, ...metrics,
  };
  await restRequest('ad_performance_history?on_conflict=ad_copy_id,period_key,source', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body,
  });
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
    const performanceBody = {
      ad_copy_id: adCopy.id,
      user_id: user.id,
      spend, reach: numOrNull(performance.reach), impressions, clicks, conversions, revenue,
      conversion_event: performance.conversion_event || 'lead',
      reporting_period_start: performance.reporting_period_start || null,
      reporting_period_end: performance.reporting_period_end || null,
      source: performance.source || 'csv',
      synced_at: new Date().toISOString(),
      ...metrics,
    };
    await restRequest('ad_performance_current?on_conflict=ad_copy_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: performanceBody,
    });
    try { await savePerformanceHistory(user, adCopy.id, performance, metrics); }
    catch (historyErr) { /* 歷史表尚未 migration 時不阻擋目前快照寫入，部署後可補跑 migration。 */ }
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
  const { domain_profile_id, platform, conversion_event, items } = req.body || {};
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
          performance: item.performance ? { ...item.performance, conversion_event: item.performance.conversion_event || conversion_event || 'lead' } : (item.spend !== undefined ? {
            spend: item.spend, impressions: item.impressions, clicks: item.clicks,
            conversions: item.conversions, revenue: item.revenue,
            conversion_event: item.conversion_event || conversion_event || 'lead',
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
  const fields = 'ad_id,ad_name,campaign_name,spend,reach,frequency,impressions,clicks,outbound_clicks,actions,date_start,date_stop';
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
function extractConversions(actions, primaryEvent = 'lead') {
  if (!Array.isArray(actions)) return null;
  const allowed = primaryEvent === 'purchase' ? new Set(['purchase'])
    : primaryEvent === 'complete_registration' ? new Set(['complete_registration'])
      : primaryEvent === 'schedule' ? new Set(['schedule'])
        : primaryEvent === 'add_to_cart' ? new Set(['add_to_cart'])
          : new Set(['lead']);
  const total = actions.filter(a => allowed.has(a.action_type)).reduce((sum, a) => sum + (Number(a.value) || 0), 0);
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

    const [profileConfig] = domain_profile_id
      ? await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=primary_conversion_event`)
      : [];
    const primaryEvent = (profileConfig && profileConfig.primary_conversion_event) || 'lead';
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
        const reach = numOrNull(row.reach);
        const impressions = numOrNull(row.impressions);
        const clicks = numOrNull(row.clicks);
        const conversions = extractConversions(row.actions, primaryEvent);

        const result = await ingestOne(user, {
          domain_profile_id, platform: platform || 'facebook', raw_content: text,
          meta_ad_id: row.ad_id, meta_campaign_name: row.campaign_name,
          performance: {
            spend, reach, frequency: row.frequency, impressions, clicks, outbound_clicks: row.outbound_clicks, conversions, revenue: null,
            reporting_period_start: row.date_start, reporting_period_end: row.date_stop,
            conversion_event: primaryEvent,
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
  let primaryEvent = 'lead';
  if (domain_profile_id) {
    try {
      const [profile] = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=primary_conversion_event`);
      primaryEvent = (profile && profile.primary_conversion_event) || 'lead';
    } catch (_) { /* migration 尚未執行時沿用 lead，避免矩陣無法開啟 */ }
  }
  let query = `ad_copies?user_id=eq.${user.id}&select=id,ai_tags,performance:ad_performance_current(*)&ai_tags=not.is.null`;
  if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
  const copies = await restRequest(query);

  const withPerf = copies
    .filter(c => c.performance && (Array.isArray(c.performance) ? c.performance.length : true))
    .map(c => {
      const perf = Array.isArray(c.performance) ? c.performance[0] : c.performance;
      return { ai_tags: c.ai_tags, ...perf };
    })
    .filter(c => c.spend !== null && c.spend !== undefined)
    .filter(c => !domain_profile_id || !c.conversion_event || c.conversion_event === primaryEvent);

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
    conversion_event: primaryEvent,
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

// 編輯單一廣告文案：允許人工修正 AI 標籤化的結果（例如判斷錯的主打痛點、投放版位打錯），
// 以及手動回填/修正成效數據，不用重新走一次「貼上文案觸發 AI」的流程。
// 刻意不允許在這裡改 raw_content——文案內容一改，content_hash 去重的意義就不一致了，
// 若真的貼錯文案，建議直接刪除重新新增一則。
async function handleUpdate(req, res, user, id) {
  const { platform, primary_pain_tag, secondary_pain_tags, match_status, match_reason, match_notes, performance } = req.body || {};
  try {
    const [existing] = await restRequest(`ad_copies?id=eq.${id}&user_id=eq.${user.id}&select=*`);
    if (!existing) return sendError(res, 404, '找不到對應的廣告文案。');

    const patch = {};
    if (platform !== undefined) patch.platform = platform || null;
    if (match_status !== undefined) {
      if (!['unreviewed', 'hit', 'partial', 'missed', 'unknown'].includes(match_status)) return sendError(res, 400, '不支援的素材命中狀態。');
      patch.match_status = match_status;
      patch.match_reviewed_at = match_status === 'unreviewed' ? null : new Date().toISOString();
    }
    if (match_reason !== undefined) patch.match_reason = match_reason || null;
    if (match_notes !== undefined) patch.match_notes = match_notes || null;
    if (primary_pain_tag !== undefined || secondary_pain_tags !== undefined) {
      const tags = { ...(existing.ai_tags || {}) };
      if (primary_pain_tag !== undefined) {
        if (!primary_pain_tag) return sendError(res, 400, '主打痛點標籤不能為空。');
        tags.primary_pain_tag = primary_pain_tag;
      }
      if (secondary_pain_tags !== undefined) {
        tags.secondary_pain_tags = Array.isArray(secondary_pain_tags) ? secondary_pain_tags.slice(0, 2) : [];
      }
      patch.ai_tags = tags;
      patch.tagging_error = null; // 人工已修正，清掉舊的標籤化失敗訊息，避免畫面同時顯示錯誤又顯示標籤
    }

    let updated = existing;
    if (Object.keys(patch).length) {
      const rows = await restRequest(`ad_copies?id=eq.${id}&user_id=eq.${user.id}`, {
        method: 'PATCH', prefer: 'return=representation', body: patch,
      });
      if (!rows.length) return sendError(res, 404, '找不到對應的廣告文案。');
      updated = rows[0];
    }

    if (performance) {
      const spend = numOrNull(performance.spend);
      const impressions = numOrNull(performance.impressions);
      const clicks = numOrNull(performance.clicks);
      const conversions = numOrNull(performance.conversions);
      const revenue = numOrNull(performance.revenue);
      const metrics = computeMetrics({ spend, impressions, clicks, conversions, revenue });
      const performanceBody = { ad_copy_id: id, user_id: user.id, spend, reach: numOrNull(performance.reach), impressions, clicks, conversions, revenue, conversion_event: performance.conversion_event || 'lead', reporting_period_start: performance.reporting_period_start || null, reporting_period_end: performance.reporting_period_end || null, source: performance.source || 'manual', ...metrics };
      await restRequest('ad_performance_current?on_conflict=ad_copy_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: performanceBody,
      });
      try { await savePerformanceHistory(user, id, performance, metrics); } catch (_) { /* migration 尚未執行時仍保留目前快照 */ }
    }

    const [full] = await restRequest(`ad_copies?id=eq.${id}&user_id=eq.${user.id}&select=*,performance:ad_performance_current(*)`);
    return res.status(200).json(full || updated);
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

// ---- 投放版位管理 ----

async function handleListPlacements(req, res, user) {
  try {
    let labels = await restRequest(`ad_placement_labels?user_id=eq.${user.id}&select=*&order=sort_order.asc,created_at.asc`);
    if (!labels.length) {
      // 第一次使用，帶入預設版位，之後使用者可自由增刪。
      const rows = DEFAULT_PLACEMENTS.map((p, i) => ({ user_id: user.id, label: p.label, value: p.value, sort_order: i }));
      labels = await restRequest('ad_placement_labels', { method: 'POST', prefer: 'return=representation', body: rows });
      labels.sort((a, b) => a.sort_order - b.sort_order);
    }
    return res.status(200).json(labels);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreatePlacement(req, res, user) {
  const label = (req.body && req.body.label || '').trim();
  if (!label) return sendError(res, 400, '請輸入版位名稱。');
  if (label.length > MAX_PLACEMENT_LABEL_LENGTH) return sendError(res, 400, `版位名稱不可超過 ${MAX_PLACEMENT_LABEL_LENGTH} 字。`);
  try {
    const existing = await restRequest(`ad_placement_labels?user_id=eq.${user.id}&select=id,label,value`);
    if (existing.some(l => l.label.toLowerCase() === label.toLowerCase())) {
      return sendError(res, 409, '這個版位已經存在。');
    }
    let value = slugifyPlacement(label);
    // slug 撞名時（例如「TikTok」跟「Tiktok」都會 slug 成 tiktok）附加流水號，
    // 確保同一使用者底下的 value 一定唯一，platform 欄位比對才不會互相混淆。
    if (existing.some(l => l.value === value)) {
      let i = 2;
      while (existing.some(l => l.value === `${value}_${i}`)) i++;
      value = `${value}_${i}`;
    }
    const countRes = await restRequest(`ad_placement_labels?user_id=eq.${user.id}&select=sort_order&order=sort_order.desc&limit=1`);
    const nextOrder = countRes.length ? countRes[0].sort_order + 1 : 0;
    const [saved] = await restRequest('ad_placement_labels', {
      method: 'POST', prefer: 'return=representation', body: { user_id: user.id, label, value, sort_order: nextOrder },
    });
    return res.status(200).json(saved);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDeletePlacement(req, res, user, id) {
  try {
    await restRequest(`ad_placement_labels?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { action, id } = req.query || {};

  if (action === 'placements') {
    if (id) {
      if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
      return handleDeletePlacement(req, res, user, id);
    }
    if (req.method === 'GET') return handleListPlacements(req, res, user);
    if (req.method === 'POST') return handleCreatePlacement(req, res, user);
    return sendError(res, 405, '不支援的方法。');
  }

  if (action === 'batch-import') {
    if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleBatchImport(req, res, user);
  }
  if (action === 'meta-sync') {
    if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleMetaSync(req, res, user);
  }
  if (action === 'workflow-status') return handleWorkflowStatus(req, res, user);
  if (action === 'matrix') {
    if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, 405, '不支援的方法。');
    return handleMatrixCreate(req, res, user);
  }

  if (id) {
    if (req.method === 'PATCH') return handleUpdate(req, res, user, id);
    if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
    return handleDelete(req, res, user, id);
  }

  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};

// 工作流狀態原本是獨立 Function；合併進本 hub 後仍透過 action 分流，降低 Vercel Hobby
// 方案的 Function 數量，同時讓總覽頁維持原本的 /api/workflow-status 端點。
function countConfirmed(points) {
  return points.filter(point => point.review_status === 'confirmed' || point.review_status === 'edited').length;
}
function sourceCount(feedback) {
  return new Set(feedback.map(item => item.source_type).filter(Boolean)).size;
}
function nextWorkflowStep(stats) {
  if (!stats.feedback_total) return { key: 'feedback', label: '匯入第一批語料', page: 'feedback', reason: '先收集真實顧客語料，再整理受眾痛點。' };
  if (!stats.pain_total) return { key: 'pain', label: '整理受眾痛點', page: 'feedback', reason: '目前還沒有可供受眾分析使用的痛點。' };
  if (stats.pain_unreviewed > 0) return { key: 'review', label: '完成痛點複核', page: 'feedback', reason: `還有 ${stats.pain_unreviewed} 筆痛點等待確認。` };
  if (!stats.segment_total) return { key: 'segments', label: '分析潛在受眾地圖', page: 'segments', reason: '已具備確認後的痛點，可以開始反推細分受眾。' };
  if (!stats.ad_total) return { key: 'ads', label: '加入第一則廣告素材', page: 'adcopies', reason: '先把已投放或準備測試的素材放入文案庫。' };
  if (!stats.ad_with_performance) return { key: 'performance', label: '回灌廣告成效', page: 'adcopies', reason: '已有素材，但還沒有成效資料可供檢討。' };
  if (stats.ad_unreviewed_match > 0) return { key: 'match', label: '檢視素材命中狀態', page: 'adcopies', reason: `還有 ${stats.ad_unreviewed_match} 則素材尚未判斷是否打中受眾。` };
  return { key: 'iterate', label: '開始下一輪實驗', page: 'adcopies', reason: '基本資料已具備，可以比較受眾、痛點與素材成效。' };
}
function workflowQuality(stats) {
  const alerts = [];
  if (stats.feedback_total < 5) alerts.push({ level: 'warning', key: 'sample', title: '語料樣本偏少', detail: `目前只有 ${stats.feedback_total} 則語料，建議至少再收集幾個不同情境的案例。` });
  if (stats.feedback_sources < 2 && stats.feedback_total > 0) alerts.push({ level: 'info', key: 'source-diversity', title: '語料來源單一', detail: '目前語料只來自一種來源，建議交叉加入評論、客服、問卷或訪談，避免只代表單一場景。' });
  if (stats.feedback_short > 0) alerts.push({ level: 'info', key: 'short-feedback', title: '部分語料缺少情境', detail: `有 ${stats.feedback_short} 則語料過短，適合先作為線索，不宜單獨當成核心受眾依據。` });
  if (stats.pain_unreviewed > 0) alerts.push({ level: 'warning', key: 'unreviewed-pain', title: '痛點仍有待人工複核', detail: `有 ${stats.pain_unreviewed} 筆痛點尚未確認，建議先檢查是否真的符合目標受眾。` });
  if (stats.pain_total > 0 && !stats.segment_total) alerts.push({ level: 'info', key: 'no-segment', title: '尚未形成潛在受眾地圖', detail: '確認痛點後執行受眾分析，才能比較不同族群的情境差異。' });
  if (stats.ad_total > 0 && !stats.ad_with_performance) alerts.push({ level: 'warning', key: 'no-performance', title: '素材尚無成效資料', detail: '目前只能檢視文案內容，尚不能判斷實際命中或轉換效果。' });
  if (stats.ad_with_performance > 0 && stats.conversion_event_missing) alerts.push({ level: 'warning', key: 'conversion-event', title: '尚未設定主要轉換事件', detail: '請在產品／服務設定中指定 Lead、購買或其他主要事件，避免把不同事件混在同一個 CPA／CVR 裡。' });
  if (stats.ad_unreviewed_match > 0) alerts.push({ level: 'info', key: 'match-review', title: '素材命中狀態尚未完成', detail: `有 ${stats.ad_unreviewed_match} 則素材等待人工判斷，建議搭配成效與受眾設定一起檢視。` });
  return alerts;
}
async function handleWorkflowStatus(req, res, user) {
  if (req.method !== 'GET') return sendError(res, 405, '不支援的方法。');
  const { domain_profile_id } = req.query || {};
  if (!domain_profile_id) return sendError(res, 400, '缺少 domain_profile_id。');
  try {
    const [profile] = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id,product_name,domain_tag,primary_conversion_event`);
    if (!profile) return sendError(res, 404, '找不到產品／服務設定。');
    const [feedback, pains, segments, ads, reports] = await Promise.all([
      restRequest(`raw_customer_feedback?domain_profile_id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id,raw_text,source_type`),
      restRequest(`audience_pain_points?domain_profile_id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id,review_status`),
      restRequest(`audience_segments?domain_profile_id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`),
      restRequest(`ad_copies?domain_profile_id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id,match_status,performance:ad_performance_current(*)`),
      restRequest(`audience_reports?domain_profile_id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`),
    ]);
    const adWithPerformance = ads.filter(ad => {
      const perf = Array.isArray(ad.performance) ? ad.performance[0] : ad.performance;
      return perf && (perf.impressions !== null || perf.clicks !== null || perf.spend !== null);
    });
    const stats = {
      feedback_total: feedback.length,
      feedback_sources: sourceCount(feedback),
      feedback_short: feedback.filter(item => String(item.raw_text || '').trim().length < 12).length,
      pain_total: pains.length,
      pain_confirmed: countConfirmed(pains),
      pain_unreviewed: pains.filter(point => !point.review_status || point.review_status === 'unreviewed').length,
      segment_total: segments.length,
      ad_total: ads.length,
      ad_with_performance: adWithPerformance.length,
      ad_unreviewed_match: ads.filter(ad => !ad.match_status || ad.match_status === 'unreviewed').length,
      report_total: reports.length,
      conversion_event_missing: !profile.primary_conversion_event,
    };
    const progressItems = [
      { key: 'profile', label: '產品／服務設定', done: true, page: 'profile' },
      { key: 'feedback', label: '收集真實語料', done: stats.feedback_total >= 5, page: 'feedback' },
      { key: 'pain', label: '確認受眾痛點', done: stats.pain_confirmed > 0 && stats.pain_unreviewed === 0, page: 'feedback' },
      { key: 'segments', label: '建立潛在受眾地圖', done: stats.segment_total > 0, page: 'segments' },
      { key: 'performance', label: '回灌廣告成效', done: stats.ad_with_performance > 0, page: 'adcopies' },
    ];
    const alerts = workflowQuality(stats);
    const doneCount = progressItems.filter(item => item.done).length;
    return res.status(200).json({
      profile, stats,
      progress: { done: doneCount, total: progressItems.length, percent: Math.round(doneCount / progressItems.length * 100), items: progressItems },
      next_step: nextWorkflowStep(stats),
      quality: { alerts, level: alerts.some(alert => alert.level === 'warning') ? 'warning' : 'good' },
    });
  } catch (err) {
    return sendError(res, 500, `讀取工作流狀態失敗：${err.message}`);
  }
}

// insight-reports-hub.js 會直接 require 這支檔案來重用同一份矩陣運算（純運算、不呼叫 AI），
// 讓洞察報告能把「真實廣告成效」跟痛點清單兜在一起，而不用另外發一次 HTTP 請求打自己的 API。
module.exports.buildMatrix = buildMatrix;
