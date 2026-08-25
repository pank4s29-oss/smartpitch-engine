(function () {
  // ---------------- 左側導航（側邊欄收合 ＋ 頁面切換） ----------------
  // 對應改版後的 index.html：左側 .sidebar 的 nav-item 對應右側 .page-container 底下
  // 各個 data-page 區塊。這支 script 只管「畫面上顯示哪一頁」與「側邊欄開合」，
  // 不碰任何業務邏輯——業務資料的載入/清空由 app.js 透過 window.goToPage() 呼叫，
  // 或監聽這裡廣播的 'page:change' 事件。
  //
  // 比照 account-corner.js 的作法：獨立成一支不依賴 app.js 內部變數的小 script，
  // 就算 app.js 某處丟出例外，也不會拖累導航本身的可用性。

  const qs = sel => document.querySelector(sel);
  const qsa = sel => Array.from(document.querySelectorAll(sel));

  const appShell = qs('.app-shell');
  const sidebar = qs('#sidebar');
  const toggleBtn = qs('#sidebar-toggle');
  const topbarTitle = qs('#topbar-page-title');
  const pageContainer = qs('.page-container');
  const pages = qsa('.page[data-page]');
  const navItems = qsa('.nav-item[data-page]');

  if (!appShell || !sidebar || !pages.length || !navItems.length) return; // 版面元素不存在，理論上不會發生

  const STORAGE_KEY = 'sae-active-page';

  // ---------------- 側邊欄收合／展開 ----------------
  // 「收合」在桌機與手機上視覺意義不同（見 style.css）：
  //   桌機：收合成僅顯示圖示的窄列，內容仍在畫面上，只是變窄。
  //   手機：收合＝完全收起（off-canvas），展開＝以覆蓋層的方式滑出。
  // 這裡只管理同一顆 class（sidebar-collapsed），實際視覺差異交給 CSS 的 media query 決定。

  function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function setSidebarCollapsed(collapsed) {
    appShell.classList.toggle('sidebar-collapsed', collapsed);
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      setSidebarCollapsed(!appShell.classList.contains('sidebar-collapsed'));
    });
  }

  // 手機版：點選側邊欄以外的地方時自動收合（覆蓋層行為）。
  document.addEventListener('click', e => {
    if (!isMobile()) return;
    if (appShell.classList.contains('sidebar-collapsed')) return; // 目前本來就是收合狀態
    if (sidebar.contains(e.target) || (toggleBtn && toggleBtn.contains(e.target))) return;
    setSidebarCollapsed(true);
  });

  // 跨越手機／桌機的斷點時，回到該尺寸下合理的預設值（手機收合／桌機展開），
  // 避免使用者把視窗縮小或放大瀏覽器時卡在不合理的狀態（例如手機版卻是「展開」但沒有遮罩）。
  let lastIsMobile = isMobile();
  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile !== lastIsMobile) {
      setSidebarCollapsed(nowMobile);
      lastIsMobile = nowMobile;
    }
  });

  // 初始狀態：手機預設收合（避免一進站就整頁被選單擋住），桌機預設展開。
  setSidebarCollapsed(isMobile());

  // ---------------- 頁面切換 ----------------

  // 頁面標題取自對應 nav-item 的文字內容，扣掉圖示的部分，不用另外維護一份對照表。
  const pageTitles = {};
  navItems.forEach(btn => {
    const icon = btn.querySelector('.nav-item-icon');
    const label = btn.textContent.replace(icon ? icon.textContent : '', '').trim();
    pageTitles[btn.dataset.page] = label || btn.dataset.page;
  });

  function goToPage(page, opts) {
    opts = opts || {};
    let target = document.getElementById('page-' + page);
    if (!target) {
      page = 'dashboard';
      target = document.getElementById('page-dashboard');
      if (!target) return;
    }

    pages.forEach(p => p.classList.toggle('active', p === target));
    navItems.forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
    if (topbarTitle) topbarTitle.textContent = pageTitles[page] || '';

    if (!opts.skipSave) {
      try { localStorage.setItem(STORAGE_KEY, page); } catch (_) { /* 私密瀏覽模式等情況下寫入會失敗，略過即可 */ }
    }

    // 手機上選了頁面之後，選單就沒必要繼續佔用畫面。
    if (isMobile()) setSidebarCollapsed(true);

    if (!opts.skipScroll) {
      if (pageContainer) pageContainer.scrollTop = 0;
      window.scrollTo({ top: 0 });
    }

    // 讓其他腳本（例如 app.js）可以訂閱頁面切換事件，補做各自需要的初始化，
    // 不用把資料載入邏輯寫進這支跟業務邏輯無關的導航腳本裡。
    window.dispatchEvent(new CustomEvent('page:change', { detail: { page } }));
  }

  navItems.forEach(btn => {
    btn.addEventListener('click', () => goToPage(btn.dataset.page));
  });

  window.goToPage = goToPage;

  // ---------------- 需要先選擇產品／服務設定的頁面：側邊欄提示 ----------------
  // app.js 選定/取消選定設定時，會切換 body 的 no-profile-selected class（見 app.js
  // 的 onProfileSelected()）。這裡用 MutationObserver 被動監聽這個 class 的變化，
  // 幫「語料與痛點／潛在受眾地圖／洞察報告／Meta 廣告效益」這幾個 nav-item-scoped
  // 項目加上淡化＋提示文字，讓使用者在側邊欄就能看出「這幾頁還沒有東西可看」，
  // 不用點進去才發現要先回產品設定頁——不會擋住點擊，頁面本身也有對應的提示與空狀態。

  const scopedItems = navItems.filter(btn => btn.classList.contains('nav-item-scoped'));

  function refreshScopedNavState() {
    const locked = document.body.classList.contains('no-profile-selected');
    scopedItems.forEach(btn => btn.classList.toggle('nav-locked', locked));
  }

  refreshScopedNavState();
  new MutationObserver(refreshScopedNavState).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---------------- 初始頁面 ----------------
  // 記住使用者上次瀏覽的頁面，重新整理後不用每次都從總覽頁點回去；
  // 但如果那一頁需要先選擇產品設定而目前還沒有選（例如換了瀏覽器分頁/清過 session），
  // 直接停在該頁也沒問題——頁面本身就有「請先選擇設定」的提示可看。
  let initial = 'dashboard';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && document.getElementById('page-' + saved)) initial = saved;
  } catch (_) { /* 略過，用預設值 */ }

  goToPage(initial, { skipSave: true, skipScroll: true });
})();
