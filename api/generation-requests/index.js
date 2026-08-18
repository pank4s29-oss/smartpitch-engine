const { getUserFromRequest, restRequest, sendError } = require('../_lib/supabase');
const { callClaude, parseJSON } = require('../_lib/anthropic');
const { scanBlacklist, isSensitiveIndustry, hasVerbatimOverlap } = require('../_lib/compliance');

const LENGTH_MAP = { short: 100, medium: 220, long: 500 };
const DEFAULT_BLOCK_ORDER = {
  low: ['hook', 'pain_agitate', 'solution', 'urgency', 'cta'],
  high: ['hook', 'solution', 'trust_proof', 'emotional_close', 'cta'],
};

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

    // 6. 組 Prompt，呼叫 Claude 產出 3 組變體
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

請產出 3 組文案變體，角度分別為 fear（恐懼訴求）、aspiration（夢想訴求）、logic（邏輯說服）。
輸出格式：
{"variants":[
  {"angle_type":"fear","title":"...","cta":"...","blocks":[{"type":"hook","content":"..."}, ...依區塊順序...]}
  , ... 共3組
]}`;

    const raw = await callClaude({ system, prompt, maxTokens: 4000 });
    const parsed = parseJSON(raw);

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

    const savedVariants = [];
    for (const v of reviewedVariants) {
      const [variant] = await restRequest('copy_variants', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          user_id: user.id, request_id: request.id, angle_type: v.angle_type,
          title: v.title, body: v.body, cta: v.cta, platform_format: target_platform,
          block_order: v.blocks.map(b => b.type), review: v.review, adopted: false,
        },
      });
      for (const b of v.blocks) {
        await restRequest('copy_blocks', {
          method: 'POST',
          body: { user_id: user.id, copy_variant_id: variant.id, block_type: b.type, block_content: b.content, word_count: b.content.length },
        });
      }
      savedVariants.push(variant);
    }

    return res.status(200).json({ id: request.id, status: 'completed', strategy, variants: savedVariants });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
};
