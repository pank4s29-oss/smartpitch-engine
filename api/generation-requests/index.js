const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { call, parseJSON } = require('../_lib/provider');
const { scanBlacklist, isSensitiveIndustry, hasVerbatimOverlap } = require('../_lib/compliance');

const LENGTH_MAP = { short: 100, medium: 220, long: 500 };
const DEFAULT_BLOCK_ORDER = {
  low: ['hook', 'pain_agitate', 'solution', 'urgency', 'cta'],
  high: ['hook', 'solution', 'trust_proof', 'emotional_close', 'cta'],
};

// ── 修正重點 ──────────────────────────────────────────────────────────
// 目前沒有接 ANTHROPIC_API_KEY 備援，只能靠 Gemini 自己扛。Gemini 官方
// 目前處於高負載狀態，一次要求產出 3 組完整多區塊文案（篇幅選「長」時
// 中文內容加總可能上看 1500 字＋JSON 結構開銷）會讓單次請求的輸出量變大，
// 更容易撞到過載／逾時／輸出被截斷（finishReason: MAX_TOKENS）。
// 把篇數改成可由環境變數調整，預設先降為 1，讓單次請求更小、更容易在
// Gemini 高負載時仍能順利完成；之後負載恢復正常、或接上 Claude 備援後，
// 只要在 Vercel 把 GENERATION_VARIANT_COUNT 調回 3 即可，不需要改程式碼。
const VARIANT_COUNT = Math.max(1, Math.min(3, Number(process.env.GENERATION_VARIANT_COUNT || 1)));
const ANGLE_TYPES = ['fear', 'aspiration', 'logic'].slice(0, VARIANT_COUNT);

// 輸出 token 需求大致跟篇數成正比，所以讓 GENERATION_MAX_TOKENS 的預設值
// 隨 VARIANT_COUNT 等比例調整（仍可用環境變數直接覆寫）；篇數變少時，
// 單次請求需要的 maxOutputTokens 也跟著變少，attemptTimeout 的估算
// （gemini.js 裡 maxTokens*4ms）也會跟著變短，整體更不容易逾時。
const GENERATION_MAX_TOKENS = Number(process.env.GENERATION_MAX_TOKENS || Math.round(8000 * (VARIANT_COUNT / 3)));
// vercel.json 裡這支的 maxDuration 是 60 秒，扣掉讀 profile／痛點／解決方案／範例文案
// （約 4 次查詢）與最後 2 次批次寫入的開銷，留給 AI 呼叫（含重試，目前沒有跨供應商備援）的預算抓 50 秒。
const AI_BUDGET_MS = Number(process.env.GENERATION_AI_BUDGET_MS || 50000);

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
  if (req.method !== 'POST') return sendError(res, 405, '不支援的方法。');

  const body = req.body || {};
  const {
    profile_id, target_platform, product_name, product_description,
    length_type, custom_word_count, tone, primary_emotion, secondary_emotions,
    block_order, constraints,
  } = body;

  if (!profile_id || !product_name || !product_description) {
    return sendError(res, 400, '缺少必要欄位（profile_id / product_name / product_description）。');
  }

  try {
    // 1. 驗證領域設定屬於使用者，並取得 price_tier / domain_tag / audience
    const [profile] = await restRequest(`domain_profiles?id=eq.${profile_id}&user_id=eq.${user.id}&select=*`);
    if (!profile) return sendError(res, 404, '找不到對應的領域設定。');

    // 2. 取得已確認的痛點與解決方案配對
    const painPoints = await restRequest(`audience_pain_points?domain_profile_id=eq.${profile_id}&user_id=eq.${user.id}&select=*`);
    const solutions = await restRequest(`product_solutions?domain_profile_id=eq.${profile_id}&user_id=eq.${user.id}&select=*`);
    if (!painPoints.length || !solutions.length) {
      return sendError(res, 400, '請至少完成一組痛點與解決方案配對，再送出生成請求。');
    }
    const pairs = painPoints.map(p => {
      const solution = solutions.find(s => s.pain_point_id === p.id);
      return solution ? { ...p, ...solution } : null;
    }).filter(Boolean);
    if (!pairs.length) {
      return sendError(res, 400, '找不到完整配對的痛點與解決方案，請確認每組痛點都已填寫對應的解決方案。');
    }

    // 3. 取得同領域的範例文案，作為「寫作手法」參考（不可逐字複製）
    const swipeExamples = await restRequest(
      `swipe_copies?user_id=eq.${user.id}&industry_tag=eq.${encodeURIComponent(profile.domain_tag)}&select=raw_content,block_breakdown,framework_tag&limit=3`
    );

    // 4. 決定框架（規則式，不需呼叫模型）
    const framework = profile.price_tier === 'low'
      ? { name: 'PAS', reason: '低單價／快速決策，採用 Problem-Agitate-Solution 強化立即痛點與立即行動。' }
      : { name: 'AIDA', reason: '高客單／建立信任，採用 AIDA 強化信任累積與長期價值。' };

    // 5. 決定篇幅與區塊順序
    const targetLength = length_type === 'custom' ? (custom_word_count || 220) : (LENGTH_MAP[length_type] || 220);
    const finalBlockOrder = (Array.isArray(block_order) && block_order.length)
      ? block_order
      : DEFAULT_BLOCK_ORDER[profile.price_tier];

    // 6. 組 Prompt，呼叫模型產出變體（篇數由 VARIANT_COUNT 控制）
    const system = `你是資深廣告文案策略師。只能輸出合法 JSON，不能有任何前後說明文字或 Markdown 圍籬。
生成規則：
1. 每組文案依指定的區塊順序撰寫，每個區塊對應一小段內容。
2. 若參考了下方的範例文案，只能學習其結構、修辭手法與節奏，絕對不可逐字複製其字句。
3. 不得使用誇大不實或保證性字眼（如「保證有效」「穩賺不賠」「根治」等）。
4. 全文字數需貼近目標字數，容許±20%誤差。`;

    const prompt = `【領域】${profile.domain_tag}
【目標受眾】${profile.audience}
【產品/服務】${product_name}
【產品說明】${product_description}
【目標通路】${target_platform}
【語氣】${tone}
【主要情緒】${primary_emotion}
【次要情緒】${(secondary_emotions || []).join('、') || '無'}
【執行限制】${(constraints || []).join('、') || '無'}
【目標字數】約 ${targetLength} 字
【文案區塊順序】${finalBlockOrder.join(' → ')}

【受眾痛點與對應解決方案】
${pairs.map((p, i) => `${i + 1}. 表層問題：${p.surface_problem}／深層渴望：${p.deep_desire}
   解決方案：${p.solution_description}（賣點：${p.core_selling_point}${p.trust_proof ? '；信任背書：' + p.trust_proof : ''}）`).join('\n')}

【範例文案風格參考（僅供學習手法，不可逐字複製）】
${swipeExamples.length ? swipeExamples.map((s, i) => `範例${i + 1}（框架：${s.framework_tag}）：${s.raw_content.slice(0, 200)}`).join('\n') : '（尚無範例文案）'}

請產出 ${VARIANT_COUNT} 組文案變體，角度分別為 ${ANGLE_TYPES.join('、')}（依序對應）。
輸出格式：
{"variants":[
  {"angle_type":"${ANGLE_TYPES[0]}","title":"...","cta":"...","blocks":[{"type":"hook","content":"..."}, ...依區塊順序...]}
  ${VARIANT_COUNT > 1 ? `, ... 共 ${VARIANT_COUNT} 組，角度依序對應 ${ANGLE_TYPES.join('、')}` : ''}
]}`;

    const raw = await call({ system, prompt, maxTokens: GENERATION_MAX_TOKENS, budgetMs: AI_BUDGET_MS });
    const parsed = parseJSON(raw);
    if (!parsed || !Array.isArray(parsed.variants) || !parsed.variants.length) {
      throw new Error('模型回應格式不符預期（缺少 variants 陣列），請稍後再試一次。');
    }

    // 7. 合規審核（規則式黑名單 + 逐字重複比對；AI 已在生成時被要求自我把關，此處為程式碼端的最後防線）
    const swipeTexts = swipeExamples.map(s => s.raw_content);
    const reviewedVariants = parsed.variants.map(v => {
      const bodyText = v.blocks.map(b => b.content).join('\n');
      const fullText = v.title + '\n' + bodyText;
      const hits = scanBlacklist(fullText);
      const overlap = hasVerbatimOverlap(bodyText, swipeTexts);
      const sensitive = isSensitiveIndustry(profile.domain_tag);
      const passed = hits.length === 0 && !overlap;
      const needs_human_review = sensitive || hits.length > 0 || overlap;
      let message = passed ? '已通過基礎法遵掃描。' : '未通過：';
      if (hits.length) message += `命中禁用字詞（${hits.join('、')}）。`;
      if (overlap) message += '偵測到與範例文案高度重複的段落。';
      if (sensitive && passed) message += '（屬敏感產業，仍建議人工複核後再發布）';
      return { ...v, body: bodyText, review: { passed, needs_human_review, message: message.trim() } };
    });

    // 8. 寫入資料庫
    const strategy = {
      step_2_framework: framework,
      step_3_outline: { tone, primary_emotion, target_length: targetLength },
      referenced_swipe_count: swipeExamples.length,
    };

    const [request] = await restRequest('generation_requests', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: user.id, domain_profile_id: profile_id, target_platform,
        product_name, product_description, status: 'completed', strategy,
      },
    });

    await restRequest('generation_params', {
      method: 'POST',
      body: {
        user_id: user.id, request_id: request.id, length_type, custom_word_count: custom_word_count || null,
        tone, primary_emotion, secondary_emotions: secondary_emotions || [], block_order: finalBlockOrder,
      },
    });

    // 批次寫入，取代原本 15~21 次序列的 Supabase REST 往返。
    const variantRows = reviewedVariants.map(v => ({
      user_id: user.id, request_id: request.id, angle_type: v.angle_type,
      title: v.title, body: v.body, cta: v.cta, platform_format: target_platform,
      block_order: v.blocks.map(b => b.type), review: v.review, adopted: false,
    }));
    const savedVariants = await restRequest('copy_variants', {
      method: 'POST',
      prefer: 'return=representation',
      body: variantRows,
    });

    const blockRows = reviewedVariants.flatMap((v, i) =>
      v.blocks.map(b => ({
        user_id: user.id, copy_variant_id: savedVariants[i].id,
        block_type: b.type, block_content: b.content, word_count: b.content.length,
      }))
    );
    if (blockRows.length) {
      await restRequest('copy_blocks', { method: 'POST', body: blockRows });
    }

    return res.status(200).json({ id: request.id, status: 'completed', strategy, variants: savedVariants });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
