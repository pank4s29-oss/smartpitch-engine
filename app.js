const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const status = $('#status') || (() => { const el = document.createElement('section'); el.id = 'status'; el.setAttribute('aria-live', 'polite'); document.querySelector('main.page-container').before(el); return el; })();

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
// 舊資料若沒有 product_name（理論上不會發生，但保底），退回原本的 domain_tag／audiences 格式。
const audiencesOf = p => Array.isArray(p && p.audiences) ? p.audiences : (p && p.audience ? [p.audience] : []);
const profileLabel = p => (p && p.product_name) ? `${p.product_name}／${p.domain_tag}` : `${p.domain_tag}／${audiencesOf(p).join('、')}`;

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

// ---------------- 目標受眾（多選標籤）----------------
// 比照語料來源分類的標籤新增/刪除互動，但這裡的值只存在單一產品/服務設定的
// audiences 陣列裡，不需要像 feedback_source_labels 那樣獨立一張表跨頁面共用。
let profileAudienceTags = [];

function renderProfileAudienceChips() {
  const chips = $('#profile-audience-chips');
  if (!chips) return;
  chips.innerHTML = profileAudienceTags.map((a, i) => `
    <span class="label-chip" data-i="${i}">${esc(a)} <button type="button" title="移除受眾" aria-label="移除受眾">×</button></span>
  `).join('');
  chips.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      profileAudienceTags.splice(Number(btn.closest('.label-chip').dataset.i), 1);
      renderProfileAudienceChips();
    };
  });
}

function addProfileAudienceTag() {
  const input = $('#profile-audience-input');
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  if (profileAudienceTags.some(a => a.toLowerCase() === value.toLowerCase())) { input.value = ''; return; }
  profileAudienceTags.push(value);
  input.value = '';
  renderProfileAudienceChips();
}

const profileAudienceAddBtn = $('#profile-audience-add');
if (profileAudienceAddBtn) profileAudienceAddBtn.onclick = addProfileAudienceTag;
const profileAudienceInput = $('#profile-audience-input');
if (profileAudienceInput) {
  profileAudienceInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addProfileAudienceTag(); }
  });
}

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
    profileAudienceTags = [...audiencesOf(profile)];
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
    profileAudienceTags = [];
    submitBtn.textContent = '建立產品／服務設定';
  }
  renderProfileAudienceChips();
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
  profileAudienceTags = [];
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
  // 目標受眾改成多選標籤，不是原生表單欄位，直接從標籤狀態組成陣列送出。
  data.audiences = [...profileAudienceTags];
  if (!data.audiences.length) { setStatus('⚠ 請至少新增一個目標受眾。', true); return; }
  try {
    if (editingProfileId) {
      const updated = await api(`/api/domain-profiles?id=${editingProfileId}`, { method: 'PATCH', body: JSON.stringify(data) });
      setStatus('已更新產品/服務設定。');
      e.target.hidden = true;
      editingProfileId = null;
      profileAudienceTags = [];
      e.target.classList.remove('editing');
      await loadProfiles(updated.id);
      onProfileSelected(updated.id);
      return;
    }
    const profile = await api('/api/domain-profiles', { method: 'POST', body: JSON.stringify(data) });
    setStatus('已建立產品/服務設定。');
    e.target.reset();
    profileAudienceTags = [];
    e.target.hidden = true;
    await loadProfiles(profile.id);
    onProfileSelected(profile.id);
  } catch (err) {
    if (err.duplicate && err.existing_id) {
      if (confirm(`${err.message}\n是否改用既有的「${err.existing_label}」？`)) {
        e.target.reset();
        profileAudienceTags = [];
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
  // 原本是把「語料與痛點／潛在受眾／報告／廣告效益」四個區塊包在同一個 #profile-scope
  // 容器裡整個 hidden 掉；改成左側功能列各自獨立頁面之後，這四個區塊分散在不同頁面，
  // 改用 body 的 class 統一控制「尚未選擇產品/服務設定」時，各頁面顯示提示文字、
  // 隱藏底下需要 currentProfileId 才有意義的內容（見 style.css 的 .requires-profile 規則）。
  document.body.classList.toggle('no-profile-selected', !id);
  if (!id) return;
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
  // loadPainPoints() 先跑完，是因為潛在受眾地圖的卡片要顯示「對應哪些痛點」的標籤，
  // 需要 painPointsCache 已經有資料才能對得上，不能跟 loadSegments() 同時搶著跑。
  await loadPainPoints();
  await Promise.all([loadSourceLabels(), loadFeedback(), loadAdCopies(), loadSegments()]);
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
    // 編輯語料內容本身（修正錯字/漏字），跟痛點卡片的編輯是同一種「點擊展開表單」互動模式，
    // 沿用 .pc-edit-form 的樣式（見 style.css），維持整站編輯 UI 的一致性。
    const editBtn = node.querySelector('.fb-edit');
    const editForm = node.querySelector('.fb-edit-form');
    editBtn.onclick = () => {
      editForm.querySelector('.edit-raw_text').value = f.raw_text;
      editForm.hidden = false;
    };
    editForm.querySelector('.fb-edit-cancel').onclick = () => { editForm.hidden = true; };
    editForm.addEventListener('submit', async e => {
      e.preventDefault();
      const raw_text = editForm.querySelector('.edit-raw_text').value.trim();
      if (!raw_text) return;
      const btn = editForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api(`/api/raw-feedback/${f.id}`, { method: 'PATCH', body: JSON.stringify({ raw_text }) });
        setStatus('已更新語料內容。');
        await loadFeedback();
      } catch (err) {
        setStatus('⚠ ' + err.message, true);
        btn.disabled = false;
      }
    });
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

  const quoteEl = node.querySelector('.pc-quote');

  // 完整陳述（detail）：之前萃取/建議時就已經寫入資料庫，但畫面上一直沒有顯示出來，
  // 只看得到一句話的表層問題／深層渴望，訊息量不夠。這裡補上，讓使用者不用再腦補情境。
  if (p.detail) {
    const detailEl = document.createElement('p');
    detailEl.className = 'pain-detail';
    detailEl.textContent = p.detail;
    node.querySelector('.pc-quote').after(detailEl);
  }

  const sourceEl = node.querySelector('.pc-source');
  if (sourceEl) sourceEl.textContent = SOURCE_LABEL[p.source] || p.source || '—';

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

// ---------------- 手動新增痛點：圖片辨識輔助 ----------------
// 上傳一張截圖，AI 直接看圖分析出一組痛點草稿，帶入手動新增表單讓使用者檢視/修改後
// 再自行按「手動新增一筆」送出——不直接寫入資料庫，理由與 AI 建議草稿（suggest）一致。
const painImageInput = $('#pain-image-input');
const painImagePreview = $('#pain-image-preview');
const painImageSubmitBtn = $('#pain-image-submit');
const painImageStatus = $('#pain-image-status');

if (painImageInput) {
  painImageInput.addEventListener('change', () => {
    renderImagePreview(painImagePreview, painImageInput.files);
    if (painImageSubmitBtn) painImageSubmitBtn.disabled = !painImageInput.files.length;
  });
}

if (painImageSubmitBtn) {
  painImageSubmitBtn.onclick = async () => {
    if (!currentProfileId) { painImageStatus.textContent = '⚠ 請先選擇產品/服務設定。'; return; }
    const file = painImageInput && painImageInput.files && painImageInput.files[0];
    if (!file) return;
    painImageSubmitBtn.disabled = true;
    painImageStatus.textContent = '正在辨識圖片並分析痛點…';
    try {
      const image = await fileToImagePayload(file);
      const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points?action=analyze-image`, {
        method: 'POST',
        body: JSON.stringify({ image }),
      });
      const form = $('#manual-pain-form');
      form.surface_problem.value = result.surface_problem || '';
      form.deep_desire.value = result.deep_desire || '';
      form.detail.value = result.detail || '';
      painImageStatus.textContent = result.surface_problem
        ? '已帶入草稿，請檢視／修改後按下方「手動新增一筆」送出。'
        : '這張圖片沒有看出明確的受眾痛點，可以換一張截圖，或直接手動填寫。';
      painImageInput.value = '';
      painImagePreview.innerHTML = '';
    } catch (err) {
      painImageStatus.textContent = '⚠ ' + err.message;
    } finally {
      painImageSubmitBtn.disabled = !(painImageInput && painImageInput.files && painImageInput.files.length);
    }
  };
}

// ---------------- 潛在受眾地圖 ----------------
// 從目前已通過複核（未被駁回）的痛點反推：這些痛點背後可能對應到哪些沒被明講、
// 但真實存在的細分受眾族群。每個族群卡片列出「這個族群是誰」以及「對應到哪些痛點」，
// 讓使用者可以清楚看到痛點與受眾之間的對應關係，而不只是一份扁平的痛點清單。
//
// 分析結果會存進 audience_segments 資料表（比照痛點的做法），所以這裡分兩條路徑：
//   loadSegments()     單純讀取目前已存在的族群清單，不呼叫 AI（頁面載入、編輯/刪除後都走這條）
//   segmentsBtn.onclick 觸發一次新的 AI 分析，新產生的族群會併入既有清單（重複的族群名稱不重複寫入）

const SEGMENTS_PLACEHOLDER = '<p class="muted">尚未分析。點擊「分析潛在受眾」，系統會根據目前的痛點清單（已駁回者不計入）反推可能的受眾族群。</p>';

let segmentsCache = [];

function resetSegmentsPanel() {
  segmentsCache = [];
  const el = $('#segments-result');
  if (el) el.innerHTML = SEGMENTS_PLACEHOLDER;
}

async function loadSegments() {
  if (!currentProfileId) return;
  try {
    const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/segments`);
    renderSegmentsList(result.segments || []);
  } catch (e) { setStatus('⚠ ' + e.message, true); }
}

function segmentCardHtml(seg) {
  const painMap = new Map(painPointsCache.map(p => [p.id, p]));
  const matchedIds = Array.isArray(seg.matched_pain_point_ids) ? seg.matched_pain_point_ids : [];
  const chips = matchedIds.map(id => {
    const p = painMap.get(id);
    return p ? `<span class="label-chip" style="cursor:default">${esc(p.surface_problem)}</span>` : '';
  }).join('');
  const formats = Array.isArray(seg.suggested_formats) ? seg.suggested_formats : [];

  return `<article class="pain-card" data-id="${esc(seg.id)}">
    <div class="pain-card-top">
      <div><h3 class="seg-name-display">${esc(seg.segment_name)}</h3><p class="deep-desire seg-desc-display">${esc(seg.description)}</p></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        ${seg.status === 'edited' ? '<span class="stamp edited">已編輯</span>' : ''}
        <span class="stamp confirmed">對應 <span class="num">${matchedIds.length}</span> 個痛點</span>
      </div>
    </div>
    ${seg.rationale ? `<div class="pain-quote seg-rationale-display">${esc(seg.rationale)}</div>` : ''}
    ${seg.differentiation ? `<div class="segment-differentiation seg-diff-display"><b>與目標受眾的差異：</b>${esc(seg.differentiation)}</div>` : ''}
    ${formats.length ? `
    <div class="pain-meta" style="margin-top:12px">適合賣給這個族群的數位資產形式：</div>
    <div class="framework-box" style="margin-top:8px">${formats.map(f =>
      `<div style="margin-bottom:6px"><b>${esc(f.format)}</b>${f.reason ? ' — ' + esc(f.reason) : ''}</div>`
    ).join('')}</div>` : ''}
    <div class="pain-meta" style="margin-top:12px">這個族群特別在意的痛點：</div>
    <div class="label-chips" style="margin-top:8px">${chips || '<span class="muted">（無對應痛點，可能是原本對應的痛點已被刪除）</span>'}</div>
    <div class="pain-actions" style="margin-top:12px">
      <button type="button" class="small ghost seg-edit">編輯</button>
      <button type="button" class="small danger ghost seg-delete">刪除</button>
    </div>
    <form class="seg-edit-form pc-edit-form" hidden>
      <label>族群名稱<input class="edit-segment_name" value="${esc(seg.segment_name)}" required></label>
      <label>族群描述<textarea class="edit-description">${esc(seg.description || '')}</textarea></label>
      <label>為什麼這些痛點特別打中他們（選填）<textarea class="edit-rationale">${esc(seg.rationale || '')}</textarea></label>
      <label>與目標受眾的差異（選填）<textarea class="edit-differentiation">${esc(seg.differentiation || '')}</textarea></label>
      <p class="muted" style="margin:4px 0 0">對應的痛點與建議的數位資產形式不透過這裡修改；要調整對應痛點，請到「語料與痛點」頁面調整痛點本身。</p>
      <div class="pain-actions">
        <button type="submit" class="small">儲存修改</button>
        <button type="button" class="small ghost seg-edit-cancel">取消</button>
      </div>
    </form>
  </article>`;
}

function wireSegmentCardEvents(container) {
  container.querySelectorAll('.pain-card[data-id]').forEach(card => {
    const id = card.dataset.id;
    const editBtn = card.querySelector('.seg-edit');
    const deleteBtn = card.querySelector('.seg-delete');
    const form = card.querySelector('.seg-edit-form');

    if (editBtn && form) {
      editBtn.onclick = () => { form.hidden = false; };
      form.querySelector('.seg-edit-cancel').onclick = () => { form.hidden = true; };
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        const body = {
          segment_id: id,
          segment_name: form.querySelector('.edit-segment_name').value.trim(),
          description: form.querySelector('.edit-description').value.trim(),
          rationale: form.querySelector('.edit-rationale').value.trim(),
          differentiation: form.querySelector('.edit-differentiation').value.trim(),
        };
        try {
          await api(`/api/domain-profiles/${currentProfileId}/pain-points/segments`, { method: 'PATCH', body: JSON.stringify(body) });
          setStatus('已更新這個受眾族群。');
          await loadSegments();
        } catch (err) {
          setStatus('⚠ ' + err.message, true);
          submitBtn.disabled = false;
        }
      });
    }

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        const seg = segmentsCache.find(s => s.id === id);
        if (!confirm(`確定要刪除「${(seg && seg.segment_name) || '這個'}」這個受眾族群嗎？此操作無法復原。`)) return;
        deleteBtn.disabled = true;
        try {
          await api(`/api/domain-profiles/${currentProfileId}/pain-points/segments`, { method: 'DELETE', body: JSON.stringify({ segment_id: id }) });
          await loadSegments();
        } catch (err) {
          setStatus('⚠ ' + err.message, true);
          deleteBtn.disabled = false;
        }
      };
    }
  });
}

function renderSegmentsList(segments, meta) {
  const container = $('#segments-result');
  if (!container) return;
  meta = meta || {};
  segmentsCache = segments || [];

  if (!segmentsCache.length) {
    container.innerHTML = `<p class="muted">${esc(meta.message || '尚無潛在受眾分析結果，點擊上方「分析潛在受眾」開始。')}</p>`;
    return;
  }

  const noteHtml = meta.note ? `<p class="muted" style="margin:0 0 14px">${esc(meta.note)}</p>` : '';
  container.innerHTML = noteHtml + segmentsCache.map(segmentCardHtml).join('');
  wireSegmentCardEvents(container);
}

const segmentsBtn = $('#segments-btn');
if (segmentsBtn) {
  segmentsBtn.onclick = async () => {
    if (!currentProfileId) return;
    segmentsBtn.disabled = true;
    setStatus('正在根據目前的痛點清單反推潛在受眾族群…');
    try {
      const result = await api(`/api/domain-profiles/${currentProfileId}/pain-points/segments`, { method: 'POST' });
      renderSegmentsList(result.segments || [], { note: result.note, message: result.message });
      if (result.segments && result.segments.length) {
        const parts = [];
        if (result.inserted_count) parts.push(`新增 ${result.inserted_count} 個`);
        if (result.skipped_duplicate_count) parts.push(`${result.skipped_duplicate_count} 個與既有族群重複已略過`);
        setStatus(
          `目前共 ${result.segments.length} 個潛在受眾族群${parts.length ? '（' + parts.join('，') + '）' : ''}${result.constraints_applied ? '，已套用呈現媒介限制：' + result.constraints_applied : ''}。`
        );
      } else {
        setStatus(result.message || '尚未反推出有區別度的受眾族群。');
      }
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { segmentsBtn.disabled = false; }
  };
}

// ---------------- 產出報告與匯出（現已併入「潛在受眾地圖」頁面，不再是獨立頁籤） ----------------
// 報告不再是另外呼叫 AI 產生、存成快照的獨立分析（AI 導讀／覆蓋率統計／風險提示／
// 語料佐證與置信度／廣告成效比對），而是直接把「受眾痛點列表」與「潛在受眾地圖」這兩份
// 系統本來就有、使用者已經在看的清單，原樣組成一份可離線保存或寄送客戶的報告。
// 拿掉語料佐證與置信度的理由：顧客／網友在語料裡提到什麼，本來就不等於「這個受眾一定
// 存在或一定被打動」，用一個百分比置信度包裝反而讓人誤以為是精準量化的證據；真正可信
// 的驗證方式是「Meta 廣告效益驗證」頁面裡的真實花費／點擊／轉換數據，那部分維持獨立。
//
// 因為不再存成快照，也就不需要「報告資料庫」／「歷史報告」——每次打開報告都是即時
// 讀取當下最新的痛點與受眾族群，跟畫面上其他頁面看到的資料保證一致，不會有版本落後
// 或對不上的問題。

let currentReportProfileId = null; // 記住目前報告畫面對應哪個產品/服務設定，供匯出 Word 使用

function reportPainPointCardHtml(p, index) {
  return `<article class="pain-card">
    <div class="pain-card-top">
      <div><h3>痛點 ${index + 1}：${esc(p.surface_problem)}</h3><p class="deep-desire">${esc(p.deep_desire)}</p></div>
    </div>
    ${p.detail ? `<p class="pain-detail">${esc(p.detail)}</p>` : ''}
  </article>`;
}

function reportSegmentCardHtml(seg, index, painMap) {
  const matchedIds = Array.isArray(seg.matched_pain_point_ids) ? seg.matched_pain_point_ids : [];
  const chips = matchedIds.map(id => {
    const p = painMap.get(id);
    return p ? `<span class="label-chip" style="cursor:default">${esc(p.surface_problem)}</span>` : '';
  }).join('');
  const formats = Array.isArray(seg.suggested_formats) ? seg.suggested_formats : [];
  return `<article class="pain-card">
    <div class="pain-card-top">
      <div><h3>受眾 ${index + 1}：${esc(seg.segment_name)}</h3><p class="deep-desire">${esc(seg.description || '')}</p></div>
    </div>
    ${seg.rationale ? `<div class="pain-quote">${esc(seg.rationale)}</div>` : ''}
    ${seg.differentiation ? `<div class="segment-differentiation"><b>與目標受眾的差異：</b>${esc(seg.differentiation)}</div>` : ''}
    ${formats.length ? `
    <div class="pain-meta" style="margin-top:12px">適合賣給這個族群的數位資產形式：</div>
    <div class="framework-box" style="margin-top:8px">${formats.map(f =>
      `<div style="margin-bottom:6px"><b>${esc(f.format)}</b>${f.reason ? ' — ' + esc(f.reason) : ''}</div>`
    ).join('')}</div>` : ''}
    ${chips ? `<div class="pain-meta" style="margin-top:12px">對應的痛點：</div><div class="label-chips" style="margin-top:8px">${chips}</div>` : ''}
  </article>`;
}

// 匯出結果：把目前這組產品/服務設定的痛點與潛在受眾下載成 Word 文件。跟一般 api() 不同，
// 這裡預期的回應是二進位檔案而不是 JSON，所以另外寫一個小工具函式處理，不硬塞進共用的 api()。
async function downloadReportDocx(profileId, btn) {
  if (!profileId) { setStatus('⚠ 請先選擇一組產品/服務設定。', true); return; }
  const originalText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
  try {
    const token = await window.getAccessToken();
    if (!token) throw new Error('請先登入後再操作。');
    const r = await fetch(`/api/insight-reports?profile_id=${encodeURIComponent(profileId)}&format=docx`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) {
      const text = await r.text();
      let msg = '匯出失敗';
      try { msg = JSON.parse(text).error || msg; } catch (e) { /* 非 JSON 錯誤內容，維持預設訊息 */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (signature[0] !== 0x50 || signature[1] !== 0x4B) {
      throw new Error('伺服器回傳的 Word 檔案格式不正確，請檢查部署環境與匯出套件。');
    }
    const disposition = r.headers.get('Content-Disposition') || '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const filename = match ? decodeURIComponent(match[1]) : `受眾報告_${profileId}.docx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('已下載 Word 文件。');
  } catch (err) {
    setStatus('⚠ ' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

function printReportPanel() {
  const source = document.querySelector('#report-result .report-panel');
  if (!source) return;
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    setStatus('⚠ 瀏覽器封鎖了列印視窗，請允許此網站開啟彈出視窗後再試。', true);
    return;
  }
  const report = source.cloneNode(true);
  report.querySelectorAll('.step-actions, button').forEach(node => node.remove());
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).map(node => {
    if (node.tagName.toLowerCase() === 'link') return `<link rel="stylesheet" href="${node.href}">`;
    return node.outerHTML;
  }).join('');
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>受眾分析報告</title>${styles}<style>
    @page { size: A4; margin: 14mm 13mm; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; background-color: #fff !important; color: #17231f !important; }
    body { font-family: Arial, "Microsoft JhengHei", "Noto Sans TC", sans-serif !important; color-adjust: economy !important; -webkit-print-color-adjust: economy !important; }
    .report-panel, .report-panel * { background: #fff !important; background-color: #fff !important; background-image: none !important; color: #17231f !important; }
    .report-panel { display: block !important; width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; }
    .report-panel .step-heading { display: flex !important; border-bottom: 2px solid #2f6f3e !important; padding-bottom: 12px !important; margin-bottom: 20px !important; }
    .report-panel .pain-card { break-inside: avoid; page-break-inside: avoid; border: 1px solid #c8d9d0 !important; margin: 0 0 12px !important; padding: 14px 16px !important; }
    .report-panel .deep-desire, .report-panel .muted { color: #4a554e !important; }
    .divider { margin: 22px 0 !important; }
  </style></head><body>${report.outerHTML}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    setTimeout(() => printWindow.close(), 500);
  }, 350);
}

function renderReport(data) {
  currentReportProfileId = currentProfileId;
  const container = $('#report-result');
  if (!container) return;

  const dp = data.domain_profile || {};
  const points = Array.isArray(data.pain_points) ? data.pain_points : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const painMap = new Map(points.map(p => [p.id, p]));

  container.innerHTML = `<div class="panel report-panel">
    <div class="step-heading">
      <b>&#9679;</b>
      <div><h2>受眾分析報告</h2>${dp.business_constraints_label ? `<p class="muted">呈現媒介限制：${esc(dp.business_constraints_label)}</p>` : ''}</div>
      <div class="step-actions">
        <button type="button" class="ghost small report-export-docx">匯出 Word 文件 →</button>
        <button type="button" class="ghost small report-print">列印／匯出 PDF</button>
      </div>
    </div>
    <h3>受眾痛點列表（共 ${points.length} 筆）</h3>
    ${points.length ? points.map(reportPainPointCardHtml).join('') : '<p class="muted">此產品/服務設定尚無痛點資料。</p>'}
    <hr class="divider">
    <h3>潛在受眾地圖（共 ${segments.length} 個族群）</h3>
    ${segments.length ? segments.map((s, i) => reportSegmentCardHtml(s, i, painMap)).join('') : '<p class="muted">此產品/服務設定尚無潛在受眾分析結果。</p>'}
  </div>`;
  container.hidden = false;

  container.querySelector('.report-print').onclick = printReportPanel;
  container.querySelector('.report-export-docx').onclick = e => downloadReportDocx(currentReportProfileId, e.currentTarget);

  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function generateReport(profileId) {
  const data = await api(`/api/insight-reports?profile_id=${encodeURIComponent(profileId)}`);
  renderReport(data);
  return data;
}

$('#generate-report-btn').onclick = async () => {
  if (!currentProfileId) return;
  const btn = $('#generate-report-btn');
  btn.disabled = true;
  setStatus('正在彙整目前的痛點與潛在受眾清單…');
  try {
    await generateReport(currentProfileId);
    setStatus('報告已整理完成。');
  } catch (err) { setStatus('⚠ ' + err.message, true); }
  finally { btn.disabled = false; }
};

// ---------------- 產業文案手法庫（維持原有功能，僅重新定位敘述） ----------------

// 歸類商品/服務：手法庫是跨產品/服務設定瀏覽的全域清單，這裡的下拉選單列出使用者
// 名下「所有」設定裡已建立的解決方案（不只是目前選取的那組設定），並用「產業／領域｜產品名稱」
// 標示清楚是哪一組，避免不同設定剛好取了相同產品名稱時搞混。
let productSolutionsCache = [];

function productSolutionLabel(s) {
  return `${s.domain_tag || '（未分類領域）'}｜${s.product_name}`;
}

async function loadProductSolutions() {
  try {
    productSolutionsCache = await api('/api/swipe-copies?action=solutions');
    renderProductSolutionSelects();
  } catch (e) { /* 選單載入失敗不影響手法庫主要功能，維持「不指定」即可 */ }
}

function renderProductSolutionSelects() {
  const options = productSolutionsCache.map(s => `<option value="${esc(s.id)}">${esc(productSolutionLabel(s))}</option>`).join('');
  [$('#swipe-product-select'), $('#swipe-image-product-select')].forEach(sel => {
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— 不指定 —</option>' + options;
    if (current && productSolutionsCache.some(s => s.id === current)) sel.value = current;
  });
  const filterSel = $('#swipe-filter-product');
  if (filterSel) {
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">全部商品／服務</option>' + options;
    if (current && productSolutionsCache.some(s => s.id === current)) filterSel.value = current;
  }
}

const swipeForm = $('#swipe-form'), swipeStatus = $('#swipe-status'), swipeList = $('#swipe-list');

swipeForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = swipeForm.querySelector('button[type="submit"]');
  // 這支會即時呼叫 AI 拆解文案結構，同樣要擋掉手滑連點造成的重複呼叫。
  if (submitBtn) submitBtn.disabled = true;
  swipeStatus.textContent = '正在分析受眾痛點與身份洞察…';
  try {
    const body = Object.fromEntries(new FormData(swipeForm));
    if (!body.domain_profile_id) delete body.domain_profile_id;
    const item = await api('/api/swipe-copies', { method: 'POST', body: JSON.stringify(body) });
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
      const productSelectEl = $('#swipe-image-product-select');
      const item = await api('/api/swipe-copies', {
        method: 'POST',
        body: JSON.stringify({
          image: payload,
          image_mode: (swipeImageMode && swipeImageMode.value) || 'ocr',
          source_url: (sourceUrlEl && sourceUrlEl.value) || undefined,
          industry_tag: (industryTagEl && industryTagEl.value) || undefined,
          domain_profile_id: (productSelectEl && productSelectEl.value) || undefined,
        }),
      });
      const painCount = Array.isArray(item.extracted_pain_points) ? item.extracted_pain_points.length : 0;
      swipeImageStatus.textContent = `已分類：${item.industry_tag}／${item.framework_tag}。萃取到 ${painCount} 組受眾痛點與身份洞察。`;
      swipeImageInput.value = '';
      swipeImagePreview.innerHTML = '';
      if (sourceUrlEl) sourceUrlEl.value = '';
      if (industryTagEl) industryTagEl.value = '';
      if (productSelectEl) productSelectEl.value = '';
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

  const solution = x.domain_profile_id ? productSolutionsCache.find(s => s.id === x.domain_profile_id) : null;
  const solutionTag = solution
    ? `<span class="label-chip" style="cursor:default">歸類：${esc(productSolutionLabel(solution))}</span>`
    : '';
  const productOptions = productSolutionsCache.map(s =>
    `<option value="${esc(s.id)}" ${x.domain_profile_id === s.id ? 'selected' : ''}>${esc(productSolutionLabel(s))}</option>`
  ).join('');

  return `<article class="pain-card">
    <strong>${esc(x.industry_tag)} · ${esc(x.framework_tag)}</strong><br>
    <span class="muted">${esc((x.emotion_tags || []).join('、'))}｜${esc((x.block_breakdown || []).join(' → '))}</span>
    ${solutionTag ? `<div class="label-chips" style="margin-top:6px">${solutionTag}</div>` : ''}
    <p>${esc(x.raw_content.slice(0, 140))}${x.raw_content.length > 140 ? '…' : ''}</p>
    ${insightHtml}
    <div class="pain-actions">
      <button data-id="${esc(x.id)}" class="small ghost reanalyze">重新分析</button>
      <button data-id="${esc(x.id)}" class="small ghost template-btn">填空模板</button>
      <button data-id="${esc(x.id)}" class="small ghost swipe-edit">編輯</button>
      <button data-id="${esc(x.id)}" class="small danger ghost delete">刪除</button>
    </div>
    <form class="swipe-edit-form pc-edit-form" data-id="${esc(x.id)}" hidden>
      <div class="grid">
        <label>產業／領域<input class="edit-industry_tag" value="${esc(x.industry_tag)}" required></label>
        <label>框架<input class="edit-framework_tag" value="${esc(x.framework_tag)}" required></label>
      </div>
      <label>歸類商品／服務（選填）<select class="edit-domain_profile_id"><option value="">— 不指定 —</option>${productOptions}</select></label>
      <label>文案原文<textarea class="edit-raw_content" required>${esc(x.raw_content)}</textarea></label>
      <p class="muted" style="margin:4px 0 0">修改原文後，填空模板快取會清空，下次點開需要重新產生一次。</p>
      <div class="pain-actions">
        <button type="submit" class="small">儲存修改</button>
        <button type="button" class="small ghost swipe-edit-cancel">取消</button>
      </div>
    </form>
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
const swipeFilterProduct = $('#swipe-filter-product');
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
  if (swipeFilterProduct && swipeFilterProduct.value) params.set('domain_profile_id', swipeFilterProduct.value);
  if (swipeFilterHasPain && swipeFilterHasPain.checked) params.set('has_pain_points', 'true');
  return params.toString();
}

[swipeFilterIndustry, swipeFilterFramework, swipeFilterAngle, swipeFilterProduct, swipeFilterHasPain].forEach(el => {
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
    if (swipeFilterProduct) swipeFilterProduct.value = '';
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
    // 編輯：修正 AI 判斷錯的產業/框架標籤，或原文本身有誤植的地方。後端沿用既有的
    // PUT /api/swipe-copies/:id（EDITABLE_FIELDS 早就支援這幾個欄位，只是先前沒有 UI）。
    swipeList.querySelectorAll('.swipe-edit').forEach(b => {
      const article = b.closest('.pain-card');
      const form = article.querySelector(`.swipe-edit-form[data-id="${b.dataset.id}"]`);
      b.onclick = () => { form.hidden = false; };
      form.querySelector('.swipe-edit-cancel').onclick = () => { form.hidden = true; };
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await api('/api/swipe-copies/' + b.dataset.id, {
            method: 'PUT',
            body: JSON.stringify({
              industry_tag: form.querySelector('.edit-industry_tag').value.trim(),
              framework_tag: form.querySelector('.edit-framework_tag').value.trim(),
              raw_content: form.querySelector('.edit-raw_content').value.trim(),
              domain_profile_id: form.querySelector('.edit-domain_profile_id').value || null,
            }),
          });
          setStatus('已更新範例文案。');
          await loadSwipes();
          loadSwipeFacets();
        } catch (err) {
          setStatus('⚠ ' + err.message, true);
          btn.disabled = false;
        }
      });
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

// 報告資料庫與快照功能已移除；報告僅由目前設定即時整理。

// 舊版洞察報告資料庫與快照操作已移除；報告由目前設定即時整理。

// ---------------- 投放版位（使用者自訂清單）----------------
// 比照語料來源分類的做法：使用者層級共用一份清單（不綁定單一產品/服務設定），
// 用於「加入廣告文案」表單的複選 checkbox，以及每則廣告文案編輯表單裡的版位選項。

let adPlacementsCache = [];

async function loadAdPlacements() {
  try {
    adPlacementsCache = await api('/api/ad-copies?action=placements');
    renderAdPlacementList();
  } catch (e) { /* 版位清單載入失敗不影響主要的廣告文案功能 */ }
}

function renderAdPlacementList() {
  const container = $('#ad-placement-list');
  if (!container) return;
  container.innerHTML = adPlacementsCache.map(p => `
    <span class="placement-choice">
      <label class="choice"><input type="checkbox" name="platform" value="${esc(p.value)}"> ${esc(p.label)}</label>
      <button type="button" class="placement-delete" data-id="${esc(p.id)}" title="刪除版位" aria-label="刪除版位">×</button>
    </span>
  `).join('');
  container.querySelectorAll('.placement-delete').forEach(btn => {
    btn.onclick = async () => {
      const p = adPlacementsCache.find(x => x.id === btn.dataset.id);
      if (!confirm(`刪除版位「${p ? p.label : ''}」？（已使用此版位的廣告文案不受影響）`)) return;
      try {
        await api(`/api/ad-copies?action=placements&id=${btn.dataset.id}`, { method: 'DELETE' });
        await loadAdPlacements();
      } catch (err) { setStatus('⚠ ' + err.message, true); }
    };
  });
}

const adPlacementAddBtn = $('#ad-placement-add');
const adPlacementInput = $('#ad-placement-input');
if (adPlacementAddBtn && adPlacementInput) {
  const submitPlacement = async () => {
    const label = adPlacementInput.value.trim();
    if (!label) return;
    adPlacementAddBtn.disabled = true;
    try {
      await api('/api/ad-copies?action=placements', { method: 'POST', body: JSON.stringify({ label }) });
      adPlacementInput.value = '';
      await loadAdPlacements();
    } catch (err) { setStatus('⚠ ' + err.message, true); }
    finally { adPlacementAddBtn.disabled = false; }
  };
  adPlacementAddBtn.onclick = submitPlacement;
  adPlacementInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPlacement(); } });
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
      <button type="button" class="small ghost ad-copy-edit">編輯</button>
      <button type="button" class="small danger ghost ad-copy-delete">刪除</button>
    </div>
    <form class="ad-copy-edit-form pc-edit-form" hidden>
      <div class="grid">
        <label>主打痛點標籤<input class="edit-primary_pain_tag" value="${esc((c.ai_tags && c.ai_tags.primary_pain_tag) || '')}" placeholder="例：沒時間運動" required></label>
        <label>次要痛點標籤（選填，最多 2 個，用逗號分隔）<input class="edit-secondary_pain_tags" value="${esc(((c.ai_tags && c.ai_tags.secondary_pain_tags) || []).join('、'))}" placeholder="例：怕踩雷、預算有限"></label>
      </div>
      <label>投放版位（可複選）
        <fieldset class="edit-platform-fieldset">
          ${adPlacementsCache.map(p => {
            const checked = (c.platform || '').split(',').map(s => s.trim()).includes(p.value);
            return `<label class="choice"><input type="checkbox" value="${esc(p.value)}" ${checked ? 'checked' : ''}> ${esc(p.label)}</label>`;
          }).join('')}
        </fieldset>
      </label>
      <p class="muted" style="margin:4px 0 0">文案原文與 hash 不可修改（若貼錯內容請直接刪除重新新增）；下方成效數據若留白則不會覆蓋既有數據。</p>
      <div class="grid">
        <label>花費<input class="edit-spend" type="number" step="0.01" placeholder="${perf && perf.spend != null ? perf.spend : '例：500'}"></label>
        <label>曝光數<input class="edit-impressions" type="number" placeholder="${perf && perf.impressions != null ? perf.impressions : '例：10000'}"></label>
      </div>
      <div class="grid">
        <label>點擊數<input class="edit-clicks" type="number" placeholder="${perf && perf.clicks != null ? perf.clicks : '例：300'}"></label>
        <label>轉換數<input class="edit-conversions" type="number" placeholder="${perf && perf.conversions != null ? perf.conversions : '例：12'}"></label>
      </div>
      <div class="pain-actions">
        <button type="submit" class="small">儲存修改</button>
        <button type="button" class="small ghost ad-copy-edit-cancel">取消</button>
      </div>
    </form>
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
  // 編輯：修正 AI 標籤化誤判的痛點標籤/投放版位，或手動回填成效數據，
  // 對應後端新增的 PATCH /api/ad-copies/:id。
  list.querySelectorAll('.ad-copy-edit').forEach((btn, i) => {
    const c = adCopiesCache[i];
    const article = btn.closest('.pain-card');
    const form = article.querySelector('.ad-copy-edit-form');
    btn.onclick = () => { form.hidden = false; };
    form.querySelector('.ad-copy-edit-cancel').onclick = () => { form.hidden = true; };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const platforms = Array.from(form.querySelectorAll('.edit-platform-fieldset input:checked')).map(el => el.value);
      const secondary = form.querySelector('.edit-secondary_pain_tags').value
        .split(/[、,，]/).map(s => s.trim()).filter(Boolean).slice(0, 2);
      const spend = form.querySelector('.edit-spend').value;
      const impressions = form.querySelector('.edit-impressions').value;
      const clicks = form.querySelector('.edit-clicks').value;
      const conversions = form.querySelector('.edit-conversions').value;
      const hasPerf = spend || impressions || clicks || conversions;
      const body = {
        platform: platforms.length ? platforms.join(',') : null,
        primary_pain_tag: form.querySelector('.edit-primary_pain_tag').value.trim(),
        secondary_pain_tags: secondary,
      };
      if (hasPerf) body.performance = { spend: spend || undefined, impressions: impressions || undefined, clicks: clicks || undefined, conversions: conversions || undefined };
      try {
        await api(`/api/ad-copies/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setStatus('已更新廣告文案。');
        await loadAdCopies();
      } catch (err) {
        setStatus('⚠ ' + err.message, true);
        submitBtn.disabled = false;
      }
    });
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
    setStatus('正在向 Meta Graph API 同步廣告成效與素材，可能需要一些時間…');
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

// ---------------- 總覽頁（Dashboard） ----------------
// 新增的「首頁」：橫向彙整目前帳號底下每一組產品/服務設定累積了多少痛點、
// 已產出幾份報告、追蹤了幾則廣告文案，讓使用者一眼看到目前進度，不用逐一點進
// 每組設定才看得到。純粹彙整既有 API 已經回傳的資料，不新增任何運算邏輯。
const priceTierLabel = p => (p.price_tier === 'low' ? '低單價／快速決策' : '高客單／建立信任');

// 帶著指定的產品/服務設定跳到某個功能頁面：從總覽頁的卡片點進去時使用。
function selectProfileAndGoTo(id, page) {
  const select = $('#profile-select');
  if (select) select.value = id;
  onProfileSelected(id);
  if (window.goToPage) window.goToPage(page);
}

async function dashboardProfileStats(profile) {
  const stats = { profile, painTotal: 0, painConfirmed: 0, adCopyCount: 0 };
  try {
    const points = await api(`/api/domain-profiles/${profile.id}/pain-points`);
    stats.painTotal = points.length;
    stats.painConfirmed = points.filter(p => p.review_status === 'confirmed' || p.review_status === 'edited').length;
  } catch (e) { /* 單組設定的痛點載入失敗不擋整個總覽頁 */ }
  try {
    const ads = await api(`/api/ad-copies?domain_profile_id=${profile.id}`);
    stats.adCopyCount = ads.length;
  } catch (e) { /* 同上，不擋整頁 */ }
  return stats;
}

function dashboardProfileCardHtml(s) {
  const p = s.profile;
  const confirmRatio = s.painTotal ? `${s.painConfirmed}／${s.painTotal}` : '0';
  return `<article class="dashboard-card" data-id="${esc(p.id)}">
    <div class="dashboard-card-head">
      <div>
        <h3>${esc(profileLabel(p))}</h3>
        <p class="muted">${esc(audiencesOf(p).join('、'))}｜${esc(priceTierLabel(p))}</p>
      </div>
    </div>
    <div class="dashboard-card-stats">
      <div class="dashboard-stat"><span class="num">${confirmRatio}</span><small>痛點（已確認／總數）</small></div>
      <div class="dashboard-stat"><span class="num">${s.adCopyCount}</span><small>追蹤中廣告文案</small></div>
    </div>
    <p class="muted dashboard-card-updated">報告會依目前痛點與潛在受眾地圖即時整理。</p>
    <div class="pain-actions">
      <button type="button" class="small secondary dc-feedback">語料與痛點 →</button>
      <button type="button" class="small ghost dc-report">產出分析報告</button>
      <button type="button" class="small ghost dc-edit">編輯設定</button>
    </div>
  </article>`;
}

async function renderDashboard() {
  const empty = $('#dashboard-empty');
  const statsEl = $('#dashboard-stats');
  const gridEl = $('#dashboard-profile-grid');
  if (!statsEl || !gridEl) return; // 頁面元素還沒渲染出來（理論上不會發生，防呆用）

  if (!profilesCache.length) {
    if (empty) empty.hidden = false;
    statsEl.hidden = true;
    gridEl.innerHTML = '';
    return;
  }
  if (empty) empty.hidden = true;
  statsEl.hidden = false;
  gridEl.innerHTML = '<p class="muted">正在彙整各產品/服務設定的統計資料…</p>';

  const allStats = await Promise.all(profilesCache.map(dashboardProfileStats));

  const totalPain = allStats.reduce((sum, s) => sum + s.painTotal, 0);
  const totalConfirmed = allStats.reduce((sum, s) => sum + s.painConfirmed, 0);
  const totalAdCopies = allStats.reduce((sum, s) => sum + s.adCopyCount, 0);
  statsEl.innerHTML = `
    <div class="dashboard-stat-card"><span class="num">${profilesCache.length}</span><small>產品／服務設定</small></div>
    <div class="dashboard-stat-card"><span class="num">${totalConfirmed}／${totalPain}</span><small>累積痛點（已確認／總數）</small></div>
    <div class="dashboard-stat-card"><span class="num">${totalAdCopies}</span><small>追蹤中廣告文案</small></div>
  `;

  gridEl.innerHTML = allStats.map(dashboardProfileCardHtml).join('');
  gridEl.querySelectorAll('.dashboard-card').forEach(card => {
    const id = card.dataset.id;
    const s = allStats.find(x => x.profile.id === id);
    card.querySelector('.dc-feedback').onclick = () => selectProfileAndGoTo(id, 'feedback');
    card.querySelector('.dc-edit').onclick = () => {
      selectProfileAndGoTo(id, 'profile');
      const profile = profilesCache.find(p => p.id === id);
      if (profile) setProfileFormMode('edit', profile);
    };
    const reportBtn = card.querySelector('.dc-report');
    if (reportBtn) {
      reportBtn.onclick = () => {
        selectProfileAndGoTo(id, 'segments');
        setTimeout(() => { const generateBtn = $('#generate-report-btn'); if (generateBtn) generateBtn.click(); }, 80);
      };
    }
  });
}

const dashboardNewProfileBtn = $('#dashboard-new-profile-btn');
if (dashboardNewProfileBtn) {
  dashboardNewProfileBtn.onclick = () => {
    if (window.goToPage) window.goToPage('profile');
    setProfileFormMode('create');
  };
}

async function init() {
  await loadProfiles();
  await loadProductSolutions();
  loadSwipes();
  loadAdPlacements();
  renderDashboard();
}
if (window.authReady) window.authReady.then(init); else init();
