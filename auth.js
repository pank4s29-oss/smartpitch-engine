(function () {
  let client = null;
  let session = null;

  // 清理顯示名稱：去除複製貼上時容易夾帶的零寬字元／不換行空白（.trim() 清不掉這些字元，
  // 存進 user_metadata 後畫面上會呈現看起來像空白的符號），並統一 trim 前後空白。
  // 清理後若變成空字串，回傳 null，讓呼叫端可以用 || 接續退回 email 等預設值。
  function cleanDisplayName(raw) {
    return (raw || '')
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
      .trim() || null;
  }

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

    // 修正：先前只用 getSession() 拿本機快取的 session，若顯示名稱是在其他分頁／裝置
    // 更新過，這裡快取到的 user_metadata 可能是舊的，導致角落按鈕顯示錯誤的名稱
    // （或該顯示名稱時卻顯示 Email）。這裡額外用 getUser() 跟 Supabase 伺服器核對一次，
    // 拿到當下真正最新的 user_metadata 後才渲染，讀不到（例如 token 過期）就靜默略過，
    // 交由後續的登入流程或 API 呼叫處理，不擋住頁面初始化。
    if (session) {
      try {
        const { data: { user: freshUser } } = await client.auth.getUser();
        if (freshUser) session = { ...session, user: freshUser };
      } catch (_) { /* 忽略，沿用 getSession() 的結果 */ }
    }

    client.auth.onAuthStateChange(async (_event, s) => {
      session = s;
      // 這個 callback 訂閱當下一定會非同步觸發一次 INITIAL_SESSION 事件，帶的是 SDK
      // 內部快取的 session，並沒有經過上面 getUser() 的校正，直接蓋回去會把剛剛修好的
      // user_metadata 又蓋回舊版，導致角落名稱跳回 email 或顯示異常（含看起來像空白的字元）。
      // 所以這裡也比照上面的作法，每次事件觸發都重新跟伺服器核對一次最新的 user 再渲染，
      // 不管是註冊/登入當下的 INITIAL_SESSION，還是之後的 TOKEN_REFRESHED 等事件皆同。
      if (session) {
        try {
          const { data: { user: freshUser } } = await client.auth.getUser();
          if (freshUser) session = { ...session, user: freshUser };
        } catch (_) { /* 忽略，沿用目前 session */ }
      }
      renderAuthUI();
    });
    renderAuthUI();
    wireAuthForm();
  }

  // 顯示名稱存在 Supabase Auth 內建的 user_metadata 裡（signUp 的 options.data，或事後
  // 用 updateUser({ data }) 更新），不需要額外的資料表或後端 API——這樣顯示名稱天生就
  // 跟著使用者的登入狀態走，RLS／權限也完全交給 Supabase 自己處理。
  function currentDisplayName() {
    const raw = session && session.user && session.user.user_metadata && session.user.user_metadata.display_name;
    return cleanDisplayName(raw);
  }

  function renderAuthUI() {
    const status = document.querySelector('#auth-status');
    const signOutBtn = document.querySelector('#auth-signout');
    const signInBtn = document.querySelector('#auth-signin');
    const signUpBtn = document.querySelector('#auth-signup');
    const composer = document.querySelector('#composer-panel');
    const loggedIn = !!session;
    const displayName = currentDisplayName();

    status.textContent = loggedIn
      ? `已登入：${displayName || session.user.email}`
      : '尚未登入，請先登入或註冊帳號才能使用文案生成功能。';
    signOutBtn.hidden = !loggedIn;
    signInBtn.hidden = loggedIn;
    signUpBtn.hidden = loggedIn;
    document.querySelector('#auth-form input[name=email]').closest('label').style.display = loggedIn ? 'none' : '';
    document.querySelector('#auth-form input[name=password]').closest('label').style.display = loggedIn ? 'none' : '';
    // 顯示名稱欄位現在只用在「註冊當下順便設定」，登入後要修改請用右上角使用者名稱
    // 旁邊的「帳號設定」按鍵，不再讓這個欄位同時扮演兩種用途，避免使用者搞不清楚
    // 現在改的是哪一個。
    const displayNameLabel = document.querySelector('#auth-form input[name=display_name]').closest('label');
    if (displayNameLabel) displayNameLabel.style.display = loggedIn ? 'none' : '';

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
      const display_name = cleanDisplayName(displayNameInput.value);
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
  }

  // app.js 透過這個函式取得目前登入者的 JWT，附加在每次 /api/* 呼叫的 Authorization 標頭。
  window.getAccessToken = async function () {
    if (!session) return null;
    const { data: { session: fresh } } = await client.auth.getSession();
    session = fresh;
    return fresh ? fresh.access_token : null;
  };

  // 供「帳號設定」modal 使用：更新顯示名稱。修正舊版的錯誤寫法——Supabase JS v2 的
  // updateUser() 回傳的是 { data: { user } }，並沒有 data.session 這個欄位，先前寫
  // `session = data.session || session` 永遠會落回舊的 session、等於沒真的更新，只能
  // 靠後面手動貼上去的那行 patch 勉強頂著。這裡改成直接採用 updateUser() 回傳的最新
  // user 物件，並整個換掉 session.user，資料來源正確、不用再手動拼湊。
  window.updateDisplayName = async function (name) {
    if (!client || !session) throw new Error('請先登入。');
    const cleaned = cleanDisplayName(name);
    const { data, error } = await client.auth.updateUser({ data: { display_name: cleaned } });
    if (error) throw new Error(error.message);
    if (data && data.user) session = { ...session, user: data.user };
    renderAuthUI();
  };

  // 供「帳號設定」modal 的登出按鈕使用，不用重複寫一次 client.auth.signOut()。
  window.signOut = async function () {
    if (!client) return;
    await client.auth.signOut();
  };

  // 讓其他腳本（app.js）可以 await 這個 promise，確保「登入狀態已確認完成」再打
  // 需要驗證身份的 API，避免網頁一載入就搶在驗證完成前呼叫、被誤判成未登入。
  window.authReady = initAuth();
})();
