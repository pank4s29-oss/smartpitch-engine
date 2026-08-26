const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');

function countConfirmed(points) {
  return points.filter(point => point.review_status === 'confirmed' || point.review_status === 'edited').length;
}

function sourceCount(feedback) {
  return new Set(feedback.map(item => item.source_type).filter(Boolean)).size;
}

function nextStep(stats) {
  if (!stats.feedback_total) return { key: 'feedback', label: '匯入第一批語料', page: 'feedback', reason: '先收集真實顧客語料，再整理受眾痛點。' };
  if (!stats.pain_total) return { key: 'pain', label: '整理受眾痛點', page: 'feedback', reason: '目前還沒有可供受眾分析使用的痛點。' };
  if (stats.pain_unreviewed > 0) return { key: 'review', label: '完成痛點複核', page: 'feedback', reason: `還有 ${stats.pain_unreviewed} 筆痛點等待確認。` };
  if (!stats.segment_total) return { key: 'segments', label: '分析潛在受眾地圖', page: 'segments', reason: '已具備確認後的痛點，可以開始反推細分受眾。' };
  if (!stats.ad_total) return { key: 'ads', label: '加入第一則廣告素材', page: 'adcopies', reason: '先把已投放或準備測試的素材放入文案庫。' };
  if (!stats.ad_with_performance) return { key: 'performance', label: '回灌廣告成效', page: 'adcopies', reason: '已有素材，但還沒有成效資料可供檢討。' };
  if (stats.ad_unreviewed_match > 0) return { key: 'match', label: '檢視素材命中狀態', page: 'adcopies', reason: `還有 ${stats.ad_unreviewed_match} 則素材尚未判斷是否打中受眾。` };
  return { key: 'iterate', label: '開始下一輪實驗', page: 'adcopies', reason: '基本資料已具備，可以比較受眾、痛點與素材成效。' };
}

function buildQuality(stats) {
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

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');
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
    const doneCount = progressItems.filter(item => item.done).length;
    return res.status(200).json({
      profile,
      stats,
      progress: { done: doneCount, total: progressItems.length, percent: Math.round(doneCount / progressItems.length * 100), items: progressItems },
      next_step: nextStep(stats),
      quality: { alerts: buildQuality(stats), level: buildQuality(stats).some(alert => alert.level === 'warning') ? 'warning' : 'good' },
    });
  } catch (err) {
    return sendError(res, 500, `讀取工作流狀態失敗：${err.message}`);
  }
};
