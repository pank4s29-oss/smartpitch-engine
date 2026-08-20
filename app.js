const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const status = $('#status') || (() => { const el = document.createElement('section'); el.id = 'status'; el.setAttribute('aria-live', 'polite'); document.querySelector('#composer-panel').before(el); return el; })();

const esc = value => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

const SOURCE_LABEL = { user_input: '手動輸入', ai_suggested: 'AI 建議', raw_feedback_extraction: '語料萃取', swipe_import: '文案手法庫帶入' };
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
let profilesCache = [];
let editingProfileId = null; // 非 null 時，#profile-form 處於「編輯既有設定」模式

async function loadProfiles(selectId) {
  const select = $('#profile-select');
  try {
    profilesCache = await api('/api/domain-profiles');
    select.innerHTML = '<option value="">— 選擇領域設定 —</option>' +
      profilesCache.map(p => `<option value="${p.id}">${esc(p.domain_tag)}／${esc(p.audience)}</option>`).join('');
    if (selectId) select.value = selectId;
    updateProfileToolbar();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function updateProfileToolbar() {
  const has = !!currentProfileId;
  $('#profile-edit-btn').disabled = !has;
  $('#profile-delete-btn').disabled = !has;
}

function setProfileFormMode(mode, profile) {
  const form = $('#profile-form');
  const submitBtn = $('#profile-form-submit');
  editingProfileId = mode === 'edit' ? profile.id : null;
  form.classList.toggle('editing', mode === 'edit');
  if (mode === 'edit') {
    form.domain_tag.value = profile.domain_tag;
    form.audience.value = profile.audience;
    const radio = form.querySelector(`input[name="price_tier"][value="${profile.price_tier}"]`);
    if (radio) radio.checked = true;
    submitBtn.textContent = '更新領域設定';
  } else {
    form.reset();
    submitBtn.textContent = '建立領域設定';
  }
  form.hidden = false;
}

$('#new-profile-toggle').onclick = () => {
  const form = $('#profile-form');
  if (!form.hidden && editingProfileId === null) { form.hidden = true; return; }
  setProfileFormMode('create');
};

$('#profile-form-cancel').onclick = () => {
  $('#profile-form').hidden = true;
  editingProfileId = null;
  $('#profile-form').classList.remove('editing');
};

$('#profile-edit-btn').onclick = () => {
  if (!currentProfileId) return;
  const profile = profilesCache.find(p => p.id === currentProfileId);
  if (profile) setProfileFormMode('edit', profile);
};

$('#profile-delete-btn').onclick = async () => {
  if (!currentProfileId) return;
  const profile = profilesCache.find(p => p.id === currentProfileId);
  const label = profile ? `${profile.domain_tag}／${profile.audience}` : '這組領域設定';
  if (!confirm(`確定要刪除「${label}」嗎？此操作無法復原，若底下仍有痛點或語料可能會被拒絕刪除。`)) return;
  try {
    await api(`/api/domain-profiles?id=${currentProfileId}`, { method: 'DELETE' });
    setStatus('已刪除領域設定。');
    currentProfileId = null;
    await loadProfiles();
    onProfileSelected(null);
  } catch (err) { setStatus('⚠ ' + err.message, true); }
};

const clearAllBtn = $('#profile-clear-all-btn');
if (clearAllBtn) {
  clearAllBtn.onclick = async () => {
    if (!profilesCache.length) { setStatus('目前沒有任何領域設定紀錄。'); return; }
    const ok = confirm(
      `確定要清空「所有」領域設定紀錄嗎？\n\n` +
      `這會一併刪除所有領域設定底下的痛點、解決方案、語料歸類、洞察報告與文案生成紀錄，` +
      `此操作無法復原。\n\n（尚未歸類到任何領域設定的語料、以及產業文案手法庫不會受影響。）`
    );
    if (!ok) return;
    clearAllBtn.disabled = true;
    setStatus('正在清空所有領域設定紀錄…');
    try {
      await api('/api/domain-profiles?action=clear-all', { method: 'DELETE' });
      currentProfileId = null;
      editingProfileId = null;
      $('#profile-form').hidden = true;
      $('#profile-form').classList.remove('editing');
      await loadProfiles();
      onProfileSelected(null);
      setStatus('已清空所有領域設定紀錄。');
    } catch (err) {
      setStatus('⚠ ' + err.message, true);
    } finally {
      clearAllBtn.disabled = false;
    }
  };
}

$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    if (editingProfileId) {
      const updated = await api(`/api/domain-profiles?id=${editingProfileId}`, { method: 'PATCH', body: JSON.stringify(data) });
      setStatus('已更新領域設定。');
      e.target.hidden = true;
      editingProfileId = null;
      e.target.classList.remove('editing');
      await loadProfiles(updated.id);
      onProfileSelected(updated.id);
      return;
    }
    const profile = await api('/api/domain-profiles', { method: 'POST', body: JSON.stringify(data) });
    setStatus('已建立領域設定。');
    e.target.reset();
    e.target.hidden = true;
    await loadProfiles(profile.id);
    onProfileSelected(profile.id);
  } catch (err) {
    if (err.duplicate && err.existing_id) {
      if (confirm(`${err.message}\n是否改用既有的「${err.existing_label}」？`)) {
        e.target.reset();
        e.target.hidden = true;
        await loadProfiles(err.existing_id);
        onProfileSelected(err.existing_id);
        return;
      }
    }
    setStatus('⚠ ' + err.message, true);
  }
});

$('#profile-select').addEventListener('change', e => onProfileSelected(e.target.value || null));

function onProfileSelected(id) {
  currentProfileId = id;
  updateProfileToolbar();
  const scope = $('#profile-scope');
  if (!id) { scope.hidden = true; return; }
  scope.hidden = false;
  $('#report-result').hidden = true;
  const suggestPreview = $('#suggest-preview');
  if (suggestPreview) suggestPreview.innerHTML = '';
  resetSegmentsPanel();
  refreshProfileScope();
}

async function refreshProfileScope() {
  await Promise.all([loadSourceLabels(), loadFeedback(), loadPainPoints(), loadReportHistory()]);
}

// ---------------- 語料來源分類管理 ----------------

let sourceLabelsCache = [];

async function loadSourceLabels() {
  try {
    sourceLabelsCache = await api('/api/raw-feedback/source-types');
    renderSourceLabels();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function renderSourceLabels() {
  const manager = $('#label-manager');
  const select = $('#source-type-select');
  const prevValue = select.value;

  manager.innerHTML = `
    <div class="label-chips"></div>
    <div class="label-add-row">
      <input type="text" placeholder="新增語料來源分類，例如：Instagram 留言" maxlength="20" class="new-label-input">
      <button type="button" class="ghost small new-label-add">＋ 新增分類</button>
    </div>`;

  const chips = manager.querySelector('.label-chips');
  sourceLabelsCache.forEach(l => {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.innerHTML = `${esc(l.label)} <button type="button" title="刪除分類" aria-label="刪除分類">×</button>`;
    chip.querySelector('button').onclick = async () => {
      if (!confirm(`刪除分類「${l.label}」？（已使用此分類的語料不受影響）`)) return;
      try {
        await api(`/api/raw-feedback/source-types/${l.id}`, { method: 'DELETE' });
        await loadSourceLabels();
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    };
    chips.append(chip);
  });

  const input = manager.querySelector('.new-label-input');
  const addBtn = manager.querySelector('.new-label-add');
  const submitLabel = async () => {
    const label = input.value.trim();
    if (!label) return;
    addBtn.disabled = true;
    try {
      await api('/api/raw-feedback/source-types', { method: 'POST', body: JSON.stringify({ label }) });
      await loadSourceLabels();
      $('#source-type-select').value = label;
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { addBtn.disabled = false; }
  };
  addBtn.onclick = submitLabel;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitLabel(); } });

  select.innerHTML = sourceLabelsCache.map(l => `<option value="${esc(l.label)}">${esc(l.label)}</option>`).join('');
  if (prevValue && sourceLabelsCache.some(l => l.label === prevValue)) select.value = prevValue;
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
    const solCancelBtn = solForm.querySelector('.sol-cancel');
    const solDeleteBtn = solForm.querySelector('.sol-delete');
    const solFields = {
      product_name: solForm.querySelector('.sol-product_name'),
      core_selling_point: solForm.querySelector('.sol-core_selling_point'),
      solution_description: solForm.querySelector('.sol-solution_description'),
      trust_proof: solForm.querySelector('.sol-trust_proof'),
    };

    if (solution) {
      solutionEl.innerHTML = `<div class="framework-box" style="margin-top:10px"><b>${esc(solution.product_name)}</b> — ${esc(solution.core_selling_point)}</div>`;
      addBtn.textContent = '編輯解決方案';
      solDeleteBtn.hidden = false;
    } else {
      solutionEl.innerHTML = '';
      addBtn.textContent = '＋ 解決方案';
      solDeleteBtn.hidden = true;
    }

    addBtn.onclick = () => {
      if (!solForm.hidden) { solForm.hidden = true; return; }
      if (solution) {
        solFields.product_name.value = solution.product_name || '';
        solFields.core_selling_point.value = solution.core_selling_point || '';
        solFields.solution_description.value = solution.solution_description || '';
        solFields.trust_proof.value = solution.trust_proof || '';
      } else {
        solForm.reset();
      }
      solForm.hidden = false;
    };
    solCancelBtn.onclick = () => { solForm.hidden = true; };

    solForm.addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        pain_point_id: p.id,
        product_name: solFields.product_name.value.trim(),
        core_selling_point: solFields.core_selling_point.value.trim(),
        solution_description: solFields.solution_description.value.trim(),
        trust_proof: solFields.trust_proof.value.trim() || undefined,
      };
      try {
        if (solution) {
          await api(`/api/domain-profiles/${currentProfileId}/solutions?solution_id=${solution.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          setStatus('已更新解決方案。');
        } else {
          await api(`/api/domain-profiles/${currentProfileId}/solutions`, { method: 'POST', body: JSON.stringify(body) });
          setStatus('已新增解決方案。');
        }
        await loadPainPoints();
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    });

    if (solution) {
      solDeleteBtn.onclick = async () => {
        if (!confirm('確定要移除這個解決方案嗎？移除後可以重新配對。')) return;
        try {
          await api(`/api/domain-profiles/${currentProfileId}/solutions?solution_id=${solution.id}`, { method: 'DELETE' });
          setStatus('已移除解決方案。');
          await loadPainPoints();
        } catch (err) { setStatus('⚠ ' + err.message, true); }
      };
    }

    // 依目前狀態顯示對應的動作按鈕，避免出現「確認已確認的痛點」這種多餘操作。
    const confirmBtn = node.querySelector('.pc-confirm');
    const rejectBtn = node.querySelector('.pc-reject');
    const restoreBtn = node.querySelector('.pc-restore');
    confirmBtn.hidden = status_ === 'confirmed' || status_ === 'edited';
    rejectBtn.hidden = status_ === 'rejected';
    restoreBtn.hidden = status_ === 'unreviewed';
    confirmBtn.onclick = () => reviewPainPoint(p.id, 'confirmed');
    rejectBtn.onclick = () => reviewPainPoint(p.id, 'rejected');
    restoreBtn.onclick = () => reviewPainPoint(p.id, 'unreviewed');

    const editBtn = node.querySelector('.pc-edit');
    const editForm = node.querySelector('.pc-edit-form');
    editBtn.onclick = () => {
      if (!editForm.hidden) { editForm.hidden = true; return; }
      editForm.querySelector('.edit-surface_problem').value = p.surface_problem;
      editForm.querySelector('.edit-deep_desire').value = p.deep_desire;
      editForm.querySelector('.edit-detail').value = p.detail || '';
      editForm.hidden = false;
    };
    editForm.querySelector('.pc-edit-cancel').onclick = () => { editForm.hidden = true; };
    editForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
          method: 'PATCH',
          body: JSON.stringify({
            pain_point_id: p.id,
            review_status: 'edited',
            surface_problem: editForm.querySelector('.edit-surface_problem').value.trim(),
            deep_desire: editForm.querySelector('.edit-deep_desire').value.trim(),
            detail: editForm.querySelector('.edit-detail').value.trim(),
          }),
        });
        setStatus('已更新痛點內容。');
        await loadPainPoints();
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    });

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

// 從產業文案手法庫中，找出與目前領域相同或相近、且已萃取出痛點的範例文案，
// 把裡面的受眾痛點列成草稿讓使用者一鍵帶入——邏輯與「AI 建議草稿」相同（草稿不直接寫入），
// 差別是這裡的草稿來自真實廣告文案的萃取結果。共用同一個 #suggest-preview 預覽區。
const swipeImportBtn = $('#swipe-import-btn');
if (swipeImportBtn) {
  swipeImportBtn.onclick = async () => {
    if (!currentProfileId) return;
    swipeImportBtn.disabled = true;
    setStatus('正在比對文案手法庫中相同／相近領域的痛點…');
    try {
      const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/from-swipe`);
      const suggestions = result.suggestions || [];
      const preview = $('#suggest-preview');
      if (preview) preview.innerHTML = '';
      if (!suggestions.length) {
        setStatus(result.message || '文案手法庫中尚無可帶入的痛點。');
        return;
      }
      suggestions.forEach(s => {
        const row = document.createElement('div');
        row.className = 'pain-card';
        row.innerHTML = `
          <div class="pain-card-top">
            <div><h3>${esc(s.surface_problem)}</h3><p class="deep-desire">${esc(s.deep_desire)}</p></div>
            <span class="stamp unreviewed">來自文案庫．${esc(s.from_industry_tag)}</span>
          </div>
          ${s.detail ? `<div class="pain-quote">${esc(s.detail)}</div>` : ''}`;
        const addBtn = document.createElement('button');
        addBtn.className = 'small secondary';
        addBtn.textContent = '加入痛點清單';
        addBtn.style.marginTop = '10px';
        addBtn.onclick = async () => {
          addBtn.disabled = true;
          try {
            await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
              method: 'POST',
              body: JSON.stringify({
                surface_problem: s.surface_problem,
                deep_desire: s.deep_desire,
                detail: s.detail || undefined,
                source: 'swipe_import',
              }),
            });
            row.remove();
            await loadPainPoints();
          } catch (err) { setStatus('⚠ ' + err.message, true); addBtn.disabled = false; }
        };
        row.append(addBtn);
        if (preview) preview.append(row);
      });
      setStatus(`從文案手法庫找到 ${suggestions.length} 組相近痛點草稿，請逐一確認是否加入清單。`);
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { swipeImportBtn.disabled = false; }
  };
}

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

// ---------------- 潛在受眾地圖 ----------------
// 從目前已通過複核（未被駁回）的痛點反推：這些痛點背後可能對應到哪些沒被明講、
// 但真實存在的細分受眾族群。每個族群卡片列出「這個族群是誰」以及「對應到哪些痛點」，
// 讓使用者可以清楚看到痛點與受眾之間的對應關係，而不只是一份扁平的痛點清單。

const SEGMENTS_PLACEHOLDER = '<p class="muted">尚未分析。點擊「分析潛在受眾」，系統會根據目前的痛點清單（已駁回者不計入）反推可能的受眾族群。</p>';

function resetSegmentsPanel() {
  const el = $('#segments-result');
  if (el) el.innerHTML = SEGMENTS_PLACEHOLDER;
}

function renderSegments(result) {
  const container = $('#segments-result');
  if (!container) return;
  const segments = result.segments || [];

  if (!segments.length) {
    container.innerHTML = `<p class="muted">${esc(result.message || '目前的痛點清單區別度不高，尚未反推出獨立的受眾族群，可以先補充更多痛點再試一次。')}</p>`;
    return;
  }

  const painMap = new Map(painPointsCache.map(p => [p.id, p]));
  container.innerHTML = '';

  if (result.note) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.style.margin = '0 0 14px';
    note.textContent = result.note;
    container.append(note);
  }

  segments.forEach(seg => {
    const card = document.createElement('article');
    card.className = 'pain-card';

    const matchedIds = seg.matched_pain_point_ids || [];
    const chips = matchedIds.map(id => {
      const p = painMap.get(id);
      if (!p) return '';
      return `<span class="label-chip" style="cursor:default">${esc(p.surface_problem)}</span>`;
    }).join('');

    card.innerHTML = `
      <div class="pain-card-top">
        <div><h3>${esc(seg.segment_name)}</h3><p class="deep-desire">${esc(seg.description)}</p></div>
        <span class="stamp confirmed">對應 <span class="num">${matchedIds.length}</span> 個痛點</span>
      </div>
      ${seg.rationale ? `<div class="pain-quote">${esc(seg.rationale)}</div>` : ''}
      <div class="pain-meta" style="margin-top:12px">這個族群特別在意的痛點：</div>
      <div class="label-chips" style="margin-top:8px">${chips || '<span class="muted">（無對應痛點）</span>'}</div>
    `;
    container.append(card);
  });
}

const segmentsBtn = $('#segments-btn');
if (segmentsBtn) {
  segmentsBtn.onclick = async () => {
    if (!currentProfileId) return;
    segmentsBtn.disabled = true;
    setStatus('正在根據目前的痛點清單反推潛在受眾族群…');
    try {
      const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/segments`);
      renderSegments(result);
      setStatus(
        result.segments && result.segments.length
          ? `分析出 ${result.segments.length} 個潛在受眾族群（依據 ${result.based_on_count} 筆痛點）。`
          : (result.message || '尚未反推出有區別度的受眾族群。')
      );
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { segmentsBtn.disabled = false; }
  };
}

// ---------------- 洞察報告 ----------------

let currentReportData = null; // { report, meta } — 保留最後一次渲染的報告，供排序切換時重用不必重打 API

const REVIEW_STATUS_ORDER = { rejected: 0, unreviewed: 1, edited: 2, confirmed: 3 };

function sortReportPainPoints(points, sortKey) {
  const copy = [...points];
  switch (sortKey) {
    case 'confidence_asc':
      return copy.sort((a, b) => (a.confidence_score ?? -1) - (b.confidence_score ?? -1));
    case 'status':
      return copy.sort((a, b) => (REVIEW_STATUS_ORDER[a.review_status] ?? 1) - (REVIEW_STATUS_ORDER[b.review_status] ?? 1));
    case 'evidence_desc':
      return copy.sort((a, b) => (b.evidence_count || 0) - (a.evidence_count || 0));
    case 'confidence_desc':
    default:
      return copy.sort((a, b) => (b.confidence_score ?? -1) - (a.confidence_score ?? -1));
  }
}

function renderReportBreakdown(container, points, sortKey) {
  container.innerHTML = '';
  if (!points.length) {
    container.innerHTML = '<p class="muted">此領域設定尚無痛點資料。</p>';
    return;
  }
  sortReportPainPoints(points, sortKey).forEach(p => {
    const node = $('#report-row-tpl').content.cloneNode(true);
    node.querySelector('.rr-surface').textContent = p.surface_problem;
    node.querySelector('.rr-desire').textContent = p.deep_desire;

    const stamp = node.querySelector('.rr-stamp');
    const st = p.review_status || 'unreviewed';
    stamp.className = 'stamp rr-stamp ' + st;
    stamp.textContent = STAMP_LABEL[st] || st;

    const pct = p.confidence_score != null ? Math.round(p.confidence_score * 100) : 0;
    node.querySelector('.rr-bar').style.width = pct + '%';

    node.querySelector('.rr-source').textContent = SOURCE_LABEL[p.source] || p.source || '—';
    node.querySelector('.rr-evidence').innerHTML = `佐證 <span class="num">${p.evidence_count || 0}</span> 則語料`;
    node.querySelector('.rr-confidence').innerHTML = p.confidence_score != null
      ? `置信度 <span class="num">${pct}%</span>`
      : '置信度 <span class="num">—</span>';

    const solEl = node.querySelector('.rr-solution');
    if (p.solution) {
      const fit = p.solution.fit_score != null ? `｜適配度 <span class="num">${Math.round(p.solution.fit_score * 100)}%</span>` : '';
      solEl.innerHTML = `<div class="framework-box"><b>${esc(p.solution.product_name)}</b> — ${esc(p.solution.core_selling_point)}${fit}</div>`;
    } else {
      solEl.innerHTML = '<span class="no-solution">尚未配對解決方案</span>';
    }

    container.append(node);
  });
}

function renderReport(report, meta) {
  currentReportData = { report, meta };
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
    ['已駁回', c.rejected, false],
    ['已配對解決方案', c.with_matched_solution, false],
    ['平均置信度', c.avg_confidence_score != null ? Math.round(c.avg_confidence_score * 100) + '%' : '—', false],
    ['平均適配度', c.avg_fit_score != null ? Math.round(c.avg_fit_score * 100) + '%' : '—', false],
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

  const sortSelect = node.querySelector('.r-sort');
  const breakdownEl = node.querySelector('.r-breakdown');
  const points = Array.isArray(report.pain_points) ? report.pain_points : [];
  renderReportBreakdown(breakdownEl, points, sortSelect.value);
  sortSelect.addEventListener('change', () => renderReportBreakdown(breakdownEl, points, sortSelect.value));

  node.querySelector('.r-print').onclick = () => window.print();

  container.append(node);
  container.hidden = false;
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
