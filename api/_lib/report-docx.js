// 受眾分析報告 Word 匯出器：只輸出受眾潛在痛點列表與潛在受眾地圖。
// 使用保守的 OOXML 結構，避免不同版本的 Microsoft Word 因頁碼欄位或複雜樣式而拒絕開啟。
//
// 報告白牌化（商業企劃書 P1 項目）：品牌識別（名稱／主色／Logo）存在 Supabase Auth 的
// user_metadata 裡（見 auth.js 的 updateBrandSettings），不需要新的資料表也不需要新的
// 後端 API——這支檔案的呼叫端（insight-reports-hub.js）本來就會用 service role 呼叫
// Supabase Auth 拿到完整的使用者資料，取出 user_metadata 直接傳進來就好。
let docxLibPromise = null;
function loadDocx() {
  if (!docxLibPromise) docxLibPromise = import('docx');
  return docxLibPromise;
}

const FONT = 'Microsoft JhengHei';
const DEFAULT_ACCENT = '1E4936'; // 沒有設定品牌主色時，維持系統原本的深綠色。
const DEFAULT_ACCENT_SOFT = '2F6F3E';

// 只接受公開圖片連結，避免使用者（或不小心誤貼進去的內容）把內網位址、雲端服務的
// metadata endpoint（例如 169.254.169.254）當成「Logo 網址」，導致伺服器端 fetch 被
// 拿來當作 SSRF 跳板。只放行一般 https 網址，且明確擋掉常見的內部／保留位址。
function isSafePublicImageUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return false;
  if (/^(10\.|127\.|169\.254\.|192\.168\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

// 輕量、不依賴額外套件的圖片尺寸解析：只需要支援 Logo 最常見的 PNG／JPEG 兩種格式，
// 抓不到尺寸（例如格式不支援、檔案損毀）就回傳 null，呼叫端會直接略過 Logo，
// 不影響報告其他部分的產出。
function readImageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    // PNG：簽章 8 bytes，接著 IHDR chunk（4 bytes 長度 + 4 bytes "IHDR" + 資料），
    // 寬高各佔 4 bytes，緊接在 chunk 資料開頭。
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    // JPEG：從第 2 byte 開始逐段掃描 marker，找到 SOF0/SOF1/SOF2 這幾種常見的
    // 「Start Of Frame」marker，裡面帶著實際的像素寬高。
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    }
  }
  return null;
}

// 下載 Logo 圖片並算好嵌入 Word 需要的寬高（等比縮放，最長邊不超過 96px，避免
// Logo 比報告標題還大）。任何一步失敗（網路逾時、非圖片內容、格式不支援）都當作
// 「這次沒有 Logo」處理，不讓整份報告因為一張圖片失敗而匯出不了。
async function fetchLogoImage(url) {
  if (!url || !isSafePublicImageUrl(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!/^image\/(png|jpeg|jpg)/i.test(contentType)) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 8 || buffer.length > 5 * 1024 * 1024) return null; // 超過 5MB 的圖片不嵌入，避免拖慢匯出。
    const size = readImageSize(buffer);
    if (!size || !size.width || !size.height) return null;
    const MAX_SIDE = 96;
    const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
    return {
      buffer,
      type: /png/i.test(contentType) ? 'png' : 'jpg',
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    };
  } catch (_) {
    return null; // 逾時／網路錯誤／非預期例外，一律視為沒有 Logo。
  }
}

function run(D, text, opts = {}) {
  return new D.TextRun({
    text: String(text || ''),
    bold: !!opts.bold,
    italics: !!opts.italics,
    color: opts.color || '182620',
    size: opts.size || 22,
    font: FONT,
  });
}

function paragraph(D, text = '', opts = {}) {
  return new D.Paragraph({
    children: [run(D, text, opts)],
    alignment: opts.alignment,
    spacing: {
      before: opts.before || 0,
      after: opts.after === undefined ? 120 : opts.after,
      line: 300,
    },
    keepNext: !!opts.keepNext,
  });
}

function heading(D, text, accent) {
  return new D.Paragraph({
    children: [run(D, text, { bold: true, color: accent || DEFAULT_ACCENT, size: 30 })],
    spacing: { before: 260, after: 140, line: 320 },
    keepNext: true,
  });
}

function card(D, paragraphs, accent) {
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    borders: {
      top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      left: { style: D.BorderStyle.SINGLE, size: 18, color: accent || '3E7A5C' },
      right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      insideHorizontal: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [new D.TableRow({
      cantSplit: true,
      children: [new D.TableCell({
        shading: { type: D.ShadingType.SOLID, fill: 'F6FAF7' },
        margins: { top: 180, bottom: 180, left: 220, right: 220 },
        children: paragraphs,
      })],
    })],
  });
}

function cardTitle(D, text) {
  return paragraph(D, text, { bold: true, color: '18332B', size: 25, after: 90, keepNext: true });
}

function painPointCard(D, point, index) {
  const content = [cardTitle(D, `痛點 ${index + 1}：${point.surface_problem || '未命名痛點'}`)];
  if (point.deep_desire) content.push(paragraph(D, `深層渴望：${point.deep_desire}`, { color: '315F4A', after: 90 }));
  if (point.detail) content.push(paragraph(D, point.detail, { italics: true, color: '5B6862', after: 0 }));
  return card(D, content);
}

function segmentCard(D, segment, index, painPointMap, accent) {
  const content = [cardTitle(D, `受眾 ${index + 1}：${segment.segment_name || '未命名族群'}`)];
  if (segment.description) content.push(paragraph(D, segment.description, { after: 90 }));
  if (segment.rationale) content.push(paragraph(D, `為什麼這些痛點特別打中他們：${segment.rationale}`, { color: '5B6862', after: 90 }));
  if (segment.differentiation) content.push(paragraph(D, `與目標受眾的差異：${segment.differentiation}`, { color: '5B6862', after: 90 }));

  const ids = Array.isArray(segment.matched_pain_point_ids) ? segment.matched_pain_point_ids : [];
  const matched = ids.map(id => painPointMap.get(id)).filter(Boolean);
  if (matched.length) content.push(paragraph(D, `對應的痛點：${matched.join('、')}`, { color: accent || '2F6F3E', after: 90 }));

  const formats = Array.isArray(segment.suggested_formats) ? segment.suggested_formats : [];
  if (formats.length) {
    content.push(paragraph(D, '適合的數位資產形式：', { bold: true, color: '315F4A', after: 50 }));
    formats.forEach(item => content.push(paragraph(D, `${item.format || ''}${item.reason ? ' — ' + item.reason : ''}`, { after: 45 })));
  }
  return card(D, content, accent);
}

async function buildReportDocx(data, meta, brand = {}) {
  let D;
  try { D = await loadDocx(); }
  catch (err) { throw new Error('無法載入 Word 文件產生套件：' + err.message); }

  const profile = data.domain_profile || {};
  const audiences = Array.isArray(profile.audiences) && profile.audiences.length ? profile.audiences.join('、') : '未設定';
  const painPoints = Array.isArray(data.pain_points) ? data.pain_points : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const painPointMap = new Map(painPoints.map(point => [point.id, point.surface_problem]));

  // 品牌識別：主色沒填或格式不對就用系統預設色，Logo 抓不到就整段跳過，
  // 兩者互相獨立，不會因為其中一項失敗就連帶影響另一項。
  const accent = /^[0-9A-Fa-f]{6}$/.test(String(brand.brand_color || '')) ? brand.brand_color.toUpperCase() : DEFAULT_ACCENT;
  const brandName = String(brand.brand_name || '').trim();
  const logo = await fetchLogoImage(brand.brand_logo_url);

  const coverChildren = [];
  if (logo) {
    coverChildren.push(new D.Paragraph({
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new D.ImageRun({
        data: logo.buffer,
        type: logo.type,
        transformation: { width: logo.width, height: logo.height },
      })],
    }));
  }
  coverChildren.push(
    paragraph(D, '受眾分析報告', { bold: true, color: accent, size: 40, alignment: D.AlignmentType.CENTER, after: 100 }),
    paragraph(D, `${profile.domain_tag || '未設定領域'}　｜　${audiences}`, { color: '64736B', alignment: D.AlignmentType.CENTER, after: 50 }),
  );
  if (brandName) {
    coverChildren.push(paragraph(D, `由 ${brandName} 提供`, { color: accent, size: 19, alignment: D.AlignmentType.CENTER, after: 50 }));
  }
  coverChildren.push(
    paragraph(D, meta || '', { color: '8A948F', size: 18, alignment: D.AlignmentType.CENTER, after: 260 }),
    heading(D, '一、受眾潛在痛點列表', accent),
  );

  const children = coverChildren;

  if (!painPoints.length) {
    children.push(paragraph(D, '目前尚無已確認的受眾潛在痛點。', { color: '8A948F' }));
  } else {
    painPoints.forEach((point, index) => {
      children.push(painPointCard(D, point, index));
      children.push(paragraph(D, '', { after: 100 }));
    });
  }

  // 使用標準段落屬性分頁，不插入複雜的頁面欄位或頁首頁尾。
  children.push(new D.Paragraph({ children: [], pageBreakBefore: true }));
  children.push(heading(D, '二、潛在受眾地圖', accent));
  if (!segments.length) {
    children.push(paragraph(D, '目前尚無潛在受眾分析結果。', { color: '8A948F' }));
  } else {
    segments.forEach((segment, index) => {
      children.push(segmentCard(D, segment, index, painPointMap, accent));
      children.push(paragraph(D, '', { after: 100 }));
    });
  }

  const document = new D.Document({
    creator: brandName || '受眾策略引擎',
    title: '受眾分析報告',
    description: '受眾潛在痛點列表與潛在受眾地圖',
    sections: [{
      properties: {
        page: {
          margin: { top: 900, right: 1000, bottom: 900, left: 1000 },
          size: { width: 11906, height: 16838 },
        },
      },
      children,
    }],
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
    },
  });

  return D.Packer.toBuffer(document);
}

module.exports = { buildReportDocx };
