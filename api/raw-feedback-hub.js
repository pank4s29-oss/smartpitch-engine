const { getUserFromRequest, restRequest, sendError } = require('./_lib/supabase');
const { normalizeImages, ocrImageToText } = require('./_lib/vision');

// 一次匯入最多允許幾張圖片：圖片 OCR 是逐張呼叫 AI，張數上限刻意設得比純文字匯入
// （MAX_BATCH_SIZE，見下方）低很多，避免使用者一次選了幾十張截圖，單一次請求
// 因為要依序呼叫幾十次 AI 而超過 Vercel 函式的執行時限（vercel.json 目前設定
// api/**/*.js 的 maxDuration 是 30 秒）。
const MAX_IMAGE_BATCH_SIZE = 8;

// 這支合併了原本 2 支獨立檔案：
//   GET/POST  /api/raw-feedback      (無 id)
//   DELETE    /api/raw-feedback/:id  (有 id)
// 對應的 vercel.json rewrites 會把兩個路徑都導到這支檔案，前端網址不需要改。

// 語料來源分類改為使用者自訂（原本是寫死的 6 種），這幾個是首次使用時自動帶入的預設值，
// 之後使用者可以自由新增／刪除，順序以「社群貼文分享」排最前面，對應主要蒐集來源。
const DEFAULT_LABELS = ['社群貼文分享', '顧客評論', '客服對話', '問卷回饋', '訪談逐字稿', '其他'];
const MAX_LABEL_LENGTH = 20;
const MAX_TEXT_LENGTH = 5000;
// CSV／結構化批次匯入常常一次就有上百列，原本 50 筆的上限對日常素材（例如整批匯出的評論）
// 太保守；前端會依這個上限自動切批送出，這裡只要放寬到合理範圍即可。
const MAX_BATCH_SIZE = 200;

// ── 匯入前過濾：雜訊語料 ──────────────────────────────────────────────
// 對應「AI 用量最佳化」的第 2 點：像「+1」「推」「謝謝」這類零資訊語料，就算送進 AI
// 也萃取不出任何有語料佐證的痛點，純粹浪費批次的名額與 token；與其在萃取階段才發現沒用，
// 不如在匯入這一關就先擋下來，不寫進資料庫，之後選取語料進行分析時自然也不會再送進 AI。
//
// 兩層判斷都要有，缺一不可：
//   ①黑名單完全比對（正規化後）：擋掉已知的零資訊慣用語，例如「推」「+1」「謝謝分享」。
//   ②正規化後長度門檻：擋掉黑名單沒列到、但明顯太短沒有情境的內容（例如純標點、單一 emoji）。
// 刻意不用「長度門檻」單獨判斷，因為像「太貴」「很懶」這種雖然短、但本身就是一個完整痛點
// 訊號的語料，不應該被長度門檻誤殺——這類語料黑名單裡不會有，也通常不會低於長度門檻，
// 兩層判斷合起來才不會又誤殺、又漏放。
const NOISE_EXACT_MATCHES = new Set([
  '+1', '+1推', '推', '推!', '推！', '推推', '推爆', '推一個', '推一下', '推一波', '推坑成功',
  '讚', '讚讚', '讚啦', '讚喔', '大讚', '棒', '太棒了', '厲害', '推薦',
  '謝謝', '感謝', '謝謝分享', '感謝分享', '謝謝老闆', '感謝老闆',
  '支持', '支持一下', '路過', '簽到', '頂', '頂一個', '頂上去',
  '已購買', '已下單', '已購入', '已入手', '手刀入手', '已敗', '已敗入', '已收藏', '先收藏', '心得+1', '心得推',
  '好', '好用', '不錯', '還不錯', '超讚', '超好用', 'cp值高', 'cp值超高', 'c/p值高',
]);
// 移除標點、空白、常見語助詞尾綴後仍不足這個長度，視為缺乏情境的雜訊。
// 刻意設得很低（只擋掉 0~1 字，例如純標點、單一 emoji、空白）：中文有意義的抱怨常常
// 很短（例如「太貴了」「很懶」只有 2~3 字，但已經是完整的痛點訊號），長度門檻若設太高，
// 反而會把這類真正有價值的短語料一起濾掉。真正沒意義的短語，交給上面的黑名單完全比對處理，
// 而不是靠長度門檻概括承受。
const MIN_MEANINGFUL_LENGTH = 2;

function normalizeForNoiseCheck(s) {
  return (s || '')
    .trim()
    .replace(/[\s\u3000]/g, '')
    .replace(/[!！?？~～.。,，、…]/g, '')
    .toLowerCase();
}

// 只依表情符號／標點把「看起來字數夠但沒有實質內容」的內容排除在長度計算之外
// （例如「😂😂😂😂」正規化後字數不算少，但完全沒有描述任何情境）。
function stripSymbols(s) {
  return (s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
}

function isNoiseFeedback(rawText) {
  const normalized = normalizeForNoiseCheck(rawText);
  if (!normalized) return true;
  if (NOISE_EXACT_MATCHES.has(normalized)) return true;
  if (stripSymbols(normalized).length < MIN_MEANINGFUL_LENGTH) return true;
  return false;
}

// ── 匯入前過濾：完全重複的語料 ────────────────────────────────────────
// 對應第 3 點：不引入額外的 hash 欄位或套件，直接對同一個產品/服務設定（或未分類語料）
// 底下既有的語料做「正規化後完全比對」，擋掉一字不差的重複匯入（最常見情境：不小心把
// 同一份 CSV 或同一段文字貼了兩次）。刻意只做完全比對、不做模糊相似度比對——近似重複
// （改寫過的相似句子）留給既有的痛點合併機制（audience_pain_points 的 bigram 相似度）
// 在萃取階段處理，避免這裡比對太寬鬆，把兩則語意接近但其實是不同顧客講的話誤判成重複。
function normalizeForDedup(s) {
  return (s || '').trim().replace(/\s+/g, ' ');
}

// 把使用者輸入或 CSV 欄位裡的日期字串正規化成 ISO 字串；無法解析就當作沒有提供，不擋匯入。
function normalizeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 把評分正規化到 0-5 的範圍；無法解析或超出合理範圍就當作沒有提供，不擋匯入
// （評分本來就是輔助資訊，不應該因為格式不完美就讓整筆語料匯入失敗）。
function normalizeRating(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(5, n));
}

async function handleList(req, res, user) {
  const { domain_profile_id, limit } = req.query || {};
  try {
    let query = `raw_customer_feedback?user_id=eq.${user.id}&select=*&order=created_at.desc`;
    if (domain_profile_id) query += `&domain_profile_id=eq.${domain_profile_id}`;
    query += `&limit=${Math.min(Number(limit) || 50, 200)}`;

    const items = await restRequest(query);
    return res.status(200).json(items);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreate(req, res, user) {
  const { domain_profile_id, source_type, raw_text, raw_texts, items, images } = req.body || {};

  const sourceType = (source_type || '').trim();
  if (!sourceType) return sendError(res, 400, '請選擇語料來源分類。');
  if (sourceType.length > MAX_LABEL_LENGTH) return sendError(res, 400, `分類名稱不可超過 ${MAX_LABEL_LENGTH} 字。`);

  // 三種匯入路徑統一轉成同一種內部格式（rows）再寫入：
  //   1. items：結構化匯入（例如前端解析 CSV 後送來），每筆可以帶 occurred_at／rating／meta，
  //      讓語料除了純文字之外，還能保留「這則語料本身的日期、評分，以及其他原始欄位」這些脈絡。
  //   2. raw_text／raw_texts：既有的純文字貼上匯入，維持原本行為，日期/評分一律是空值。
  //   3. images：截圖／圖片匯入（例如顧客評論、社群留言的截圖）。逐張呼叫 AI 做 OCR
  //      轉出文字，轉出來的文字之後跟純文字匯入走同一套雜訊過濾／去重／寫入流程，
  //      不另外重複寫一次——OCR 只負責「把圖片變成文字」這一步。
  let rows;
  let ocrFailures = [];
  if (Array.isArray(images) && images.length) {
    const normalizedImages = normalizeImages(images, MAX_IMAGE_BATCH_SIZE);
    const ocrResults = await Promise.all(normalizedImages.map(async (img, i) => {
      try {
        const text = await ocrImageToText(img);
        return { ok: true, text };
      } catch (err) {
        return { ok: false, index: i, message: err.message };
      }
    }));
    ocrFailures = ocrResults.filter(r => !r.ok).map(r => `第 ${r.index + 1} 張：${r.message}`);
    rows = ocrResults
      .filter(r => r.ok && r.text)
      .map(r => ({ raw_text: r.text, occurred_at: null, rating: null, meta: { imported_via: 'image_ocr' } }));
  } else if (Array.isArray(items) && items.length) {
    rows = items
      .map(it => ({
        raw_text: typeof (it && it.raw_text) === 'string' ? it.raw_text.trim() : '',
        occurred_at: normalizeDate(it && it.occurred_at),
        rating: normalizeRating(it && it.rating),
        meta: (it && it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta)) ? it.meta : {},
      }))
      .filter(r => r.raw_text);
  } else {
    const texts = (Array.isArray(raw_texts) ? raw_texts : [raw_text])
      .filter(t => typeof t === 'string' && t.trim())
      .map(t => t.trim());
    rows = texts.map(text => ({ raw_text: text, occurred_at: null, rating: null, meta: {} }));
  }

  if (!rows.length) {
    if (ocrFailures.length) return sendError(res, 502, `圖片文字辨識失敗：${ocrFailures.join('；')}`);
    return sendError(res, 400, '請提供至少一筆語料內容（raw_text／raw_texts、結構化的 items，或 images）。');
  }
  if (rows.length > MAX_BATCH_SIZE) return sendError(res, 400, `單次最多匯入 ${MAX_BATCH_SIZE} 筆語料，請分批匯入。`);
  const tooLong = rows.find(r => r.raw_text.length > MAX_TEXT_LENGTH);
  if (tooLong) return sendError(res, 400, `單篇語料內容不可超過 ${MAX_TEXT_LENGTH} 字，請縮短後再匯入（可考慮拆成多篇）。`);

  try {
    if (domain_profile_id) {
      const owned = await restRequest(`domain_profiles?id=eq.${domain_profile_id}&user_id=eq.${user.id}&select=id`);
      if (!owned.length) return sendError(res, 404, '找不到對應的產品/服務設定。');
    }

    // 第一層過濾：擋掉「+1」「推」之類缺乏情境的雜訊語料，不寫入資料庫，之後選取語料
    // 進行分析時自然也不會被送進 AI。
    const noiseSkipped = [];
    const afterNoiseFilter = rows.filter(r => {
      if (isNoiseFeedback(r.raw_text)) { noiseSkipped.push(r.raw_text); return false; }
      return true;
    });

    // 第二層過濾：擋掉跟同一個產品/服務設定（或未分類語料）底下既有紀錄「一字不差」的重複匯入。
    // 只查詢同一個 scope（同一個 domain_profile_id，或都未分類）底下的既有語料，
    // 不用整個帳號的所有語料去比對，避免不同產品間語意相近但其實是不同情境的內容被誤擋。
    const existingQuery = domain_profile_id
      ? `raw_customer_feedback?user_id=eq.${user.id}&domain_profile_id=eq.${domain_profile_id}&select=raw_text`
      : `raw_customer_feedback?user_id=eq.${user.id}&domain_profile_id=is.null&select=raw_text`;
    const existingRows = await restRequest(existingQuery);
    const existingTexts = new Set(existingRows.map(r => normalizeForDedup(r.raw_text)));

    const seenInThisBatch = new Set();
    const duplicateSkipped = [];
    const afterDedup = afterNoiseFilter.filter(r => {
      const key = normalizeForDedup(r.raw_text);
      if (existingTexts.has(key) || seenInThisBatch.has(key)) { duplicateSkipped.push(r.raw_text); return false; }
      seenInThisBatch.add(key);
      return true;
    });

    if (!afterDedup.length) {
      return res.status(200).json({
        imported: 0,
        items: [],
        skipped_noise: noiseSkipped.length,
        skipped_duplicate: duplicateSkipped.length,
        message: `這批語料在過濾後沒有新內容可匯入（${noiseSkipped.length} 筆疑似缺乏情境的雜訊、${duplicateSkipped.length} 筆與既有語料完全重複），未寫入任何資料。`,
      });
    }

    const dbRows = afterDedup.map(r => ({
      user_id: user.id,
      domain_profile_id: domain_profile_id || null,
      source_type: sourceType,
      raw_text: r.raw_text,
      occurred_at: r.occurred_at,
      rating: r.rating,
      meta: r.meta,
    }));

    const saved = await restRequest('raw_customer_feedback', {
      method: 'POST',
      prefer: 'return=representation',
      body: dbRows.length === 1 ? dbRows[0] : dbRows,
    });

    const savedList = Array.isArray(saved) ? saved : [saved];

    const skipParts = [];
    if (noiseSkipped.length) skipParts.push(`${noiseSkipped.length} 筆疑似缺乏情境的雜訊（如「推」「+1」）已自動略過`);
    if (duplicateSkipped.length) skipParts.push(`${duplicateSkipped.length} 筆與既有語料完全重複已自動略過`);
    if (ocrFailures.length) skipParts.push(`${ocrFailures.length} 張圖片辨識失敗（${ocrFailures.join('；')}）`);
    const message = skipParts.length
      ? `已匯入 ${savedList.length} 筆語料；${skipParts.join('、')}。`
      : undefined;

    return res.status(200).json({
      imported: savedList.length,
      items: savedList,
      skipped_noise: noiseSkipped.length,
      skipped_duplicate: duplicateSkipped.length,
      ocr_failed: ocrFailures.length,
      message,
    });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDelete(req, res, user, id) {
  try {
    await restRequest(`raw_customer_feedback?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

// ---- 語料來源分類管理 ----

async function handleListLabels(req, res, user) {
  try {
    let labels = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&select=*&order=sort_order.asc,created_at.asc`);
    if (!labels.length) {
      // 第一次使用，帶入預設分類，之後使用者可自由增刪。
      const rows = DEFAULT_LABELS.map((label, i) => ({ user_id: user.id, label, sort_order: i }));
      labels = await restRequest('feedback_source_labels', { method: 'POST', prefer: 'return=representation', body: rows });
      labels.sort((a, b) => a.sort_order - b.sort_order);
    }
    return res.status(200).json(labels);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleCreateLabel(req, res, user) {
  const label = (req.body && req.body.label || '').trim();
  if (!label) return sendError(res, 400, '請輸入分類名稱。');
  if (label.length > MAX_LABEL_LENGTH) return sendError(res, 400, `分類名稱不可超過 ${MAX_LABEL_LENGTH} 字。`);
  try {
    const existing = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&label=eq.${encodeURIComponent(label)}&select=id`);
    if (existing.length) return sendError(res, 409, '這個分類已經存在。');
    const countRes = await restRequest(`feedback_source_labels?user_id=eq.${user.id}&select=sort_order&order=sort_order.desc&limit=1`);
    const nextOrder = countRes.length ? countRes[0].sort_order + 1 : 0;
    const [saved] = await restRequest('feedback_source_labels', {
      method: 'POST', prefer: 'return=representation', body: { user_id: user.id, label, sort_order: nextOrder },
    });
    return res.status(200).json(saved);
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

async function handleDeleteLabel(req, res, user, id) {
  try {
    await restRequest(`feedback_source_labels?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
    return res.status(200).json({ deleted: true });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

module.exports = async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return sendError(res, 401, '請先登入。');

  const { id, action } = req.query || {};

  if (action === 'source-types') {
    if (id) {
      if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
      return handleDeleteLabel(req, res, user, id);
    }
    if (req.method === 'GET') return handleListLabels(req, res, user);
    if (req.method === 'POST') return handleCreateLabel(req, res, user);
    return sendError(res, 405, '不支援的方法。');
  }

  if (id) {
    if (req.method !== 'DELETE') return sendError(res, 405, '不支援的方法。');
    return handleDelete(req, res, user, id);
  }
  if (req.method === 'GET') return handleList(req, res, user);
  if (req.method === 'POST') return handleCreate(req, res, user);
  return sendError(res, 405, '不支援的方法。');
};
