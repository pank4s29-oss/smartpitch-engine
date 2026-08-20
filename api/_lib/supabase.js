// 共用輔助：驗證前端傳來的 JWT，並提供以 service role 存取 PostgREST 的簡易方法。
// 不引入 @supabase/supabase-js 套件，純用 fetch 呼叫 Supabase 的 REST API，避免額外相依套件。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 驗證 Authorization: Bearer <token>，回傳 { id, email } 或在無效時回傳 null。
async function getUserFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

// 用 service role key 對 PostgREST 發送請求（會繞過 RLS，因此呼叫前務必自行檢查 user_id）。
async function restRequest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase REST ${method} ${path} 失敗：${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// 標準錯誤回應，統一格式讓前端 api() 的錯誤處理可以直接讀 j.error
function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

module.exports = { getUserFromRequest, restRequest, sendError };
