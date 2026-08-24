(function () {
  let client = null;
  let session = null;

  async function initAuth() {
    let cfg;
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`/api/config 回應 ${res.status}，請確認 api/config.js 是否放在正確路徑並已部署。`);
      cfg = await res.json();
    } catch (err) {
      document.querySelector('#auth-status').textContent = '⚠ 無法讀取系統設定：' + err.message;
      return;
    }
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      document.querySelector('#auth-status').textContent = '⚠ 尚未設定 Supabase 環境變數，請確認 Vercel 的 SUPABASE_URL / SUPABASE_ANON_KEY。';
      return;
    }
    if (typeof supabase === 'undefined') {
      document.querySelector('#auth-status').textContent = '⚠ 找不到 Supabase JS SDK，請確認 index.html 有正確載入 CDN script。';
      return;
    }
    client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data: { session: s } } = await client.auth.getSession();
    session = s;
    client.auth.onAuthStateChange((_event, s) => { session = s; renderAuthUI(); });
    renderAuthUI();
    wireAuthForm();
  }

  // 顯示名稱存在 Supabase Auth 內建的 user_metadata 裡（signUp 的 options.data，或事後
  // 用 updateUser({ data }) 更新），不需要額外的資料表或後端 API——這樣顯示名稱天生就
  // 跟著使用者的登入狀態走，RLS／權限也完全交給 Supabase 自己處理。
  function currentDisplayName() {
    return (session && session.user && session.user.user_metadata && session.user.user_metadata.display_name) || null;
  }

  function renderAuthUI() {
    const status = document.querySelector('#auth-status');
    const signOutBtn = document.querySelector('#auth-signout');
    const signInBtn = document.querySelector('#auth-signin');
    const signUpBtn = document.querySelector('#auth-signup');
    const updateNameBtn = document.querySelector('#auth-update-name');
    const displayNameInput = document.querySelector('#auth-form input[name=display_name]');
    const composer = document.querySelector('#composer-panel');
    const loggedIn = !!session;
    const displayName = currentDisplayName();

    status.textContent = loggedIn
      ? `已登入：${displayName || session.user.email}`
      : '尚未登入，請先登入或註冊帳號才能使用文案生成功能。';
    signOutBtn.hidden = !loggedIn;
    signInBtn.hidden = loggedIn;
    signUpBtn.hidden = loggedIn;
    if (updateNameBtn) updateNameBtn.hidden = !loggedIn;
    document.querySelector('#auth-form input[name=email]').closest('label').style.display = loggedIn ? 'none' : '';
    document.querySelector('#auth-form input[name=password]').closest('label').style.display = loggedIn ? 'none' : '';

    // 顯示名稱欄位不像 email／密碼那樣登入後就隱藏——登入後要能繼續看到、繼續編輯，
    // 所以只在使用者沒有正在打字（focus 在這個欄位）的情況下才覆蓋它的值，避免使用者
    // 正在輸入時被 onAuthStateChange 觸發的重新渲染打斷。
    if (displayNameInput && document.activeElement !== displayNameInput) {
      displayNameInput.value = displayName || '';
    }
    if (displayNameInput) {
      displayNameInput.placeholder = loggedIn ? '未設定則顯示 Email' : '例如：小明（選填，註冊時可直接設定）';
    }

    // 未登入時鎖住整個文案工作台，避免呼叫 API 直接被 RLS 擋下來
    composer.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = !loggedIn; });

    // 讓 app.js 不用猜測 #auth-status 文字內容或用 MutationObserver 反推狀態，
    // 直接訂閱這個事件就能拿到目前登入狀態與顯示名稱。
    window.dispatchEvent(new CustomEvent('auth:change', {
      detail: { loggedIn, email: loggedIn ? session.user.email : null, displayName: loggedIn ? displayName : null },
    }));
  }

  function wireAuthForm() {
    const form = document.querySelector('#auth-form');
    const emailInput = form.querySelector('[name=email]');
    const passwordInput = form.querySelector('[name=password]');
    const displayNameInput = form.querySelector('[name=display_name]');
    const status = document.querySelector('#auth-status');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      status.textContent = '登入中…';
      const { error } = await client.auth.signInWithPassword({ email: emailInput.value, password: passwordInput.value });
      if (error) status.textContent = '⚠ ' + error.message;
    });

    document.querySelector('#auth-signup').addEventListener('click', async () => {
      status.textContent = '註冊中…';
      const display_name = (displayNameInput.value || '').trim() || null;
      const { error } = await client.auth.signUp({
        email: emailInput.value,
        password: passwordInput.value,
        options: { data: { display_name } },
      });
      status.textContent = error ? '⚠ ' + error.message : '註冊成功，請查看信箱完成驗證後再登入。';
    });

    document.querySelector('#auth-signout').addEventListener('click', async () => {
      await client.auth.signOut();
    });

    // 登入後隨時可以修改顯示名稱，不是只有註冊當下才能設定一次。
    const updateNameBtn = document.querySelector('#auth-update-name');
    if (updateNameBtn) {
      updateNameBtn.addEventListener('click', async () => {
        const name = (displayNameInput.value || '').trim();
        if (!name) { status.textContent = '⚠ 請輸入顯示名稱。'; return; }
        updateNameBtn.disabled = true;
        status.textContent = '正在更新顯示名稱…';
        const { data, error } = await client.auth.updateUser({ data: { display_name: name } });
        if (error) {
          status.textContent = '⚠ ' + error.message;
        } else {
          session = data.session || session;
          if (session && session.user) session.user.user_metadata = { ...session.user.user_metadata, display_name: name };
          status.textContent = '已更新顯示名稱。';
          renderAuthUI();
        }
        updateNameBtn.disabled = false;
      });
    }
  }

  // app.js 透過這個函式取得目前登入者的 JWT，附加在每次 /api/* 呼叫的 Authorization 標頭。
  window.getAccessToken = async function () {
    if (!session) return null;
    const { data: { session: fresh } } = await client.auth.getSession();
    session = fresh;
    return fresh ? fresh.access_token : null;
  };

  // 讓其他腳本（app.js）可以 await 這個 promise，確保「登入狀態已確認完成」再打
  // 需要驗證身份的 API，避免網頁一載入就搶在驗證完成前呼叫、被誤判成未登入。
  window.authReady = initAuth();
})();
