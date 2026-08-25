const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const status = $('#status') || (() => { const el = document.createElement('section'); el.id = 'status'; el.setAttribute('aria-live', 'polite'); document.querySelector('#composer-panel').before(el); return el; })();

const esc = value => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

// ---------------- 圖片上傳共用小工具 ----------------
// 語料匯入（截圖）與文案手法庫（廣告創意圖片）都需要「選圖 → 轉 base64 → 顯示縮圖預覽」，
// 共用同一組小工具，避免兩處各寫一次幾乎一樣的 FileReader 邏輯。

// 把 <input type="file"> 選到的單一檔案轉成 { data, media_type }，data 是純 base64（已去掉
// data:image/...;base64, 前綴），直接對應後端 API 期待的格式。
function fileToImagePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(reader.result || '');
      if (!match) { reject(new Error(`圖片讀取失敗：${file.name}`)); return; }
      resolve({ data: match[2], media_type: match[1] });
    };
    reader.onerror = () => reject(new Error(`圖片讀取失敗：${file.name}`));
    reader.readAsDataURL(file);
  });
}

// 在指定容器內顯示選取檔案的縮圖，純視覺回饋，不影響送出時的實際資料（送出時一律重新讀檔）。
function renderImagePreview(container, fileList) {
  if (!container) return;
  container.innerHTML = '';
  Array.from(fileList || []).forEach(file => {
    const img = document.createElement('img');
    img.className = 'image-preview-thumb';
    img.alt = file.name;
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.readAsDataURL(file);
    container.appendChild(img);
  });
}

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
  showInlineNotice(msg, isError);
}

// ---------------- 就近顯示通知 ----------------
// 問題：原本所有 setStatus() 呼叫只會更新頁面最上方那一條 #status，使用者點了頁面
// 中／下段的按鈕之後，看不到任何反應，得自己往上拉才看得到結果或錯誤訊息。
// 解法：用 capture 階段的全域 click 監聽器，記住「使用者最後點的是哪個按鈕」，
// 之後任何地方呼叫 setStatus() 時，除了照舊更新最上方的狀態列，也順便在那顆按鈕
// 旁邊浮現一個小提示。這樣完全不用改動檔案裡其他四十幾處 setStatus() 呼叫。
let lastActionEl = null;
document.addEventListener('click', e => {
  const el = e.target.closest('button, .fb-delete, [role="button"]');
  if (el) lastActionEl = el;
}, true);

function showInlineNotice(msg, isError) {
  const anchor = lastActionEl;
  if (!anchor || !document.body.contains(anchor)) return;
  // 同一顆按鈕若還留著上一次的提示，先移除，避免疊加成一長串。
  if (anchor._inlineNotice && anchor._inlineNotice.parentNode) anchor._inlineNotice.remove();
  clearTimeout(anchor._inlineNoticeTimer);

  const rect = anchor.getBoundingClientRect();
  const notice = document.createElement('div');
  notice.className = 'inline-notice' + (isError ? ' error' : '');
  notice.textContent = msg;
  notice.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  notice.style.left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 300)) + 'px';
  document.body.append(notice);
  anchor._inlineNotice = notice;

  const dismiss = () => { notice.remove(); window.removeEventListener('scroll', dismiss, true); };
  window.addEventListener('scroll', dismiss, true); // 捲動後座標就不對了，直接收掉比讓它飄在錯位置好
  anchor._inlineNoticeTimer = setTimeout(dismiss, isError ? 6000 : 4000);
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
  const matchedTemplatesResult = $('#matched-templates-result');
  if (matchedTemplatesResult) matchedTemplatesResult.innerHTML = '';
  resetSegmentsPanel();
  resetAdCopiesPanel();
  refreshProfileScope();
}

async function refreshProfileScope() {
  await Promise.all([loadSourceLabels(), loadFeedback(), loadPainPoints(), loadReportHistory(), loadAdCopies()]);
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

// 語料匯入與痛點紀錄合併成一個動作：新增一則語料的同時，一定要一併填寫這則語料
// 對應的痛點（表層問題／深層渴望），送出後依序打兩支 API——先建立語料，成功後拿到
// 剛建立那筆語料的 id，當成這筆痛點的 evidence_source 一起送出，讓手動輸入的痛點
// 也能像 AI 萃取的痛點一樣有語料佐證可以統計，而不是「佐證 0 則」。
// 若這則語料因為雜訊或重複被過濾掉（imported 為 0），就不建立痛點，把過濾原因
// 顯示出來讓使用者調整內容後重新送出，避免出現一筆沒有真實語料佐證、卻標成
// 「使用者輸入」的孤立痛點。
$('#feedback-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const raw_text = (data.raw_text || '').trim();
  const surface_problem = (data.surface_problem || '').trim();
  const deep_desire = (data.deep_desire || '').trim();
  if (!raw_text) return setStatus('⚠ 請貼上語料內容。', true);
  if (!surface_problem || !deep_desire) return setStatus('⚠ 請同時填寫這則語料對應的表層問題與深層渴望。', true);

  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  setStatus('正在新增語料並記錄對應痛點…');
  try {
    const fbResult = await api('/api/raw-feedback', {
      method: 'POST',
      body: JSON.stringify({ domain_profile_id: currentProfileId, source_type: data.source_type, raw_text }),
    });
    if (!fbResult.imported || !Array.isArray(fbResult.items) || !fbResult.items.length) {
      setStatus('⚠ ' + (fbResult.message || '這則語料未能匯入（可能是雜訊或與既有語料重複），因此未建立對應痛點，請調整內容後再試一次。'), true);
      return;
    }
    const item = fbResult.items[0];
    await api(`/api/domain-profiles/${currentProfileId}/pain-points`, {
      method: 'POST',
      body: JSON.stringify({
        surface_problem, deep_desire, detail: data.detail || '',
        source: 'user_input',
        evidence_source: [{ raw_customer_feedback_id: item.id, quote: item.raw_text }],
      }),
    });
    setStatus('已新增語料並記錄對應痛點。');
    form.reset();
    await loadFeedback();
    await loadPainPoints();
  } catch (err) { setStatus('⚠ ' + err.message, true); }
  finally { if (btn) btn.disabled = false; }
});

// 進階：批次匯入語料。不強制逐筆對應痛點——匯入後可在下方語料清單勾選，交由 AI
// 分析萃取，或之後再回來手動補上，適合一次貼很多則或整批匯出的素材。
const batchFeedbackForm = $('#batch-feedback-form');
if (batchFeedbackForm) {
  batchFeedbackForm.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const raw_texts = (data.raw_texts || '').split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
    if (!raw_texts.length) return setStatus('⚠ 請貼上至少一則語料內容。', true);
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const sourceType = $('#source-type-select') ? $('#source-type-select').value : undefined;
      const result = await api('/api/raw-feedback', {
        method: 'POST',
        body: JSON.stringify({ domain_profile_id: currentProfileId, source_type: sourceType, raw_texts }),
      });
      setStatus(`已批次匯入 ${result.imported} 則語料，可在下方勾選後交由 AI 分析萃取痛點。`);
      e.target.reset();
      await loadFeedback();
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { if (btn) btn.disabled = false; }
  });
}

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

// ---------------- 語料圖片匯入（截圖 OCR） ----------------
// 「僅轉出文字」模式：走跟批次文字匯入完全相同的後端流程（雜訊過濾/去重），只是文字
// 來源是 OCR 而不是使用者貼上；「立即萃取痛點」模式在匯入成功後，直接拿匯入回傳的
// 語料 id 呼叫既有的 /pain-points/extract（跟使用者手動勾選語料、按下「交由 AI 分析
// 萃取痛點」按鈕是同一支 API），不重複實作一次萃取邏輯。
const feedbackImageInput = $('#feedback-image-input');
const feedbackImagePreview = $('#feedback-image-preview');
const feedbackImageSubmitBtn = $('#feedback-image-submit');
const feedbackImageStatus = $('#feedback-image-status');
const feedbackImageMode = $('#feedback-image-mode');
const FEEDBACK_IMAGE_MAX_COUNT = 8; // 需與 api/_lib/vision.js／raw-feedback-hub.js 的上限一致

if (feedbackImageInput) {
  feedbackImageInput.addEventListener('change', () => {
    renderImagePreview(feedbackImagePreview, feedbackImageInput.files);
    if (feedbackImageSubmitBtn) feedbackImageSubmitBtn.disabled = !feedbackImageInput.files.length;
  });
}

if (feedbackImageSubmitBtn) {
  feedbackImageSubmitBtn.onclick = async () => {
    if (!currentProfileId) { feedbackImageStatus.textContent = '⚠ 請先選擇產品/服務設定。'; return; }
    const files = Array.from((feedbackImageInput && feedbackImageInput.files) || []);
    if (!files.length) return;
    if (files.length > FEEDBACK_IMAGE_MAX_COUNT) {
      feedbackImageStatus.textContent = `⚠ 單次最多上傳 ${FEEDBACK_IMAGE_MAX_COUNT} 張圖片，請分批上傳。`;
      return;
    }
    feedbackImageSubmitBtn.disabled = true;
    feedbackImageStatus.textContent = '正在辨識圖片文字…';
    try {
      const images = await Promise.all(files.map(fileToImagePayload));
      const sourceType = $('#source-type-select') ? $('#source-type-select').value : undefined;
      const result = await api('/api/raw-feedback', {
        method: 'POST',
        body: JSON.stringify({ domain_profile_id: currentProfileId, source_type: sourceType, images }),
      });
      feedbackImageStatus.textContent = result.message || `已匯入 ${result.imported} 則語料。`;
      feedbackImageInput.value = '';
      feedbackImagePreview.innerHTML = '';
      await loadFeedback();

      if (feedbackImageMode && feedbackImageMode.value === 'extract' && result.items && result.items.length) {
        feedbackImageStatus.textContent += '　正在交由 AI 萃取痛點…';
        const ids = result.items.map(it => it.id);
        const extractResult = await api(`/api/domain-profiles/${currentProfileId}/pain-points/extract`, {
          method: 'POST',
          body: JSON.stringify({ feedback_ids: ids }),
        });
        feedbackImageStatus.textContent = extractResult.message
          || `已從圖片語料萃取 ${(extractResult.pain_points || []).length} 筆有語料佐證的痛點。`;
        await loadPainPoints();
      }
    } catch (err) {
      feedbackImageStatus.textContent = '⚠ ' + err.message;
    } finally {
      feedbackImageSubmitBtn.disabled = !(feedbackImageInput && feedbackImageInput.files && feedbackImageInput.files.length);
    }
  };
}

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

// ── 高轉化文案 → 填空模板（共用）───────────────────────────────────────
// 把 [佔位符] 標記出來，讓使用者一眼看出哪些地方要換成自己的產品資訊；raw text 先跳脫過
// 再用正規表示式包標記，避免破壞 HTML escape。這個函式同時被「痛點比對」與「手法庫」兩處使用。
function templateBlankify(text) {
  return esc(text).replace(/\[[^\]]+\]/g, m => `<span class="blank">${m}</span>`);
}

// 把一份填空模板（{blocks, usage_note}）畫進指定的 container，並掛上「重新產生」按鈕。
// id 是對應的 swipe_copies id，重新產生時要打同一支 API。
function renderSwipeTemplate(id, container, template) {
  const blocksHtml = (template.blocks || []).map(b => `
    <div class="template-block">
      <div class="tb-type">${esc(b.type)}</div>
      <div class="tb-text">${templateBlankify(b.template)}</div>
      ${b.fill_guide ? `<div class="tb-guide">${esc(b.fill_guide)}</div>` : ''}
    </div>`).join('');
  container.innerHTML = `
    ${blocksHtml}
    ${template.usage_note ? `<div class="template-usage-note">${esc(template.usage_note)}</div>` : ''}
    <div class="pain-actions" style="margin-top:10px">
      <button type="button" class="small ghost template-regen">重新產生模板（會覆蓋目前版本）</button>
    </div>`;
  container.dataset.loaded = 'true';
  container.querySelector('.template-regen').onclick = async () => {
    if (!confirm('確定要重新產生這篇文案的填空模板嗎？會覆蓋目前版本。')) return;
    const regenBtn = container.querySelector('.template-regen');
    regenBtn.disabled = true;
    regenBtn.textContent = '產生中…';
    try {
      const fresh = await api(`/api/swipe-copies/${id}/template?regenerate=true`);
      renderSwipeTemplate(id, container, fresh.template);
    } catch (err) {
      setStatus('⚠ ' + err.message, true);
      regenBtn.disabled = false;
      regenBtn.textContent = '重新產生模板（會覆蓋目前版本）';
    }
  };
}

// 通用的「取得或產生模板」按鈕行為：第一次點擊才打 API（若已快取，後端直接回傳，不會重打 AI），
// 之後單純切換顯示/收合，不用每次都重新請求。
async function toggleTemplateContainer(swipeId, container, btn, expandedLabel, collapsedLabel) {
  if (container.dataset.loaded === 'true') {
    container.hidden = !container.hidden;
    btn.textContent = container.hidden ? collapsedLabel : expandedLabel;
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '產生中…';
  try {
    const result = await api(`/api/swipe-copies/${swipeId}/template`);
    renderSwipeTemplate(swipeId, container, result.template);
    container.hidden = false;
    btn.textContent = expandedLabel;
  } catch (err) {
    setStatus('⚠ ' + err.message, true);
    btn.textContent = original;
  } finally {
    btn.disabled = false;
  }
}

// ── 高轉化文案比對：痛點 × 手法庫 ──────────────────────────────────────
// 對應「文案手法庫的高轉化模板自動帶入」：找出手法庫裡跟目前痛點清單高度重合的文案，
// 讓使用者直接看到「哪篇文案打的是同一個痛點」，並可以一鍵產生填空模板來套用自己的產品特點。
const matchedTemplatesBtn = $('#matched-templates-btn');
if (matchedTemplatesBtn) {
  matchedTemplatesBtn.onclick = async () => {
    if (!currentProfileId) return;
    matchedTemplatesBtn.disabled = true;
    const original = matchedTemplatesBtn.textContent;
    matchedTemplatesBtn.textContent = '比對中…';
    const resultEl = $('#matched-templates-result');
    if (resultEl) resultEl.innerHTML = '<p class="muted">正在比對目前的痛點與手法庫中的高轉化文案…</p>';
    try {
      const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/matched-templates`);
      renderMatchedTemplates(result);
    } catch (err) {
      if (resultEl) resultEl.innerHTML = '';
      setStatus('⚠ ' + err.message, true);
    } finally {
      matchedTemplatesBtn.disabled = false;
      matchedTemplatesBtn.textContent = original;
    }
  };
}

function renderMatchedTemplates(result) {
  const resultEl = $('#matched-templates-result');
  if (!resultEl) return;
  const matches = result.matches || [];
  if (!matches.length) {
    resultEl.innerHTML = `<p class="muted">${esc(result.message || '尚未找到高度重合的文案，可以多分析幾篇同領域的範例文案再試一次。')}</p>`;
    return;
  }
  resultEl.innerHTML = matches.map((m, i) => `
    <div class="match-card" data-idx="${i}">
      <div class="match-top">
        <div>
          <p style="font-weight:600">${esc(m.surface_problem)}</p>
          <p class="muted" style="margin-top:2px">手法庫命中：「${esc(m.matched_surface_problem)}」（${esc(m.industry_tag || '未分類')} · ${esc(m.framework_tag || '未分類')}）</p>
        </div>
        <span class="match-score">相似度 ${m.similarity_score}</span>
      </div>
      ${m.matched_quote ? `<div class="pain-quote" style="margin-top:8px">「${esc(m.matched_quote)}」</div>` : ''}
      <div class="pain-actions" style="margin-top:10px">
        <button type="button" class="small secondary match-template-btn">產生／查看填空模板</button>
      </div>
      <div class="template-container" data-loaded="false" hidden></div>
    </div>`).join('') + `<p class="muted" style="margin-top:10px">共比對 ${result.based_on_count} 筆痛點（已駁回者不計入）。</p>`;

  resultEl.querySelectorAll('.match-card').forEach((card, i) => {
    const swipeId = matches[i].swipe_copy_id;
    const btn = card.querySelector('.match-template-btn');
    const container = card.querySelector('.template-container');
    btn.onclick = () => toggleTemplateContainer(swipeId, container, btn, '收合模板', '產生／查看填空模板');
  });
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
    case 'ad_ctr_desc':
      // 沒有真實廣告成效資料的痛點排到最後，而不是被當成 0 排到有資料的前面。
      return copy.sort((a, b) => {
        const aCtr = a.ad_performance && a.ad_performance.weighted_ctr != null ? a.ad_performance.weighted_ctr : -1;
        const bCtr = b.ad_performance && b.ad_performance.weighted_ctr != null ? b.ad_performance.weighted_ctr : -1;
        return bCtr - aCtr;
      });
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

    // 真實廣告成效：跟 Meta 廣告後台不一樣的地方就在這裡——這一列數據不是某支廣告
    // 單獨的表現，而是「這個受眾痛點」本身，用真實花費數據換算出來的成效。metricSpan
    // 跟廣告文案卡片／效益驗證矩陣共用同一份白話定義，同一個指標到處看起來都一樣。
    const adPerfEl = node.querySelector('.rr-ad-performance');
    if (adPerfEl) {
      const ad = p.ad_performance;
      if (ad) {
        adPerfEl.innerHTML = `<div class="pain-meta ad-performance-meta">
          <span class="label-chip" style="cursor:default">真實廣告成效已驗證</span>
          ${metricSpan('ctr', pctLabel(ad.weighted_ctr))}
          ${metricSpan('cpa', ad.weighted_cpa ?? '—')}
          ${metricSpan('cvr', pctLabel(ad.weighted_cvr))}
          ${ad.weighted_roas != null ? metricSpan('roas', ad.weighted_roas) : ''}
          <span title="依 ${ad.sample_size} 則已回灌成效的廣告文案換算${ad.low_confidence ? '，樣本數過少僅供初步參考' : ''}">樣本 <span class="num">${ad.sample_size}</span> 則廣告</span>
        </div>`;
      } else {
        adPerfEl.innerHTML = '<p class="muted" style="margin-top:8px">尚無對應的真實廣告成效數據，目前僅有語料佐證。</p>';
      }
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
    ['已有真實廣告成效驗證', c.with_ad_performance ?? 0, false],
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

  // 廣告成效亮點：這是跟 Meta 後台拉開差異的地方——不只顯示語料佐證程度，
  // 直接把「真實廣告成效驗證過的痛點」標出來，跟風險提示分開放，避免混成一長串警示。
  const adHighlightsEl = node.querySelector('.r-ad-highlights');
  if (adHighlightsEl && report.ad_performance_highlights && report.ad_performance_highlights.length) {
    report.ad_performance_highlights.forEach(h => {
      const el = document.createElement('div');
      el.className = 'risk-flag ad-highlight';
      el.textContent = h;
      adHighlightsEl.append(el);
    });
  }

  const fw = report.framework_recommendation;
  node.querySelector('.r-framework').innerHTML = fw
    ? `初步框架建議：<b>${esc(fw.name)}</b> — ${esc(fw.reason)}`
    : '';

  const sortSelect = node.querySelector('.r-sort');
  const sortLabel = node.querySelector('.r-sort-label');
  const breakdownEl = node.querySelector('.r-breakdown');
  const toggleBtn = node.querySelector('.r-toggle-breakdown');
  const points = Array.isArray(report.pain_points) ? report.pain_points : [];
  renderReportBreakdown(breakdownEl, points, sortSelect.value);
  sortSelect.addEventListener('change', () => renderReportBreakdown(breakdownEl, points, sortSelect.value));

  // 逐項分析預設收合：報告一開始只顯示摘要統計／導讀／風險提示，避免每次查看報告
  // 都直接把整個頁面撐得很長，需要的人再點一次展開完整的痛點清單。
  breakdownEl.hidden = true;
  sortLabel.hidden = true;
  toggleBtn.textContent = '顯示逐項分析 →';
  toggleBtn.onclick = () => {
    const willShow = breakdownEl.hidden;
    breakdownEl.hidden = !willShow;
    sortLabel.hidden = !willShow;
    toggleBtn.textContent = willShow ? '收合逐項分析 ←' : '顯示逐項分析 →';
  };

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

// ---------------- 廣告截圖／創意圖片上傳 ----------------
// 'ocr'：後端先 OCR 出畫面文字，再走跟上面貼文字完全相同的分析流程（含自動萃取痛點）。
// 'direct'：後端略過 OCR，讓模型直接看圖分析——適合視覺為主、文字很少的廣告創意，
// 這種情況純 OCR 常常抓不到什麼有用的文字。兩種模式回傳的資料結構完全一致，
// 這裡的成功處理邏輯直接沿用跟文字送出時相同的寫法。
const swipeImageInput = $('#swipe-image-input');
const swipeImagePreview = $('#swipe-image-preview');
const swipeImageSubmitBtn = $('#swipe-image-submit');
const swipeImageStatus = $('#swipe-image-status');
const swipeImageMode = $('#swipe-image-mode');

if (swipeImageInput) {
  swipeImageInput.addEventListener('change', () => {
    renderImagePreview(swipeImagePreview, swipeImageInput.files);
    if (swipeImageSubmitBtn) swipeImageSubmitBtn.disabled = !swipeImageInput.files.length;
  });
}

if (swipeImageSubmitBtn) {
  swipeImageSubmitBtn.onclick = async () => {
    const file = swipeImageInput && swipeImageInput.files && swipeImageInput.files[0];
    if (!file) return;
    swipeImageSubmitBtn.disabled = true;
    swipeImageStatus.textContent = (swipeImageMode && swipeImageMode.value === 'direct')
      ? '正在直接分析圖片內容…' : '正在辨識圖片文字並分析…';
    try {
      const payload = await fileToImagePayload(file);
      const sourceUrlEl = $('#swipe-image-source-url');
      const industryTagEl = $('#swipe-image-industry-tag');
      const item = await api('/api/swipe-copies', {
        method: 'POST',
        body: JSON.stringify({
          image: payload,
          image_mode: (swipeImageMode && swipeImageMode.value) || 'ocr',
          source_url: (sourceUrlEl && sourceUrlEl.value) || undefined,
          industry_tag: (industryTagEl && industryTagEl.value) || undefined,
        }),
      });
      const painCount = Array.isArray(item.extracted_pain_points) ? item.extracted_pain_points.length : 0;
      swipeImageStatus.textContent = `已分類：${item.industry_tag}／${item.framework_tag}。萃取到 ${painCount} 組受眾痛點與身份洞察。`;
      swipeImageInput.value = '';
      swipeImagePreview.innerHTML = '';
      if (sourceUrlEl) sourceUrlEl.value = '';
      if (industryTagEl) industryTagEl.value = '';
      loadSwipes();
    } catch (err) {
      swipeImageStatus.textContent = '⚠ ' + err.message;
    } finally {
      swipeImageSubmitBtn.disabled = !(swipeImageInput && swipeImageInput.files && swipeImageInput.files.length);
    }
  };
}

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
      <button data-id="${esc(x.id)}" class="small ghost template-btn">填空模板</button>
      <button data-id="${esc(x.id)}" class="small danger ghost delete">刪除</button>
    </div>
    <div class="template-container" data-id="${esc(x.id)}" data-loaded="false" hidden></div>
  </article>`;
}

// ---- 篩選（資料庫瀏覽模式）----
// 下拉選單的候選值來自後端 /api/swipe-copies/facets（實際存在資料庫中的值），
// 篩選條件本身則直接帶進 /api/swipe-copies 的查詢字串，交給後端用 PostgREST 過濾，
// 而不是先整包抓回來再用 JS 篩——手法庫量一大時效能會差很多，也才符合「像資料庫一樣查詢」的體感。
const swipeFilterQ = $('#swipe-filter-q');
const swipeFilterIndustry = $('#swipe-filter-industry');
const swipeFilterFramework = $('#swipe-filter-framework');
const swipeFilterAngle = $('#swipe-filter-angle');
const swipeFilterHasPain = $('#swipe-filter-has-pain');
const swipeFilterReset = $('#swipe-filter-reset');
const swipeFilterCount = $('#swipe-filter-count');

function fillFilterSelect(select, values) {
  if (!select) return;
  const current = select.value;
  const defaultLabel = select.dataset.defaultLabel || select.firstElementChild.textContent;
  select.dataset.defaultLabel = defaultLabel;
  select.innerHTML = `<option value="">${esc(defaultLabel)}</option>` +
    (values || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values && values.includes(current)) select.value = current;
}

async function loadSwipeFacets() {
  try {
    const facets = await api('/api/swipe-copies/facets');
    fillFilterSelect(swipeFilterIndustry, facets.industry_tag);
    fillFilterSelect(swipeFilterFramework, facets.framework_tag);
    fillFilterSelect(swipeFilterAngle, facets.angle_type);
  } catch (e) { /* 篩選選單載入失敗不影響主要清單顯示 */ }
}

function swipeFilterQueryString() {
  const params = new URLSearchParams();
  if (swipeFilterQ && swipeFilterQ.value.trim()) params.set('q', swipeFilterQ.value.trim());
  if (swipeFilterIndustry && swipeFilterIndustry.value) params.set('industry_tag', swipeFilterIndustry.value);
  if (swipeFilterFramework && swipeFilterFramework.value) params.set('framework_tag', swipeFilterFramework.value);
  if (swipeFilterAngle && swipeFilterAngle.value) params.set('angle_type', swipeFilterAngle.value);
  if (swipeFilterHasPain && swipeFilterHasPain.checked) params.set('has_pain_points', 'true');
  return params.toString();
}

[swipeFilterIndustry, swipeFilterFramework, swipeFilterAngle, swipeFilterHasPain].forEach(el => {
  if (el) el.addEventListener('change', () => loadSwipes());
});
let swipeFilterQTimer;
if (swipeFilterQ) {
  swipeFilterQ.addEventListener('input', () => {
    clearTimeout(swipeFilterQTimer);
    swipeFilterQTimer = setTimeout(() => loadSwipes(), 400);
  });
}
if (swipeFilterReset) {
  swipeFilterReset.onclick = () => {
    if (swipeFilterQ) swipeFilterQ.value = '';
    if (swipeFilterIndustry) swipeFilterIndustry.value = '';
    if (swipeFilterFramework) swipeFilterFramework.value = '';
    if (swipeFilterAngle) swipeFilterAngle.value = '';
    if (swipeFilterHasPain) swipeFilterHasPain.checked = false;
    loadSwipes();
  };
}

async function loadSwipes() {
  try {
    const qs = swipeFilterQueryString();
    const items = await api('/api/swipe-copies' + (qs ? '?' + qs : ''));
    swipeList.innerHTML = items.length ? items.map(swipeCardHtml).join('') : '<p class="muted">沒有符合篩選條件的範例文案。</p>';
    if (swipeFilterCount) swipeFilterCount.textContent = qs ? `符合篩選條件：${items.length} 篇` : `共 ${items.length} 篇`;

    swipeList.querySelectorAll('.delete').forEach(b => b.onclick = async () => {
      if (confirm('確定刪除這篇範例？')) { await api('/api/swipe-copies/' + b.dataset.id, { method: 'DELETE' }); loadSwipes(); loadSwipeFacets(); }
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
    // 填空模板：見檔案上方共用的 toggleTemplateContainer／renderSwipeTemplate。
    swipeList.querySelectorAll('.template-btn').forEach(b => {
      const container = swipeList.querySelector(`.template-container[data-id="${b.dataset.id}"]`);
      if (container) b.onclick = () => toggleTemplateContainer(b.dataset.id, container, b, '收合模板', '填空模板');
    });
    // 已經產生過模板的（fill_in_template 有快取值）直接把內容準備好，第一次點擊不用再打一次 API，
    // 但畫面仍保持收合，避免每篇文案都自動展開造成畫面過長。
    items.forEach(x => {
      if (!x.fill_in_template) return;
      const container = swipeList.querySelector(`.template-container[data-id="${x.id}"]`);
      if (container) renderSwipeTemplate(x.id, container, x.fill_in_template);
    });
  } catch (e) { swipeList.textContent = '無法載入資料庫。'; }
}

// ---------------- 洞察報告資料庫（跨產品/服務設定瀏覽） ----------------
// 篩選選項（領域／受眾／價格帶）直接沿用已經載入的 profilesCache，不用另外打 API 拿 distinct 值，
// 因為報告一定歸屬在某個產品/服務設定底下，設定本身的清單前端本來就有。

let reportLibraryCache = [];

function reportLibraryFilterOptions() {
  const domainSelect = $('#report-filter-domain');
  const audienceSelect = $('#report-filter-audience');
  const tierSelect = $('#report-filter-tier');
  if (!domainSelect || !audienceSelect || !tierSelect) return;
  const domains = [...new Set(profilesCache.map(p => p.domain_tag).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const audiences = [...new Set(profilesCache.map(p => p.audience).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  fillFilterSelect(domainSelect, domains);
  fillFilterSelect(audienceSelect, audiences);
  if (!tierSelect.dataset.built) {
    tierSelect.innerHTML = tierSelect.innerHTML + `<option value="low">低單價／快速決策</option><option value="high">高客單／建立信任</option>`;
    tierSelect.dataset.built = 'true';
  }
}

function reportLibraryCardHtml(r) {
  const profile = profilesCache.find(p => p.id === r.domain_profile_id);
  const label = profile ? profileLabel(profile) : '（設定已刪除）';
  const c = r.coverage || {};
  const created = new Date(r.created_at).toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<div class="report-library-card" data-id="${esc(r.id)}">
    <div class="rlc-meta">
      <div class="rlc-label">${esc(label)}</div>
      <div class="rlc-sub">${created}｜痛點 ${c.total_pain_points ?? '—'} 筆，已確認 ${c.confirmed ?? '—'} 筆${profile ? '｜' + esc(profile.price_tier === 'low' ? '低單價／快速決策' : '高客單／建立信任') : ''}</div>
    </div>
    <div class="rlc-actions">
      <button type="button" class="small secondary rlc-view">查看報告</button>
      <button type="button" class="small danger ghost rlc-delete">刪除</button>
    </div>
  </div>`;
}

async function loadReportLibrary() {
  const listEl = $('#report-library-list');
  if (!listEl) return;
  try {
    reportLibraryCache = await api('/api/insight-reports');
    reportLibraryFilterOptions();
    renderReportLibrary();
  } catch (e) { listEl.innerHTML = '<p class="muted">無法載入報告資料庫。</p>'; }
}

function renderReportLibrary() {
  const listEl = $('#report-library-list');
  if (!listEl) return;
  const domainFilter = $('#report-filter-domain') ? $('#report-filter-domain').value : '';
  const audienceFilter = $('#report-filter-audience') ? $('#report-filter-audience').value : '';
  const tierFilter = $('#report-filter-tier') ? $('#report-filter-tier').value : '';

  const filtered = reportLibraryCache.filter(r => {
    const profile = profilesCache.find(p => p.id === r.domain_profile_id);
    if (domainFilter && (!profile || profile.domain_tag !== domainFilter)) return false;
    if (audienceFilter && (!profile || profile.audience !== audienceFilter)) return false;
    if (tierFilter && (!profile || profile.price_tier !== tierFilter)) return false;
    return true;
  });

  listEl.innerHTML = filtered.length
    ? filtered.map(reportLibraryCardHtml).join('')
    : '<p class="muted">沒有符合篩選條件的報告。</p>';

  listEl.querySelectorAll('.rlc-view').forEach(btn => {
    const card = btn.closest('.report-library-card');
    btn.onclick = async () => {
      try {
        const result = await api(`/api/insight-reports/${card.dataset.id}`);
        renderReport(result.report, '報告資料庫');
        $('#report-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    };
  });
  listEl.querySelectorAll('.rlc-delete').forEach(btn => {
    const card = btn.closest('.report-library-card');
    btn.onclick = async () => {
      if (!confirm('確定要刪除這份報告嗎？此操作無法復原。')) return;
      btn.disabled = true;
      try {
        await api(`/api/insight-reports/${card.dataset.id}`, { method: 'DELETE' });
        reportLibraryCache = reportLibraryCache.filter(r => r.id !== card.dataset.id);
        renderReportLibrary();
        setStatus('已刪除報告。');
      } catch (err) { setStatus('⚠ ' + err.message, true); btn.disabled = false; }
    };
  });
}

['report-filter-domain', 'report-filter-audience', 'report-filter-tier'].forEach(id => {
  const el = $('#' + id);
  if (el) el.addEventListener('change', renderReportLibrary);
});
const reportFilterReset = $('#report-filter-reset');
if (reportFilterReset) {
  reportFilterReset.onclick = () => {
    ['report-filter-domain', 'report-filter-audience', 'report-filter-tier'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; });
    renderReportLibrary();
  };
}
const reportLibraryPanel = $('#report-library-panel');
if (reportLibraryPanel) {
  // 用 details 的 toggle 事件延遲載入，使用者沒展開這個區塊就不用預先打 API。
  let reportLibraryLoaded = false;
  reportLibraryPanel.addEventListener('toggle', () => {
    if (reportLibraryPanel.open && !reportLibraryLoaded) { reportLibraryLoaded = true; loadReportLibrary(); }
  });
}

// ---------------- Meta 廣告效益驗證 ----------------
// 對應「Meta 廣告知識庫與效益驗證系統」：文案進來先做 hash 去重，新文案才呼叫一次 AI
// 標籤化，之後不管回灌幾次成效數據都是純資料庫寫入。這裡刻意不重新設計一套 CSV
// parser——上面「語料匯入」區塊已經有寫好、測過的 parseCSV()，直接沿用。

let adCopiesCache = [];

function resetAdCopiesPanel() {
  const list = $('#ad-copy-list');
  if (list) list.innerHTML = '<p class="muted">尚無已匯入的廣告文案。</p>';
  const countEl = $('#ad-copy-count');
  if (countEl) countEl.textContent = '';
  const matrixResult = $('#matrix-result');
  if (matrixResult) matrixResult.innerHTML = '';
  adCsvRows = []; adCsvHeaders = [];
  const adCsvPanel = $('#ad-csv-mapping-panel');
  if (adCsvPanel) adCsvPanel.innerHTML = '';
  const adCsvInput = $('#ad-csv-file-input');
  if (adCsvInput) adCsvInput.value = '';
}

async function loadAdCopies() {
  if (!currentProfileId) return;
  try {
    adCopiesCache = await api(`/api/ad-copies?domain_profile_id=${currentProfileId}`);
    renderAdCopyList();
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function pctLabel(v) { return v != null ? (Math.round(v * 10000) / 100) + '%' : '—'; }

// ── 成效指標的白話說明 ──────────────────────────────────────────────────
// CTR／CPA／CVR／ROAS 是廣告投放圈的行話，不是每個使用者一看就懂。這裡統一在縮寫
// 前面加上白話說明當作主要標籤，縮寫放在括號裡當補充，滑鼠移上去（title）還有更
// 完整的一句話解釋，兩個地方（廣告文案卡片、效益驗證矩陣）共用同一份定義，才不會
// 兩處措辭不一致。
const METRIC_INFO = {
  ctr: { label: '點閱率', hint: '每 100 次曝光有幾次被點擊，數字越高代表廣告內容越吸引人點進去看。' },
  cpa: { label: '單次轉換成本', hint: '平均每達成一次轉換（例如一筆訂單）要花多少廣告費，數字越低越划算。' },
  cvr: { label: '轉換率', hint: '點進廣告的人裡面，有多少比例最後真的完成轉換，數字越高代表文案／頁面越有說服力。' },
  roas: { label: '廣告投報率', hint: '每花 1 元廣告費賺回幾元，數字大於 1 代表這則廣告是賺錢的。' },
};
function metricSpan(key, valueHtml, prefix) {
  const info = METRIC_INFO[key];
  const label = (prefix || '') + info.label;
  return `<span title="${esc(info.hint)}">${esc(label)}（${key.toUpperCase()}） <span class="num">${valueHtml}</span></span>`;
}

function adCopyTagsHtml(tags) {
  if (!tags) return '<p class="muted" style="margin-top:8px">AI 標籤化進行中或尚未完成，稍後重新整理清單查看。</p>';
  const secondary = (tags.secondary_pain_tags || []).map(t => `<span class="label-chip" style="cursor:default">${esc(t)}</span>`).join('');
  return `
    <div class="label-chips" style="margin-top:8px">
      <span class="label-chip" style="cursor:default;font-weight:600">${esc(tags.primary_pain_tag)}</span>
      ${secondary}
    </div>
    <p class="pain-meta" style="margin-top:8px">結構：${esc((tags.structure_blocks || []).join(' → ') || '—')}｜開頭手法：${esc(tags.hook_type || '—')}｜情緒：${esc(tags.emotion_tag || '—')}</p>
    ${tags.target_audience_guess ? `<p class="muted" style="margin-top:2px">推測受眾：${esc(tags.target_audience_guess)}</p>` : ''}
  `;
}

function adCopyPerfHtml(perf) {
  if (!perf) return '<p class="muted" style="margin-top:8px">尚無成效數據，可在上方表單、CSV 或 Meta 同步中回灌。</p>';
  return `<div class="pain-meta" style="margin-top:8px">
    <span>花費 <span class="num">${perf.spend ?? '—'}</span></span>
    <span>曝光 <span class="num">${perf.impressions ?? '—'}</span></span>
    <span>點擊 <span class="num">${perf.clicks ?? '—'}</span></span>
    ${metricSpan('ctr', pctLabel(perf.ctr))}
    ${metricSpan('cpa', perf.cpa ?? '—')}
    ${metricSpan('cvr', pctLabel(perf.cvr))}
    ${perf.roas != null ? metricSpan('roas', perf.roas) : ''}
  </div>`;
}

function adCopyCardHtml(c) {
  const perf = Array.isArray(c.performance) ? c.performance[0] : c.performance;
  const preview = c.raw_content.length > 140 ? c.raw_content.slice(0, 140) + '…' : c.raw_content;
  const status_ = c.tagging_error ? 'rejected' : (c.ai_tags ? 'confirmed' : 'unreviewed');
  const statusLabel = c.tagging_error ? '標籤化失敗' : (c.ai_tags ? '已標籤' : '處理中');
  return `<article class="pain-card" data-id="${esc(c.id)}">
    <div class="pain-card-top">
      <div><h3 style="font-size:15px">${esc(preview)}</h3></div>
      <span class="stamp ${status_}">${statusLabel}</span>
    </div>
    ${adCopyTagsHtml(c.ai_tags)}
    ${c.tagging_error ? `<p class="muted" style="margin-top:6px">${esc(c.tagging_error)}</p>` : ''}
    ${adCopyPerfHtml(perf)}
    <div class="pain-actions" style="margin-top:10px">
      <button type="button" class="small danger ghost ad-copy-delete">刪除</button>
    </div>
  </article>`;
}

function renderAdCopyList() {
  const list = $('#ad-copy-list');
  const countEl = $('#ad-copy-count');
  if (!list) return;
  if (countEl) countEl.textContent = adCopiesCache.length ? `共 ${adCopiesCache.length} 則廣告文案` : '';
  if (!adCopiesCache.length) { list.innerHTML = '<p class="muted">尚無已匯入的廣告文案。</p>'; return; }
  list.innerHTML = adCopiesCache.map(adCopyCardHtml).join('');
  list.querySelectorAll('.ad-copy-delete').forEach((btn, i) => {
    btn.onclick = async () => {
      const c = adCopiesCache[i];
      if (!confirm('確定要刪除這則廣告文案與其成效數據嗎？此操作無法復原。')) return;
      try {
        await api(`/api/ad-copies/${c.id}`, { method: 'DELETE' });
        await loadAdCopies();
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    };
  });
}

const adCopyForm = $('#ad-copy-form');
if (adCopyForm) {
  adCopyForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!currentProfileId) return;
    const data = Object.fromEntries(new FormData(e.target));
    // 投放版位改成可複選的 checkbox，FormData 的 fromEntries 對同名欄位只會留下最後一個值，
    // 所以要另外把所有勾選的 checkbox 收集起來，合併成逗號分隔的字串存進既有的 platform 欄位
    // （後端 schema 沒有改動，這裡不需要動 API）。
    const platforms = Array.from(e.target.querySelectorAll('input[name="platform"]:checked')).map(el => el.value);
    const hasPerf = data.spend || data.impressions || data.clicks || data.conversions;
    const body = {
      domain_profile_id: currentProfileId,
      platform: platforms.length ? platforms.join(',') : undefined,
      raw_content: data.raw_content,
      performance: hasPerf ? {
        spend: data.spend || undefined, impressions: data.impressions || undefined,
        clicks: data.clicks || undefined, conversions: data.conversions || undefined,
        source: 'manual',
      } : undefined,
    };
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    setStatus('正在處理廣告文案…');
    try {
      const result = await api('/api/ad-copies', { method: 'POST', body: JSON.stringify(body) });
      setStatus(result.reused_existing ? '這則文案先前已存在，已更新成效數據（未消耗 AI 額度）。' : '已加入文案庫並完成標籤化。');
      e.target.reset();
      await loadAdCopies();
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { btn.disabled = false; }
  });
}

// ── 廣告文案 CSV 批次匯入 ──────────────────────────────────────────────────
let adCsvHeaders = [];
let adCsvRows = [];

const adCsvFileInput = $('#ad-csv-file-input');
const adCsvMappingPanel = $('#ad-csv-mapping-panel');

if (adCsvFileInput && adCsvMappingPanel) {
  adCsvFileInput.addEventListener('change', async () => {
    const file = adCsvFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseCSV(text); // 沿用「語料匯入」區塊已經寫好的 CSV parser
      if (parsed.length < 2) throw new Error('這個檔案看起來沒有資料列（至少需要標題列 + 1 列資料）。');
      adCsvHeaders = parsed[0].map(h => h.trim()).filter(Boolean);
      adCsvRows = parsed.slice(1).map(r => Object.fromEntries(adCsvHeaders.map((h, i) => [h, (r[i] || '').trim()])));
      renderAdCsvMapping();
    } catch (err) {
      setStatus('⚠ CSV 解析失敗：' + err.message, true);
    }
  });
}

function adCsvColumnOptions(guess) {
  return '<option value="">— 不對應 —</option>' +
    adCsvHeaders.map(h => `<option value="${esc(h)}"${h === guess ? ' selected' : ''}>${esc(h)}</option>`).join('');
}

function renderAdCsvMapping() {
  const guess = re => adCsvHeaders.find(h => re.test(h)) || '';
  const guessTextCol = guess(/文案|內容|body|ad\s*text|creative/i) || adCsvHeaders[0];
  const guessAdIdCol = guess(/ad.?id|廣告\s*id/i);
  const guessSpendCol = guess(/花費|金額|spend|cost/i);
  const guessImpCol = guess(/曝光|impress/i);
  const guessClickCol = guess(/點擊|click/i);
  const guessConvCol = guess(/轉換|purchase|lead|conversion/i);

  adCsvMappingPanel.innerHTML = `
    <p class="muted" style="margin-top:14px">共讀到 <span class="num">${adCsvRows.length}</span> 列資料，請確認欄位對應：</p>
    <div class="grid">
      <label>文案內容欄位（必填）<select class="ad-csv-map" data-field="raw_content">${adCsvColumnOptions(guessTextCol)}</select></label>
      <label>Meta 廣告 ID（選填）<select class="ad-csv-map" data-field="meta_ad_id">${adCsvColumnOptions(guessAdIdCol)}</select></label>
    </div>
    <div class="grid">
      <label>花費欄位（選填）<select class="ad-csv-map" data-field="spend">${adCsvColumnOptions(guessSpendCol)}</select></label>
      <label>曝光欄位（選填）<select class="ad-csv-map" data-field="impressions">${adCsvColumnOptions(guessImpCol)}</select></label>
      <label>點擊欄位（選填）<select class="ad-csv-map" data-field="clicks">${adCsvColumnOptions(guessClickCol)}</select></label>
      <label>轉換欄位（選填）<select class="ad-csv-map" data-field="conversions">${adCsvColumnOptions(guessConvCol)}</select></label>
    </div>
    <p class="muted" style="margin:2px 0 12px">同一份文案的內容若跟文案庫裡已有的一字不差，會直接更新成效、不會重複呼叫 AI。</p>
    <button type="button" id="ad-csv-import-confirm" class="secondary" style="margin-top:4px">確認匯入這 ${adCsvRows.length} 筆</button>
  `;
  $('#ad-csv-import-confirm').onclick = submitAdCsvImport;
}

function currentAdCsvMapping() {
  const map = {};
  adCsvMappingPanel.querySelectorAll('.ad-csv-map').forEach(sel => { map[sel.dataset.field] = sel.value; });
  return map;
}

async function submitAdCsvImport() {
  if (!currentProfileId) return;
  const map = currentAdCsvMapping();
  if (!map.raw_content) return setStatus('⚠ 請先指定「文案內容欄位」。', true);

  const hasPerfCols = map.spend || map.impressions || map.clicks || map.conversions;
  const items = adCsvRows.map(r => ({
    raw_content: r[map.raw_content] || '',
    meta_ad_id: map.meta_ad_id ? r[map.meta_ad_id] : undefined,
    performance: hasPerfCols ? {
      spend: map.spend ? r[map.spend] : undefined,
      impressions: map.impressions ? r[map.impressions] : undefined,
      clicks: map.clicks ? r[map.clicks] : undefined,
      conversions: map.conversions ? r[map.conversions] : undefined,
      source: 'csv',
    } : undefined,
  })).filter(it => it.raw_content && it.raw_content.trim());

  if (!items.length) return setStatus('⚠ 沒有可匯入的資料列（文案內容欄位可能是空的）。', true);

  const btn = $('#ad-csv-import-confirm');
  if (btn) btn.disabled = true;
  setStatus(`正在匯入 ${items.length} 筆廣告文案…`);
  try {
    const CHUNK_SIZE = 200;
    let created = 0, reused = 0, aiCalls = 0;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const result = await api('/api/ad-copies/batch-import', {
        method: 'POST',
        body: JSON.stringify({ domain_profile_id: currentProfileId, items: chunk }),
      });
      created += result.created; reused += result.reused; aiCalls += result.ai_calls;
    }
    setStatus(`已匯入：${created} 筆新文案（呼叫 AI ${aiCalls} 次）、${reused} 筆已存在僅更新成效。`);
    adCsvRows = []; adCsvHeaders = [];
    adCsvMappingPanel.innerHTML = '';
    if (adCsvFileInput) adCsvFileInput.value = '';
    await loadAdCopies();
  } catch (err) {
    setStatus('⚠ ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Meta Graph API 同步 ──────────────────────────────────────────────────
const metaSyncForm = $('#meta-sync-form');
if (metaSyncForm) {
  metaSyncForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!currentProfileId) return;
    const data = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    setStatus('正在向 Meta Graph API 同步廣告洞察報告與素材，可能需要一些時間…');
    try {
      const result = await api('/api/ad-copies/meta-sync', {
        method: 'POST',
        body: JSON.stringify({ domain_profile_id: currentProfileId, ...data }),
      });
      setStatus(result.message || `同步完成，共處理 ${result.total} 則廣告。`);
      e.target.querySelector('input[name="access_token"]').value = ''; // 用完即清，不殘留在畫面上
      await loadAdCopies();
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { btn.disabled = false; }
  });
}

// ── 效益驗證矩陣：痛點轉換矩陣 ＋ 高 CTR 結構模板 ──────────────────────────────
function matrixRowHtml(title, subtitle, row) {
  const pct = row.weighted_ctr != null ? Math.min(Math.round(row.weighted_ctr * 10000) / 100, 100) : 0;
  return `<article class="report-row${row.low_confidence ? ' low-confidence' : ''}">
    <div class="report-row-top">
      <div><h4>${esc(title)}</h4>${subtitle ? `<p class="deep-desire">${esc(subtitle)}</p>` : ''}</div>
      <span class="stamp ${row.low_confidence ? 'unreviewed' : 'confirmed'}">${row.low_confidence ? '樣本數過少' : `樣本 ${row.sample_size} 則`}</span>
    </div>
    <div class="confidence-bar"><div class="confidence-bar-fill" style="width:${pct}%"></div></div>
    <div class="pain-meta">
      ${metricSpan('ctr', pctLabel(row.weighted_ctr), '加權')}
      ${metricSpan('cpa', row.weighted_cpa ?? '—', '加權')}
      ${metricSpan('cvr', pctLabel(row.weighted_cvr), '加權')}
      ${row.weighted_roas != null ? metricSpan('roas', row.weighted_roas, '加權') : ''}
      <span>總花費 <span class="num">${row.total_spend ?? '—'}</span></span>
    </div>
  </article>`;
}

function renderMatrix(result) {
  const container = $('#matrix-result');
  if (!container) return;
  const report = result.report || result;
  if (!report.based_on_ad_copies) {
    container.innerHTML = '<p class="muted">目前還沒有「已標籤化且已回灌成效數據」的廣告文案，請先匯入文案並附上花費／曝光／點擊等數據。</p>';
    return;
  }
  const painRows = (report.pain_point_matrix || []).map(r => matrixRowHtml(r.pain_tag, null, r)).join('');
  const structRows = (report.high_ctr_structure_templates || [])
    .map(r => matrixRowHtml(`${r.hook_type || '未分類'} 開頭`, (r.structure_blocks || []).join(' → '), r)).join('');

  container.innerHTML = `
    ${report.note ? `<p class="muted" style="margin-bottom:14px">${esc(report.note)}</p>` : ''}
    <p class="muted" style="margin-bottom:10px">依據 ${report.based_on_ad_copies} 則有成效數據的廣告文案（文案庫共 ${report.total_tagged_ad_copies} 則）計算，按加權點閱率（CTR）由高到低排序。</p>
    <h3 style="margin:16px 0 8px">痛點轉換矩陣</h3>
    <div class="r-breakdown">${painRows || '<p class="muted">尚無資料。</p>'}</div>
    <h3 style="margin:20px 0 8px">高點閱率結構模板</h3>
    <div class="r-breakdown">${structRows || '<p class="muted">尚無資料。</p>'}</div>
  `;
}

const buildMatrixBtn = $('#build-matrix-btn');
if (buildMatrixBtn) {
  buildMatrixBtn.onclick = async () => {
    if (!currentProfileId) return;
    buildMatrixBtn.disabled = true;
    const original = buildMatrixBtn.textContent;
    buildMatrixBtn.textContent = '計算中…';
    try {
      const result = await api(`/api/ad-copies/matrix?domain_profile_id=${currentProfileId}`, { method: 'POST' });
      renderMatrix(result);
      setStatus('已產出效益驗證矩陣。');
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { buildMatrixBtn.disabled = false; buildMatrixBtn.textContent = original; }
  };
}

// 帳號角落元件（身份確認收合）與帳號設定 modal 已搬到獨立的 account-corner.js
// （比 app.js 更早載入），避免這支檔案裡任何不相關的錯誤把角落的登入狀態顯示拖垮。
// 詳見 account-corner.js 開頭的說明註解。

// ---------------- 初始化 ----------------

async function init() {
  await loadProfiles();
  loadSwipes();
}
if (window.authReady) window.authReady.then(init); else init();
