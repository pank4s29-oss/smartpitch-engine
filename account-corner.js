(function () {
  // ---------------- 帳號角落元件（身份確認收合） ----------------
  // 顯示名稱／登入狀態完全由 auth.js 透過 'auth:change' 自訂事件廣播，這裡只負責
  // 收合面板的展開/收起，以及把事件內容顯示在角落的小標籤上，不用再靠猜測
  // #auth-status 文字內容或 MutationObserver 反推狀態。
  //
  // 修正重點：這段邏輯原本寫在 app.js 最尾端（近 1900 行處）。app.js 是一支沒有
  // 用 try/catch 包起來的單一 script，只要檔案裡任何一行（不論多不相關）在執行到
  // 這段之前丟出 runtime error，整支 script 就會停在那一行，後面「角落標籤要怎麼
  // 顯示」的程式碼永遠不會被註冊——角落因此會卡在初始狀態，看起來就像「使用者名稱
  // 完全空白沒有顯示」。
  // 把這段獨立成一支不依賴 app.js 其他變數的小 script，並且比 app.js 更早載入/
  // 執行，之後就算 app.js 其他地方又出新的 bug，也不會拖累角落的登入狀態顯示。

  const qs = sel => document.querySelector(sel);

  const cornerToggle = qs('#account-corner-toggle');
  const cornerPanel = qs('#account-corner-panel');
  if (cornerToggle && cornerPanel) {
    cornerToggle.onclick = () => { cornerPanel.hidden = !cornerPanel.hidden; };
    document.addEventListener('click', e => {
      if (!cornerPanel.hidden && !e.target.closest('#account-corner')) cornerPanel.hidden = true;
    });
  }

  // 記住最後一次 auth:change 廣播的內容，「帳號設定」modal 開啟時直接拿來預填，
  // 不用另外再問 auth.js 要一次目前的登入狀態。
  let latestAuthDetail = null;

  function updateCornerLabel(detail) {
    latestAuthDetail = detail;
    const cornerLabel = qs('#account-corner-label');
    const dot = qs('.account-corner-dot');
    const settingsBtn = qs('#account-settings-btn');
    if (!cornerLabel) return;
    if (!detail || !detail.loggedIn) {
      cornerLabel.textContent = '尚未登入';
      if (dot) dot.style.background = 'var(--muted, #9aa0a6)';
      if (settingsBtn) settingsBtn.hidden = true;
      return;
    }
    const label = detail.displayName || detail.email || '已登入';
    cornerLabel.textContent = label.length > 14 ? label.slice(0, 14) + '…' : label;
    if (dot) dot.style.background = '#2f7a3d';
    if (settingsBtn) settingsBtn.hidden = false;
  }

  // 保險：萬一這支 script 是在 auth.js 已經廣播過第一次 auth:change 之後才掛上
  // 監聽器（理論上不會，因為 auth.js 內部都是 await 過網路請求才廣播，一定比這支
  // 同步執行完的 script 慢），仍然把目前畫面上的狀態當作初始值渲染一次，不留空窗。
  updateCornerLabel(null);

  window.addEventListener('auth:change', e => {
    updateCornerLabel(e.detail);
    // 剛登入/註冊成功就自動收合面板，不用使用者自己再點一次關掉。
    if (e.detail && e.detail.loggedIn && cornerPanel) cornerPanel.hidden = true;
    // 登出後若帳號設定 modal 還開著，一併關掉，避免顯示已經失效的資料。
    if (!e.detail || !e.detail.loggedIn) closeAccountSettings();
  });

  // ---------------- 帳號設定 modal ----------------
  // 獨立於登入面板之外：登入後才會在使用者名稱旁邊出現一顆「⚙」按鈕，點下去開啟這個
  // modal，專門用來看帳號資訊、修改顯示名稱，跟「登入/註冊」的表單分開，減少混淆。

  const accountSettingsBtn = qs('#account-settings-btn');
  const accountSettingsOverlay = qs('#account-settings-overlay');
  const accountSettingsNameInput = qs('#account-settings-name-input');
  const accountSettingsEmailEl = qs('#account-settings-email');
  const accountSettingsSaveBtn = qs('#account-settings-save');
  const accountSettingsCloseBtn = qs('#account-settings-close');
  const accountSettingsSignoutBtn = qs('#account-settings-signout');

  function openAccountSettings() {
    if (!accountSettingsOverlay) return;
    if (cornerPanel) cornerPanel.hidden = true;
    if (accountSettingsEmailEl) {
      accountSettingsEmailEl.textContent = latestAuthDetail && latestAuthDetail.email
        ? `登入信箱：${latestAuthDetail.email}` : '';
    }
    if (accountSettingsNameInput) accountSettingsNameInput.value = (latestAuthDetail && latestAuthDetail.displayName) || '';
    accountSettingsOverlay.hidden = false;
  }
  function closeAccountSettings() {
    if (accountSettingsOverlay) accountSettingsOverlay.hidden = true;
  }

  // 統一經由這裡呼叫，若 app.js 尚未載入完成（理論上不會發生，因為使用者要點得到
  // 這些按鈕，代表整頁 script 早就跑完了），就靜默略過畫面提示，不讓例外往外丟。
  function reportStatus(msg, isError) {
    if (typeof window.setStatus === 'function') window.setStatus(msg, isError);
  }

  if (accountSettingsBtn) accountSettingsBtn.onclick = openAccountSettings;
  if (accountSettingsCloseBtn) accountSettingsCloseBtn.onclick = closeAccountSettings;
  if (accountSettingsOverlay) {
    accountSettingsOverlay.addEventListener('click', e => { if (e.target === accountSettingsOverlay) closeAccountSettings(); });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && accountSettingsOverlay && !accountSettingsOverlay.hidden) closeAccountSettings();
  });

  if (accountSettingsSaveBtn) {
    accountSettingsSaveBtn.onclick = async () => {
      const name = (accountSettingsNameInput.value || '').trim();
      if (!name) { reportStatus('⚠ 請輸入顯示名稱。', true); return; }
      accountSettingsSaveBtn.disabled = true;
      try {
        await window.updateDisplayName(name);
        reportStatus('已更新顯示名稱。');
      } catch (err) { reportStatus('⚠ ' + err.message, true); }
      finally { accountSettingsSaveBtn.disabled = false; }
    };
  }
  if (accountSettingsSignoutBtn) {
    accountSettingsSignoutBtn.onclick = async () => {
      accountSettingsSignoutBtn.disabled = true;
      try { await window.signOut(); closeAccountSettings(); }
      catch (err) { reportStatus('⚠ ' + err.message, true); }
      finally { accountSettingsSignoutBtn.disabled = false; }
    };
  }
})();
