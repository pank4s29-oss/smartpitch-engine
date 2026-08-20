const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const status = $('#status') || (() => { const el = document.createElement('section'); el.id = 'status'; el.setAttribute('aria-live', 'polite'); document.querySelector('#composer-panel').before(el); return el; })();

const esc = value => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

const SOURCE_LABEL = { user_input: '手動輸入', ai_suggested: 'AI 建議', raw_feedback_extraction: '語料萃取' };
const STAMP_LABEL = { unreviewed: '未複核', confirmed: '已確認', edited: '已確認．已修改', rejected: '已駁回' };
const SOURCE_TYPE_LABEL = { review: '顧客評論', support_chat: '客服對話', survey: '問卷回饋', interview_transcript: '訪談逐字稿', social_comment: '社群留言', other: '其他' };

const api = async (url, opts = {}) => {
  const token = await window.getAccessToken();
  if (!token) throw Error('請先登入後再操作。');
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, ...opts });
  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; }
  catch (e) { throw Error(`伺服器回應非預期格式（HTTP ${r.status}），可能是執行逾時或平台層錯誤：${text.slice(0, 150)}`); }
  if (!r.ok) {
    // 把錯誤回應裡的其他欄位（例如重複偵測用的 duplicate / existing_id）一併保留在 Error 物件上，
    // 讓呼叫端可以依情況做不同處理，而不只是顯示一句錯誤文字。
    const err = Error(j.error || '發生錯誤');
    Object.assign(err, j);
    throw err;
  }
  return j;
};

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.classList.toggle('error', isError);
}

// ---------------- 領域設定 ----------------

let currentProfileId = null;

async function loadProfiles(selectId) {
  const select = $('#profile-select');
  try {
    const profiles = await api('/api/domain-profiles');
    select.innerHTML = '<option value="">— 選擇領域設定 —</option>' +
      profiles.map(p => `<option value="${p.id}">${esc(p.domain_tag)}／${esc(p.audience)}</option>`).join('');
    if (selectId) select.value = selectId;
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

$('#new-profile-toggle').onclick = () => {
  const form = $('#profile-form');
  form.hidden = !form.hidden;
};

$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const profile = await api('/api/domain-profiles', { method: 'POST', body: JSON.stringify(data) });
    setStatus('已建立領域設定。');
    e.target.reset();
    e.target.hidden = true;
    await loadProfiles(profile.id);
    onProfileSelected(profile.id);
  } catch (err) { setStatus('⚠ ' + err.message, true); }
});

$('#profile-select').addEventListener('change', e => onProfileSelected(e.target.value || null));

function onProfileSelected(id) {
  currentProfileId = id;
  const scope = $('#profile-scope');
  if (!id) { scope.hidden = true; return; }
  scope.hidden = false;
  $('#report-result').hidden = true;
  refreshProfileScope();
}

async function refreshProfileScope() {
  await Promise.all([loadFeedback(), loadPainPoints(), loadReportHistory()]);
}

// ---------------- 語料匯入 ----------------

let feedbackCache = [];

async function loadFeedback() {
  try {
    feedbackCache = await api(`/api/raw-feedback?domain_profile_id=${currentProfileId}`);
    renderFeedbackList();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function renderFeedbackList() {
  const list = $('#feedback-list');
  if (!feedbackCache.length) { list.innerHTML = '<p class="muted">尚無已匯入的語料。</p>'; updateExtractBtn(); return; }
  list.innerHTML = '';
  feedbackCache.forEach(f => {
    const node = $('#feedback-item-tpl').content.cloneNode(true);
    const item = node.querySelector('.feedback-item');
    item.dataset.id = f.id;
    node.querySelector('.source-tag').textContent = SOURCE_TYPE_LABEL[f.source_type] || f.source_type;
    node.querySelector('.fb-body').textContent = f.raw_text.length > 160 ? f.raw_text.slice(0, 160) + '…' : f.raw_text;
    node.querySelector('.fb-check').onchange = updateExtractBtn;
    node.querySelector('.fb-delete').onclick = async () => {
      try { await api(`/api/raw-feedback/${f.id}`, { method: 'DELETE' }); await loadFeedback(); }
      catch (err) { setStatus('⚠ ' + err.message, true); }
    };
    list.append(node);
  });
  updateExtractBtn();
}

function updateExtractBtn() {
  const checked = $$('.feedback-item .fb-check:checked').length;
  const btn = $('#extract-btn');
  btn.disabled = checked === 0;
  btn.textContent = checked ? `對已勾選的 ${checked} 則語料開始分析 →` : '對已勾選的語料開始分析 →';
}

$('#feedback-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const raw_texts = data.raw_texts.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  if (!raw_texts.length) return setStatus('⚠ 請貼上至少一則語料內容。', true);
  try {
    const result = await api('/api/raw-feedback', {
      method: 'POST',
      body: JSON.stringify({ domain_profile_id: currentProfileId, source_type: data.source_type, raw_texts }),
    });
    setStatus(`已匯入 ${result.imported} 則語料。`);
    e.target.reset();
    await loadFeedback();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
});

$('#extract-btn').onclick = async () => {
  const ids = $$('.feedback-item').filter(el => el.querySelector('.fb-check').checked).map(el => el.dataset.id);
  if (!ids.length) return;
  const btn = $('#extract-btn');
  btn.disabled = true;
  setStatus('正在從語料中萃取並驗證痛點…');
  try {
    const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/extract`, {
      method: 'POST',
      body: JSON.stringify({ feedback_ids: ids }),
    });
    setStatus(result.message || `已萃取 ${result.pain_points.length} 筆有語料佐證的痛點。`);
    await loadPainPoints();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
  finally { updateExtractBtn(); }
};

// ---------------- 痛點清單 ----------------

let painPointsCache = [];
let solutionsCache = [];

async function loadPainPoints() {
  try {
    [painPointsCache, solutionsCache] = await Promise.all([
      api(`/api/domain-profiles/${currentProfileId}/pain-points`),
      api(`/api/domain-profiles/${currentProfileId}/solutions`),
    ]);
    renderPainList();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function renderPainList() {
  const list = $('#pain-list');
  if (!painPointsCache.length) { list.innerHTML = '<p class="muted">尚無痛點，請先匯入語料分析，或手動新增。</p>'; return; }
  list.innerHTML = '';
  painPointsCache.forEach(p => {
    const node = $('#pain-card-tpl').content.cloneNode(true);
    node.querySelector('.pc-surface').textContent = p.surface_problem;
    node.querySelector('.pc-desire').textContent = p.deep_desire;

    const stamp = node.querySelector('.pc-stamp');
    const status_ = p.review_status || 'unreviewed';
    stamp.className = 'stamp pc-stamp ' + status_;
    stamp.textContent = STAMP_LABEL[status_] || status_;

    const evidence = Array.isArray(p.evidence_source) ? p.evidence_source : [];
    const quoteEl = node.querySelector('.pc-quote');
    if (evidence.length && evidence[0].quote) {
      quoteEl.className = 'pain-quote pc-quote';
      quoteEl.textContent = `「${evidence[0].quote}」`;
    }

    node.querySelector('.pc-source').textContent = SOURCE_LABEL[p.source] || p.source || '—';
    node.querySelector('.pc-evidence').innerHTML = `佐證 <span class="num">${evidence.length}</span> 則語料`;
    node.querySelector('.pc-confidence').innerHTML = p.confidence_score != null
      ? `置信度 <span class="num">${Math.round(p.confidence_score * 100)}%</span>`
      : '置信度 <span class="num">—</span>';

    const solution = solutionsCache.find(s => s.pain_point_id === p.id);
    const solutionEl = node.querySelector('.pc-solution');
    const addBtn = node.querySelector('.pc-add-solution');
    const solForm = node.querySelector('.pc-solution-form');
    if (solution) {
      solutionEl.innerHTML = `<div class="framework-box" style="margin-top:10px"><b>${esc(solution.product_name)}</b> — ${esc(solution.core_selling_point)}</div>`;
      addBtn.hidden = true;
    } else {
      addBtn.onclick = () => { solForm.hidden = !solForm.hidden; };
      solForm.addEventListener('submit', async e => {
        e.preventDefault();
        const body = {
          pain_point_id: p.id,
          product_name: solForm.querySelector('.sol-product_name').value.trim(),
          core_selling_point: solForm.querySelector('.sol-core_selling_point').value.trim(),
          solution_description: solForm.querySelector('.sol-solution_description').value.trim(),
          trust_proof: solForm.querySelector('.sol-trust_proof').value.trim() || undefined,
        };
        try {
          await api(`/api/domain-profiles/${currentProfileId}/solutions`, { method: 'POST', body: JSON.stringify(body) });
          setStatus('已新增解決方案。');
          await loadPainPoints();
        } catch (err) { setStatus('⚠ ' + err.message, true); }
      });
    }

    node.querySelector('.pc-confirm').onclick = () => reviewPainPoint(p.id, 'confirmed');
    node.querySelector('.pc-reject').onclick = () => reviewPainPoint(p.id, 'rejected');

    list.append(node);
  });
}

async function reviewPainPoint(id, review_status) {
  try {
    await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
      method: 'PATCH',
      body: JSON.stringify({ pain_point_id: id, review_status }),
    });
    await loadPainPoints();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
}

$('#suggest-btn').onclick = async () => {
  if (!currentProfileId) return;
  setStatus('正在請 AI 提出痛點草稿（尚未寫入資料庫，需個別加入）…');
  try {
    const suggestions = await api(`/api/domain-profiles/${currentProfileId}/pain-points/suggest`);
    const preview = $('#suggest-preview');
    preview.innerHTML = '';
    suggestions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'pain-card';
      row.innerHTML = `<div class="pain-card-top"><div><h3>${esc(s.surface_problem)}</h3><p class="deep-desire">${esc(s.deep_desire)}</p></div><span class="stamp unreviewed">AI 草稿</span></div>`;
      const addBtn = document.createElement('button');
      addBtn.className = 'small secondary';
      addBtn.textContent = '加入痛點清單';
      addBtn.style.marginTop = '10px';
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        try {
          await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
            method: 'POST',
            body: JSON.stringify({ surface_problem: s.surface_problem, deep_desire: s.deep_desire, source: 'ai_suggested' }),
          });
          row.remove();
          await loadPainPoints();
        } catch (err) { setStatus('⚠ ' + err.message, true); addBtn.disabled = false; }
      };
      row.append(addBtn);
      preview.append(row);
    });
    setStatus(`AI 提出了 ${suggestions.length} 組草稿，請逐一確認是否加入清單。`);
  } catch (err) { setStatus('⚠ ' + err.message, true); }
};

$('#manual-pain-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
      method: 'POST',
      body: JSON.stringify({ ...data, source: 'user_input' }),
    });
    e.target.reset();
    setStatus('已新增痛點。');
    await loadPainPoints();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
});

// ---------------- 洞察報告 ----------------

function renderReport(report, meta) {
  const container = $('#report-result');
  container.innerHTML = '';
  const node = $('#report-tpl').content.cloneNode(true);

  node.querySelector('.r-meta').textContent = meta || '剛剛產出';

  const narrativeEl = node.querySelector('.r-narrative');
  if (report.narrative) {
    narrativeEl.textContent = report.narrative;
  } else {
    narrativeEl.className += ' unavailable';
    narrativeEl.textContent = 'AI 導讀暫時無法產生，以下數據統計仍完整可用。';
  }

  const c = report.coverage;
  const stats = [
    ['痛點總數', c.total_pain_points, false],
    ['有語料佐證', c.with_evidence, false],
    ['已人工確認', c.confirmed, false],
    ['尚未複核', c.unreviewed, c.unreviewed > 0],
    ['已配對解決方案', c.with_matched_solution, false],
    ['平均置信度', c.avg_confidence_score != null ? Math.round(c.avg_confidence_score * 100) + '%' : '—', false],
  ];
  const statGrid = node.querySelector('.r-stats');
  stats.forEach(([label, value, warn]) => {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value num${warn ? ' warn' : ''}">${value}</div>`;
    statGrid.append(cell);
  });

  const risksEl = node.querySelector('.r-risks');
  if (report.risk_flags && report.risk_flags.length) {
    report.risk_flags.forEach(f => {
      const el = document.createElement('div');
      el.className = 'risk-flag';
      el.textContent = f;
      risksEl.append(el);
    });
  }

  const fw = report.framework_recommendation;
  node.querySelector('.r-framework').innerHTML = fw
    ? `初步框架建議：<b>${esc(fw.name)}</b> — ${esc(fw.reason)}`
    : '';

  container.append(node);
  container.hidden = false;
}

$('#generate-report-btn').onclick = async () => {
  if (!currentProfileId) return;
  const btn = $('#generate-report-btn');
  btn.disabled = true;
  setStatus('正在彙整痛點驗證狀態並產出報告…');
  try {
    const result = await api('/api/insight-reports', { method: 'POST', body: JSON.stringify({ profile_id: currentProfileId }) });
    renderReport(result.report, '剛剛產出');
    setStatus('報告已產出。');
    await loadReportHistory();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
  finally { btn.disabled = false; }
};

async function loadReportHistory() {
  try {
    const items = await api(`/api/insight-reports?domain_profile_id=${currentProfileId}`);
    const el = $('#report-history');
    if (!items.length) { el.innerHTML = '尚無歷史報告。'; return; }
    el.innerHTML = '歷史報告：' + items.map(r =>
      `<button class="ghost small" data-id="${r.id}" style="margin:4px 6px 0 0">${new Date(r.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</button>`
    ).join('');
    el.querySelectorAll('button').forEach(b => b.onclick = async () => {
      try {
        const result = await api(`/api/insight-reports/${b.dataset.id}`);
        renderReport(result.report, '歷史報告');
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    });
  } catch (e) { /* 靜默失敗，不影響主流程 */ }
}

// ---------------- 產業文案手法庫（維持原有功能，僅重新定位敘述） ----------------

const swipeForm = $('#swipe-form'), swipeStatus = $('#swipe-status'), swipeList = $('#swipe-list');

swipeForm.addEventListener('submit', async e => {
  e.preventDefault();
  swipeStatus.textContent = '正在拆解結構與標籤…';
  try {
    const item = await api('/api/swipe-copies', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(swipeForm))) });
    swipeStatus.textContent = `已分類：${item.industry_tag}／${item.framework_tag}／${item.emotion_tags.join('、')}。`;
    swipeForm.reset();
    loadSwipes();
  } catch (err) { swipeStatus.textContent = '⚠ ' + err.message; }
});

async function loadSwipes() {
  try {
    const items = await api('/api/swipe-copies');
    swipeList.innerHTML = items.length ? items.map(x => `<article class="pain-card"><strong>${esc(x.industry_tag)} · ${esc(x.framework_tag)}</strong><br><span class="muted">${esc(x.emotion_tags.join('、'))}｜${esc(x.block_breakdown.join(' → '))}</span><p>${esc(x.raw_content.slice(0, 140))}${x.raw_content.length > 140 ? '…' : ''}</p><button data-id="${esc(x.id)}" class="small ghost delete">刪除</button></article>`).join('') : '<p class="muted">尚無已儲存的範例文案。</p>';
    swipeList.querySelectorAll('.delete').forEach(b => b.onclick = async () => {
      if (confirm('確定刪除這篇範例？')) { await api('/api/swipe-copies/' + b.dataset.id, { method: 'DELETE' }); loadSwipes(); }
    });
  } catch (e) { swipeList.textContent = '無法載入資料庫。'; }
}

// ---------------- 初始化 ----------------

async function init() {
  await loadProfiles();
  loadSwipes();
}
if (window.authReady) window.authReady.then(init); else init();
