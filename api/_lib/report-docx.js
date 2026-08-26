// 把「潛在受眾地圖」頁面產出的洞察報告（insight_reports.report JSON）轉成一份可下載、
// 可離線保存或寄送客戶的 Word 文件。
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

const REVIEW_STATUS_LABEL = { unreviewed: '未複核', confirmed: '已確認', edited: '已確認．已修改', rejected: '已駁回' };
const SOURCE_LABEL = { user_input: '手動輸入', ai_suggested: 'AI 建議', raw_feedback_extraction: '語料萃取', swipe_import: '文案手法庫帶入' };

function pct(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 100) + '%';
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

function statsTable(D, rows) {
  const cell = (text, isHeader) => new D.TableCell({
    width: { size: 50, type: D.WidthType.PERCENTAGE },
    shading: isHeader ? { type: D.ShadingType.CLEAR, fill: 'F2F2F2' } : undefined,
    children: [new D.Paragraph({ children: [new D.TextRun({ text: String(text), bold: !!isHeader })] })],
  });
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) => new D.TableRow({ children: [cell(label, true), cell(value, false)] })),
  });
}

function painPointSection(D, p) {
  const paras = [
    heading(D, p.surface_problem || '（未命名痛點）', D.HeadingLevel.HEADING_3),
    bodyText(D, `深層渴望：${p.deep_desire || '—'}`),
  ];
  if (p.detail) paras.push(bodyText(D, p.detail, { italics: true }));

  const metaLine = [
    `來源：${SOURCE_LABEL[p.source] || p.source || '—'}`,
    `複核狀態：${REVIEW_STATUS_LABEL[p.review_status] || p.review_status || '—'}`,
    `語料佐證：${p.evidence_count || 0} 則`,
    `置信度：${pct(p.confidence_score)}`,
  ].join('　｜　');
  paras.push(bodyText(D, metaLine, { color: '555555' }));

  if (p.solution) {
    paras.push(bodyText(D, `對應解決方案：${p.solution.product_name}（${p.solution.core_selling_point || '—'}）`));
  } else {
    paras.push(bodyText(D, '尚未配對解決方案', { color: '999999' }));
  }

  if (p.ad_performance) {
    const ad = p.ad_performance;
    paras.push(bodyText(D,
      `真實廣告成效已驗證：CTR ${pct(ad.weighted_ctr)}｜CPA ${ad.weighted_cpa ?? '—'}｜CVR ${pct(ad.weighted_cvr)}` +
      (ad.weighted_roas != null ? `｜ROAS ${ad.weighted_roas}` : '') +
      `（依 ${ad.sample_size} 則廣告換算${ad.low_confidence ? '，樣本數過少僅供初步參考' : ''}）`,
      { color: '2f6f3e' }
    ));
  } else {
    paras.push(bodyText(D, '尚無對應的真實廣告成效數據，目前僅有語料佐證。', { color: '999999' }));
  }

  return paras;
}

async function buildReportDocx(report, meta) {
  let D;
  try {
    D = await loadDocx();
  } catch (err) {
    throw new Error('無法載入 Word 文件產生套件（docx），請確認專案已安裝該套件並重新部署：' + err.message);
  }

  const dp = report.domain_profile || {};
  const audiences = Array.isArray(dp.audiences) ? dp.audiences.join('、') : '（未設定）';
  const c = report.coverage || {};

  const children = [
    new D.Paragraph({
      children: [new D.TextRun({ text: '潛在受眾洞察報告', bold: true, size: 44 })],
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new D.Paragraph({
      children: [new D.TextRun({ text: `${dp.domain_tag || ''}／${audiences}${meta ? '　｜　' + meta : ''}`, color: '666666' })],
      alignment: D.AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
  ];

  if (dp.business_constraints) {
    children.push(bodyText(D, `呈現媒介限制：${dp.business_constraints}`, { color: '666666' }));
  }

  children.push(heading(D, '導讀', D.HeadingLevel.HEADING_2));
  children.push(bodyText(D, report.narrative || 'AI 導讀暫時無法產生，以下數據統計仍完整可用。'));

  children.push(heading(D, '覆蓋率統計', D.HeadingLevel.HEADING_2));
  children.push(statsTable(D, [
    ['痛點總數', c.total_pain_points ?? 0],
    ['有語料佐證', c.with_evidence ?? 0],
    ['已人工確認', c.confirmed ?? 0],
    ['尚未複核', c.unreviewed ?? 0],
    ['已駁回', c.rejected ?? 0],
    ['已配對解決方案', c.with_matched_solution ?? 0],
    ['平均置信度', pct(c.avg_confidence_score)],
    ['已有真實廣告成效驗證', c.with_ad_performance ?? 0],
  ]));

  if (Array.isArray(report.risk_flags) && report.risk_flags.length) {
    children.push(heading(D, '風險提示', D.HeadingLevel.HEADING_2));
    children.push(...bulletList(D, report.risk_flags));
  }

  if (Array.isArray(report.ad_performance_highlights) && report.ad_performance_highlights.length) {
    children.push(heading(D, '廣告成效亮點', D.HeadingLevel.HEADING_2));
    children.push(...bulletList(D, report.ad_performance_highlights));
  }

  if (report.framework_recommendation) {
    children.push(heading(D, '框架建議', D.HeadingLevel.HEADING_2));
    children.push(bodyText(D, `${report.framework_recommendation.name} — ${report.framework_recommendation.reason}`));
  }

  const points = Array.isArray(report.pain_points) ? report.pain_points : [];
  children.push(heading(D, '受眾痛點逐項分析', D.HeadingLevel.HEADING_2));
  if (!points.length) {
    children.push(bodyText(D, '此產品/服務設定尚無痛點資料。', { color: '999999' }));
  } else {
    points.forEach(p => children.push(...painPointSection(D, p)));
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
