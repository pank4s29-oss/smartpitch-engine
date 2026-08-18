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

  function renderAuthUI() {
    const status = document.querySelector('#auth-status');
    const signOutBtn = document.querySelector('#auth-signout');
    const signInBtn = document.querySelector('#auth-signin');
    const signUpBtn = document.querySelector('#auth-signup');
    const composer = document.querySelector('#composer-panel');
    const loggedIn = !!session;

    status.textContent = loggedIn ? `已登入：${session.user.email}` : '尚未登入，請先登入或註冊帳號才能使用文案生成功能。';
    signOutBtn.hidden = !loggedIn;
    signInBtn.hidden = loggedIn;
    signUpBtn.hidden = loggedIn;
    document.querySelector('#auth-form input[name=email]').closest('label').style.display = loggedIn ? 'none' : '';
    document.querySelector('#auth-form input[name=password]').closest('label').style.display = loggedIn ? 'none' : '';

    // 未登入時鎖住整個文案工作台，避免呼叫 API 直接被 RLS 擋下來
    composer.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = !loggedIn; });
  }

  function wireAuthForm() {
    const form = document.querySelector('#auth-form');
    const emailInput = form.querySelector('[name=email]');
    const passwordInput = form.querySelector('[name=password]');
    const status = document.querySelector('#auth-status');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      status.textContent = '登入中…';
      const { error } = await client.auth.signInWithPassword({ email: emailInput.value, password: passwordInput.value });
      if (error) status.textContent = '⚠ ' + error.message;
    });

    document.querySelector('#auth-signup').addEventListener('click', async () => {
      status.textContent = '註冊中…';
      const { error } = await client.auth.signUp({ email: emailInput.value, password: passwordInput.value });
      status.textContent = error ? '⚠ ' + error.message : '註冊成功，請查看信箱完成驗證後再登入。';
    });

    document.querySelector('#auth-signout').addEventListener('click', async () => {
      await client.auth.signOut();
    });
  }

  // app.js 透過這個函式取得目前登入者的 JWT，附加在每次 /api/* 呼叫的 Authorization 標頭。
  // 這是唯一刻意外洩到全域的東西，其餘變數/函式都被包在這個 IIFE 裡，不會跟 app.js 的全域命名衝突。
  window.getAccessToken = async function () {
    if (!session) return null;
    const { data: { session: fresh } } = await client.auth.getSession();
    session = fresh;
    return fresh ? fresh.access_token : null;
  };

  initAuth();
})();
