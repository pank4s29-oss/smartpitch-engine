// 把「受眾痛點列表」與「潛在受眾地圖」這兩份系統本來就有的清單，組成一份可下載、
// 可離線保存或寄送客戶的 Word 文件。報告內容刻意只有這兩個部分，不做額外的 AI 導讀、
// 覆蓋率統計或風險提示——那些是另一層「分析」，這份文件單純是「原始清單的正式排版
// 輸出」，跟畫面上看到的資料保證一致。
//
// 選擇 .docx 而不是在瀏覽器端用 jsPDF 之類的套件產生 PDF，是因為報告內容全部是繁體中文：
// jsPDF 預設字型（Helvetica/Times）不含中日韓字符，要正確顯示中文得額外內嵌一套中文字型
// （通常好幾 MB），既拖慢下載也增加前端相依套件；而 .docx 本質上只是儲存文字＋樣式的 XML，
// 不需要在「產生檔案」這一步處理任何字型或字形問題，交給使用者的 Word／Pages／Google文件
// 開啟時用系統本身的中文字型渲染即可，穩定且不需要額外資源。
//
// 需要專案有安裝 docx 套件（npm install docx）。
//
// docx 套件從第 8 版起改成純 ESM 套件（package.json 裡是 "type": "module"），雖然它有
// 提供給 require() 使用的相容版本，但 Vercel 的 Serverless Function 打包工具（esbuild）
// 對這種「ESM 套件＋CommonJS 專案」的搭配偶爾會在執行期整支函式直接崩潰（FUNCTION_INVOCATION_FAILED），
// 而不是乾淨地丟出可被 try/catch 接住的錯誤。因此這裡刻意不在檔案最上面用
// `const { ... } = require('docx')`（那樣一旦解析失敗，會連這支檔案裡其他跟 docx 完全
// 無關的 method 處理邏輯都一起壞掉），改用動態 import()，並且只在真正需要匯出 Word
// 文件時才載入、而且包在 try/catch 裡，就算載入失敗也只影響「匯出 Word」這個功能本身。
let docxLibPromise = null;
function loadDocx() {
  if (!docxLibPromise) docxLibPromise = import('docx');
  return docxLibPromise;
}

// 以下所有 helper 都把用到的 docx 類別（D）當參數傳進來，而不是在檔案最上層 import 之後
// 直接閉包參照——這樣即使動態載入延後發生，這些函式的定義本身完全不依賴載入時機。
function heading(D, text, level) {
  return new D.Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
}

function bodyText(D, text, opts = {}) {
  return new D.Paragraph({
    children: [new D.TextRun({ text: text || '', bold: !!opts.bold, italics: !!opts.italics, color: opts.color })],
    spacing: { after: 120 },
  });
}

function bulletList(D, items) {
  return items.map(t => new D.Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 80 } }));
}

// 每一筆（痛點或受眾族群）都包成一張「卡片」（單一儲存格的表格，帶邊框與底色），
// 而不是一串鬆散的段落——純段落在 Word 裡視覺上很難看出「這裡到下一筆之間算同一組」，
// 這是先前版本被抱怨「格式雜亂無章」的主因。用表格單一儲存格模擬卡片邊框是 docx
// 格式裡最穩定的做法（Paragraph 沒有原生的 box-border 概念）；cantSplit 讓同一張
// 卡片盡量不要被硬切到下一頁中間。
function card(D, paragraphs) {
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: [
      new D.TableRow({
        cantSplit: true,
        children: [
          new D.TableCell({
            shading: { type: D.ShadingType.CLEAR, fill: 'F7F9F8' },
            margins: { top: 160, bottom: 160, left: 180, right: 180 },
            borders: {
              top: { style: D.BorderStyle.SINGLE, size: 4, color: 'BFD4CB' },
              bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'BFD4CB' },
              left: { style: D.BorderStyle.SINGLE, size: 16, color: '3E7A5C' },
              right: { style: D.BorderStyle.SINGLE, size: 4, color: 'BFD4CB' },
            },
            children: paragraphs,
          }),
        ],
      }),
    ],
  });
}

function titleParagraph(D, text) {
  return new D.Paragraph({
    children: [new D.TextRun({ text, bold: true, size: 26, color: '18332B' })],
    spacing: { after: 100 },
  });
}

function painPointCard(D, p, index) {
  const paras = [
    titleParagraph(D, `痛點 ${index + 1}：${p.surface_problem || '（未命名痛點）'}`),
    bodyText(D, `深層渴望：${p.deep_desire || '—'}`),
  ];
  if (p.detail) paras.push(bodyText(D, p.detail, { italics: true, color: '555555' }));
  return card(D, paras);
}

function segmentCard(D, seg, index, painPointMap) {
  const paras = [titleParagraph(D, `受眾 ${index + 1}：${seg.segment_name || '未命名族群'}`)];
  if (seg.description) paras.push(bodyText(D, seg.description));
  if (seg.rationale) paras.push(bodyText(D, `為什麼這些痛點特別打中他們：${seg.rationale}`, { color: '555555' }));
  if (seg.differentiation) paras.push(bodyText(D, `與目標受眾的差異：${seg.differentiation}`, { color: '555555' }));

  const matchedIds = Array.isArray(seg.matched_pain_point_ids) ? seg.matched_pain_point_ids : [];
  const matchedTitles = matchedIds.map(id => painPointMap.get(id)).filter(Boolean);
  if (matchedTitles.length) {
    paras.push(bodyText(D, `對應的痛點：${matchedTitles.join('、')}`, { color: '2f6f3e' }));
  }

  const formats = Array.isArray(seg.suggested_formats) ? seg.suggested_formats : [];
  if (formats.length) {
    paras.push(bodyText(D, '適合的數位資產形式：', { bold: true }));
    formats.forEach(f => paras.push(bodyText(D, `${f.format}${f.reason ? '—' + f.reason : ''}`)));
  }
  return card(D, paras);
}

async function buildReportDocx(data, meta) {
  let D;
  try {
    D = await loadDocx();
  } catch (err) {
    throw new Error('無法載入 Word 文件產生套件（docx），請確認專案已安裝該套件並重新部署：' + err.message);
  }

  const dp = data.domain_profile || {};
  const audiences = Array.isArray(dp.audiences) && dp.audiences.length ? dp.audiences.join('、') : '（未設定）';
  const painPoints = Array.isArray(data.pain_points) ? data.pain_points : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const painPointMap = new Map(painPoints.map(p => [p.id, p.surface_problem]));

  const children = [
    new D.Paragraph({
      children: [new D.TextRun({ text: '受眾痛點與潛在受眾地圖報告', bold: true, size: 44 })],
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new D.Paragraph({
      children: [new D.TextRun({ text: `${dp.domain_tag || ''}／${audiences}${meta ? '　｜　' + meta : ''}`, color: '666666' })],
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
  ];

  if (dp.business_constraints_label) {
    children.push(bodyText(D, `呈現媒介限制：${dp.business_constraints_label}`, { color: '666666' }));
  }

  if (data.solution) {
    children.push(heading(D, '產品／解決方案', D.HeadingLevel.HEADING_2));
    children.push(bodyText(D, data.solution.product_name, { bold: true }));
    if (data.solution.core_selling_point) children.push(bodyText(D, `核心賣點：${data.solution.core_selling_point}`));
    children.push(bodyText(D, data.solution.solution_description));
    if (data.solution.trust_proof) children.push(bodyText(D, `信任背書：${data.solution.trust_proof}`, { color: '555555' }));
  }

  children.push(heading(D, '受眾痛點列表', D.HeadingLevel.HEADING_2));
  if (!painPoints.length) {
    children.push(bodyText(D, '此產品/服務設定尚無痛點資料。', { color: '999999' }));
  } else {
    painPoints.forEach((p, i) => {
      children.push(painPointCard(D, p, i));
      children.push(new D.Paragraph({ text: '', spacing: { after: 200 } }));
    });
  }

  // 潛在受眾地圖另起一頁：跟前面的痛點列表分開，讀者一眼就知道「這裡開始是反推出來的
  // 細分受眾族群」，而不是被同一頁越擠越長的內容打斷閱讀節奏。
  children.push(new D.Paragraph({ children: [], pageBreakBefore: true }));
  children.push(heading(D, '潛在受眾地圖', D.HeadingLevel.HEADING_2));
  if (!segments.length) {
    children.push(bodyText(D, '此產品/服務設定尚無潛在受眾分析結果。', { color: '999999' }));
  } else {
    segments.forEach((seg, i) => {
      children.push(segmentCard(D, seg, i, painPointMap));
      children.push(new D.Paragraph({ text: '', spacing: { after: 200 } }));
    });
  }

  const doc = new D.Document({
    sections: [{ properties: {}, children }],
    styles: {
      default: { document: { run: { font: 'Microsoft JhengHei', size: 22 } } },
    },
  });

  return D.Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
