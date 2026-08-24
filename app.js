const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const status = $('#status') || (() => { const el = document.createElement('section'); el.id = 'status'; el.setAttribute('aria-live', 'polite'); document.querySelector('#composer-panel').before(el); return el; })();

const esc = value => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

// 產品/服務設定的顯示格式：以產品名稱為主，後面用斜線接領域，方便在下拉選單中一眼認出是哪個產品。
// 舊資料若沒有 product_name（理論上不會發生，但保底），退回原本的 domain_tag／audience 格式。
const profileLabel = p => (p && p.product_name) ? `${p.product_name}／${p.domain_tag}` : `${p.domain_tag}／${p.audience}`;

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
    select.innerHTML = '<option value="">— 選擇產品/服務設定 —</option>' +
      profilesCache.map(p => `<option value="${p.id}">${esc(profileLabel(p))}</option>`).join('');
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
    form.product_name.value = profile.product_name || '';
    form.core_selling_point.value = profile.core_selling_point || '';
    form.solution_description.value = profile.solution_description || '';
    form.trust_proof.value = profile.trust_proof || '';
    const activeConstraints = new Set(Array.isArray(profile.business_constraints) ? profile.business_constraints : []);
    $$('#profile-form input[name="constraints"]').forEach(cb => { cb.checked = activeConstraints.has(cb.value); });
    submitBtn.textContent = '更新產品／服務設定';
  } else {
    form.reset();
    submitBtn.textContent = '建立產品／服務設定';
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
  const label = profile ? profileLabel(profile) : '這組產品/服務設定';
  if (!confirm(`確定要刪除「${label}」嗎？此操作無法復原，若底下仍有痛點或語料可能會被拒絕刪除。`)) return;
  try {
    await api(`/api/domain-profiles?id=${currentProfileId}`, { method: 'DELETE' });
    setStatus('已刪除產品/服務設定。');
    currentProfileId = null;
    await loadProfiles();
    onProfileSelected(null);
  } catch (err) { setStatus('⚠ ' + err.message, true); }
};

const clearAllBtn = $('#profile-clear-all-btn');
if (clearAllBtn) {
  clearAllBtn.onclick = async () => {
    if (!profilesCache.length) { setStatus('目前沒有任何產品/服務設定紀錄。'); return; }
    const ok = confirm(
      `確定要清空「所有」產品/服務設定紀錄嗎？\n\n` +
      `這會一併刪除所有產品/服務設定底下的痛點、解決方案、語料歸類、洞察報告與文案生成紀錄，` +
      `此操作無法復原。\n\n（尚未歸類到任何產品/服務設定的語料、以及產業文案手法庫不會受影響。）`
    );
    if (!ok) return;
    clearAllBtn.disabled = true;
    setStatus('正在清空所有產品/服務設定紀錄…');
    try {
      await api('/api/domain-profiles?action=clear-all', { method: 'DELETE' });
      currentProfileId = null;
      editingProfileId = null;
      $('#profile-form').hidden = true;
      $('#profile-form').classList.remove('editing');
      await loadProfiles();
      onProfileSelected(null);
      setStatus('已清空所有產品/服務設定紀錄。');
    } catch (err) {
      setStatus('⚠ ' + err.message, true);
    } finally {
      clearAllBtn.disabled = false;
    }
  };
}

$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData);
  // 呈現媒介限制是多選 checkbox，Object.fromEntries 對同名欄位只會保留最後一個值，
  // 要另外用 getAll 取出完整陣列，否則勾選多個限制送出後只會剩一個。
  data.constraints = formData.getAll('constraints');
  try {
    if (editingProfileId) {
      const updated = await api(`/api/domain-profiles?id=${editingProfileId}`, { method: 'PATCH', body: JSON.stringify(data) });
      setStatus('已更新產品/服務設定。');
      e.target.hidden = true;
      editingProfileId = null;
      e.target.classList.remove('editing');
      await loadProfiles(updated.id);
      onProfileSelected(updated.id);
      return;
    }
    const profile = await api('/api/domain-profiles', { method: 'POST', body: JSON.stringify(data) });
    setStatus('已建立產品/服務設定。');
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

// 語料的標籤列：來源分類 + （若有）原始日期 + （若有）評分。日期／評分是 CSV／結構化匯入
// 才會有的欄位，純文字貼上匯入的語料這兩欄會是空的，不影響顯示。
function feedbackTag(f) {
  const parts = [SOURCE_TYPE_LABEL[f.source_type] || f.source_type];
  if (f.occurred_at) {
    const d = new Date(f.occurred_at);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString('zh-TW'));
  }
  if (f.rating !== null && f.rating !== undefined) parts.push(`${f.rating}★`);
  return parts.join(' · ');
}

function renderFeedbackList() {
  const list = $('#feedback-list');
  if (!feedbackCache.length) { list.innerHTML = '<p class="muted">尚無已匯入的語料。</p>'; updateExtractBtn(); return; }
  list.innerHTML = '';
  feedbackCache.forEach(f => {
    const node = $('#feedback-item-tpl').content.cloneNode(true);
    const item = node.querySelector('.feedback-item');
    item.dataset.id = f.id;
    node.querySelector('.source-tag').textContent = feedbackTag(f);
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

// ---------------- CSV / 檔案匯入 ----------------
// 讓「日常素材」不用先手動整理成一則一則貼上的文字——顧客評論匯出檔、問卷回覆、
// 客服紀錄常常是 CSV，這裡直接讀檔、抓表頭、讓使用者指定欄位對應，其餘欄位自動收進 meta。
// 純前端解析，不依賴任何第三方套件，避免額外的相依性與載入時間。

let csvHeaders = [];
let csvRows = []; // 陣列，每個元素是 { 欄位名稱: 值 }，不含表頭列

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* 忽略，換行以 \n 為準 */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

const csvFileInput = $('#csv-file-input');
const csvMappingPanel = $('#csv-mapping-panel');

if (csvFileInput && csvMappingPanel) {
  csvFileInput.addEventListener('change', async () => {
    const file = csvFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      if (parsed.length < 2) throw new Error('這個檔案看起來沒有資料列（至少需要標題列 + 1 列資料）。');
      csvHeaders = parsed[0].map(h => h.trim()).filter(Boolean);
      csvRows = parsed.slice(1).map(r => Object.fromEntries(csvHeaders.map((h, i) => [h, (r[i] || '').trim()])));
      renderCsvMapping();
    } catch (err) {
      setStatus('⚠ CSV 解析失敗：' + err.message, true);
    }
  });
}

function csvColumnOptions(guess) {
  return '<option value="">— 不對應 —</option>' +
    csvHeaders.map(h => `<option value="${esc(h)}"${h === guess ? ' selected' : ''}>${esc(h)}</option>`).join('');
}

function renderCsvMapping() {
  const guessTextCol = csvHeaders.find(h => /內容|文字|評論|留言|content|text|comment|feedback/i.test(h)) || csvHeaders[0];
  const guessDateCol = csvHeaders.find(h => /日期|時間|date|time/i.test(h)) || '';
  const guessRatingCol = csvHeaders.find(h => /評分|星|rating|score/i.test(h)) || '';

  csvMappingPanel.innerHTML = `
    <p class="muted" style="margin-top:14px">共讀到 <span class="num">${csvRows.length}</span> 列資料，請確認欄位對應：</p>
    <div class="grid">
      <label>語料內容欄位（必填）<select class="csv-map" data-field="raw_text">${csvColumnOptions(guessTextCol)}</select></label>
      <label>日期欄位（選填）<select class="csv-map" data-field="occurred_at">${csvColumnOptions(guessDateCol)}</select></label>
      <label>評分欄位（選填，0-5）<select class="csv-map" data-field="rating">${csvColumnOptions(guessRatingCol)}</select></label>
    </div>
    <p class="muted" style="margin:2px 0 12px">其餘未對應的欄位會整批存成補充資訊（meta），不會遺失，未來分析可以用得上。</p>
    <div class="csv-preview"></div>
    <button type="button" id="csv-import-confirm" class="secondary" style="margin-top:12px">確認匯入這 ${csvRows.length} 筆</button>
  `;
  renderCsvPreview();
  csvMappingPanel.querySelectorAll('.csv-map').forEach(sel => sel.addEventListener('change', renderCsvPreview));
  $('#csv-import-confirm').onclick = submitCsvImport;
}

function currentCsvMapping() {
  const map = {};
  csvMappingPanel.querySelectorAll('.csv-map').forEach(sel => { map[sel.dataset.field] = sel.value; });
  return map;
}

function renderCsvPreview() {
  const map = currentCsvMapping();
  const preview = csvMappingPanel.querySelector('.csv-preview');
  if (!preview) return;
  const sample = csvRows.slice(0, 3);
  preview.innerHTML = sample.length ? sample.map(r => {
    const tagBits = [];
    if (map.occurred_at) tagBits.push(esc(r[map.occurred_at] || '—'));
    if (map.rating) tagBits.push(esc(r[map.rating] || '—') + '★');
    const body = map.raw_text ? (r[map.raw_text] || '').slice(0, 160) : '（尚未指定語料內容欄位）';
    return `<div class="feedback-item"><div class="fb-text"><span class="source-tag">${tagBits.join(' · ')}</span><div class="fb-body">${esc(body)}</div></div></div>`;
  }).join('') : '<p class="muted">無可預覽資料。</p>';
}

async function submitCsvImport() {
  const map = currentCsvMapping();
  if (!map.raw_text) return setStatus('⚠ 請先指定「語料內容欄位」。', true);
  const sourceType = $('#source-type-select').value;
  if (!sourceType) return setStatus('⚠ 請先在上方選擇語料來源分類，再匯入 CSV。', true);

  const items = csvRows.map(r => {
    const meta = {};
    csvHeaders.forEach(h => {
      if (h !== map.raw_text && h !== map.occurred_at && h !== map.rating && r[h]) meta[h] = r[h];
    });
    return {
      raw_text: r[map.raw_text] || '',
      occurred_at: map.occurred_at ? r[map.occurred_at] : undefined,
      rating: map.rating ? r[map.rating] : undefined,
      meta,
    };
  }).filter(it => it.raw_text && it.raw_text.trim());

  if (!items.length) return setStatus('⚠ 沒有可匯入的資料列（語料內容欄位可能是空的）。', true);

  const btn = $('#csv-import-confirm');
  if (btn) btn.disabled = true;
  setStatus(`正在匯入 ${items.length} 筆 CSV 資料…`);
  try {
    // 後端單次匯入上限是 MAX_BATCH_SIZE（目前 200），CSV 常常一次就有更多筆，
    // 這裡自動依上限切批送出，使用者不用自己手動拆檔案或分好幾次上傳。
    const CHUNK_SIZE = 200;
    let imported = 0;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const result = await api('/api/raw-feedback', {
        method: 'POST',
        body: JSON.stringify({ domain_profile_id: currentProfileId, source_type: sourceType, items: chunk }),
      });
      imported += result.imported;
    }
    setStatus(`已從 CSV 匯入 ${imported} 則語料。`);
    csvRows = []; csvHeaders = [];
    csvMappingPanel.innerHTML = '';
    if (csvFileInput) csvFileInput.value = '';
    await loadFeedback();
  } catch (err) {
    setStatus('⚠ ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

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
// 解決方案改為在「產品／服務設定」填一次、套用到底下所有痛點，
// 這裡只需顯示目前這組設定的解決方案（唯讀），不再需要每筆痛點各自新增/編輯/刪除解決方案。

let painPointsCache = [];

async function loadPainPoints() {
  try {
    painPointsCache = await api(`/api/domain-profiles/${currentProfileId}/pain-points`);
    renderPainList();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function currentProfileSolution() {
  const profile = profilesCache.find(p => p.id === currentProfileId);
  if (!profile || !profile.product_name || !profile.solution_description) return null;
  return { product_name: profile.product_name, core_selling_point: profile.core_selling_point };
}

// 痛點的「來源分組」：文案手法庫帶入的痛點跟使用者自己蒐集/手動建立的痛點分開顯示，
// 避免兩種來源（一個是別人廣告文案裡歸納出來的手法參考，一個是自己顧客的真實聲音）混在一起，
// 誤把「別人的手法猜測」當成「自己顧客的第一手證據」來判斷可信度。
const SWIPE_SOURCE = 'swipe_import';
const PAIN_GROUPS = [
  { key: 'own', label: '您自己的語料與手動建立', match: s => s !== SWIPE_SOURCE, cardClass: '' },
  { key: 'swipe', label: '來自文案手法庫帶入（參考手法，非您自己的顧客語料）', match: s => s === SWIPE_SOURCE, cardClass: 'from-swipe' },
];

function buildPainCard(p, solution, extraClass) {
  const node = $('#pain-card-tpl').content.cloneNode(true);
  const card = node.querySelector('.pain-card');
  if (extraClass) card.classList.add(extraClass);

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

  // 完整陳述（detail）：之前萃取/建議時就已經寫入資料庫，但畫面上一直沒有顯示出來，
  // 只看得到一句話的表層問題／深層渴望，訊息量不夠。這裡補上，讓使用者不用再腦補情境。
  if (p.detail) {
    const detailEl = document.createElement('p');
    detailEl.className = 'pain-detail';
    detailEl.textContent = p.detail;
    node.querySelector('.pc-quote').after(detailEl);
  }

  node.querySelector('.pc-source').textContent = SOURCE_LABEL[p.source] || p.source || '—';
  node.querySelector('.pc-evidence').innerHTML = `佐證 <span class="num">${evidence.length}</span> 則語料`;
  node.querySelector('.pc-confidence').innerHTML = p.confidence_score != null
    ? `置信度 <span class="num">${Math.round(p.confidence_score * 100)}%</span>`
    : '置信度 <span class="num">—</span>';

  const solutionEl = node.querySelector('.pc-solution');
  solutionEl.innerHTML = solution
    ? `<div class="framework-box" style="margin-top:10px"><b>${esc(solution.product_name)}</b>${solution.core_selling_point ? ' — ' + esc(solution.core_selling_point) : ''}</div>`
    : '<p class="muted" style="margin-top:10px">尚未在「產品／服務設定」中填寫解決方案，請先到上方編輯設定。</p>';

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

  node.querySelector('.pc-delete').onclick = async () => {
    if (!confirm(`確定要刪除「${p.surface_problem}」這筆痛點嗎？此操作無法復原。`)) return;
    try {
      await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
        method: 'DELETE',
        body: JSON.stringify({ pain_point_id: p.id }),
      });
      setStatus('已刪除痛點。');
      await loadPainPoints();
    } catch (err) { setStatus('⚠ ' + err.message, true); }
  };

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

  return node;
}

function renderPainList() {
  const list = $('#pain-list');
  if (!painPointsCache.length) { list.innerHTML = '<p class="muted">尚無痛點，請先匯入語料分析，或手動新增。</p>'; return; }
  list.innerHTML = '';
  const solution = currentProfileSolution();

  PAIN_GROUPS.forEach(group => {
    const points = painPointsCache.filter(p => group.match(p.source));
    if (!points.length) return;
    const heading = document.createElement('div');
    heading.className = 'pain-group-heading' + (group.key === 'swipe' ? ' swipe' : '');
    heading.innerHTML = `<span>${esc(group.label)}</span><span class="num">${points.length}</span>`;
    list.append(heading);
    points.forEach(p => list.append(buildPainCard(p, solution, group.cardClass)));
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
  const btn = $('#suggest-btn');
  // 防止使用者手滑連點：AI 呼叫的免費額度本來就有限（每分鐘可呼叫次數），
  // 重複送出同一個請求只會更快把額度用完，對使用者沒有任何好處。
  btn.disabled = true;
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
  finally { btn.disabled = false; }
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
      ${seg.differentiation ? `<div class="segment-differentiation"><b>與目標受眾的差異：</b>${esc(seg.differentiation)}</div>` : ''}
      ${Array.isArray(seg.suggested_formats) && seg.suggested_formats.length ? `
      <div class="pain-meta" style="margin-top:12px">適合賣給這個族群的數位資產形式：</div>
      <div class="framework-box" style="margin-top:8px">${seg.suggested_formats.map(f =>
        `<div style="margin-bottom:6px"><b>${esc(f.format)}</b>${f.reason ? ' — ' + esc(f.reason) : ''}</div>`
      ).join('')}</div>` : ''}
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
          ? `分析出 ${result.segments.length} 個潛在受眾族群（依據 ${result.based_on_count} 筆痛點）${result.constraints_applied ? '，已套用呈現媒介限制：' + result.constraints_applied : ''}。`
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
    container.innerHTML = '<p class="muted">此產品/服務設定尚無痛點資料。</p>';
    return;
  }
  sortReportPainPoints(points, sortKey).forEach(p => {
    const node = $('#report-row-tpl').content.cloneNode(true);
    node.querySelector('.rr-surface').textContent = p.surface_problem;
    node.querySelector('.rr-desire').textContent = p.deep_desire;
    if (p.detail) {
      const detailEl = document.createElement('p');
      detailEl.className = 'pain-detail';
      node.querySelector('.rr-desire').after(detailEl);
      detailEl.textContent = p.detail;
    }

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

  const dp = report.domain_profile || {};
  node.querySelector('.r-meta').textContent = (meta || '剛剛產出') + (dp.business_constraints ? `｜呈現媒介限制：${dp.business_constraints}` : '');

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
  const submitBtn = swipeForm.querySelector('button[type="submit"]');
  // 這支會即時呼叫 AI 拆解文案結構，同樣要擋掉手滑連點造成的重複呼叫。
  if (submitBtn) submitBtn.disabled = true;
  swipeStatus.textContent = '正在分析受眾痛點與身份洞察…';
  try {
    const item = await api('/api/swipe-copies', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(swipeForm))) });
    const painCount = Array.isArray(item.extracted_pain_points) ? item.extracted_pain_points.length : 0;
    swipeStatus.textContent = `已分類：${item.industry_tag}／${item.framework_tag}。萃取到 ${painCount} 組受眾痛點與身份洞察。`;
    swipeForm.reset();
    loadSwipes();
  } catch (err) { swipeStatus.textContent = '⚠ ' + err.message; }
  finally { if (submitBtn) submitBtn.disabled = false; }
});

function swipeCardHtml(x) {
  const painPoints = Array.isArray(x.extracted_pain_points) ? x.extracted_pain_points : [];
  const insightHtml = painPoints.length
    ? `<div class="swipe-insights">` + painPoints.map(p => `
        <div class="swipe-insight-item">
          <p class="swipe-insight-surface">${esc(p.surface_problem)}</p>
          ${p.identity_appeal ? `<p class="swipe-insight-identity"><b>身份認同：</b>${esc(p.identity_appeal)}</p>` : ''}
          ${p.why_targeted ? `<p class="swipe-insight-why"><b>為什麼鎖定：</b>${esc(p.why_targeted)}</p>` : ''}
        </div>`).join('') + `</div>`
    : `<p class="muted">尚未萃取出可用的受眾洞察（可能是舊資料，點「重新分析」用最新邏輯重跑一次）。</p>`;

  return `<article class="pain-card">
    <strong>${esc(x.industry_tag)} · ${esc(x.framework_tag)}</strong><br>
    <span class="muted">${esc((x.emotion_tags || []).join('、'))}｜${esc((x.block_breakdown || []).join(' → '))}</span>
    <p>${esc(x.raw_content.slice(0, 140))}${x.raw_content.length > 140 ? '…' : ''}</p>
    ${insightHtml}
    <div class="pain-actions">
      <button data-id="${esc(x.id)}" class="small ghost reanalyze">重新分析</button>
      <button data-id="${esc(x.id)}" class="small danger ghost delete">刪除</button>
    </div>
  </article>`;
}

async function loadSwipes() {
  try {
    const items = await api('/api/swipe-copies');
    swipeList.innerHTML = items.length ? items.map(swipeCardHtml).join('') : '<p class="muted">尚無已儲存的範例文案。</p>';
    swipeList.querySelectorAll('.delete').forEach(b => b.onclick = async () => {
      if (confirm('確定刪除這篇範例？')) { await api('/api/swipe-copies/' + b.dataset.id, { method: 'DELETE' }); loadSwipes(); }
    });
    // 重新分析：用最新的分析邏輯（優先萃取受眾痛點／為什麼鎖定／身份認同，不再因為文案沒把
    // 問題講白就回傳空陣列）重跑舊資料，不用使用者自己刪除重貼一次。
    swipeList.querySelectorAll('.reanalyze').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const original = b.textContent;
      b.textContent = '重新分析中…';
      try {
        await api('/api/swipe-copies/' + b.dataset.id, { method: 'PUT', body: JSON.stringify({ reanalyze: true }) });
        await loadSwipes();
      } catch (err) {
        setStatus('⚠ ' + err.message, true);
        b.disabled = false;
        b.textContent = original;
      }
    });
  } catch (e) { swipeList.textContent = '無法載入資料庫。'; }
}

// ---------------- 初始化 ----------------

async function init() {
  await loadProfiles();
  loadSwipes();
}
if (window.authReady) window.authReady.then(init); else init();
