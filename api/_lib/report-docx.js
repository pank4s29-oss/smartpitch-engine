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
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, ShadingType,
} = require('docx');

const REVIEW_STATUS_LABEL = { unreviewed: '未複核', confirmed: '已確認', edited: '已確認．已修改', rejected: '已駁回' };
const SOURCE_LABEL = { user_input: '手動輸入', ai_suggested: 'AI 建議', raw_feedback_extraction: '語料萃取', swipe_import: '文案手法庫帶入' };

function pct(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 100) + '%';
}

function heading(text, level) {
  return new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
}

function bodyText(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text: text || '', bold: !!opts.bold, italics: !!opts.italics, color: opts.color })],
    spacing: { after: 120 },
  });
}

function bulletList(items) {
  return items.map(t => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 80 } }));
}

function statsTable(rows) {
  const cell = (text, isHeader) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F2F2F2' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!isHeader })] })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) => new TableRow({ children: [cell(label, true), cell(value, false)] })),
  });
}

function painPointSection(p) {
  const paras = [
    heading(p.surface_problem || '（未命名痛點）', HeadingLevel.HEADING_3),
    bodyText(`深層渴望：${p.deep_desire || '—'}`),
  ];
  if (p.detail) paras.push(bodyText(p.detail, { italics: true }));

  const metaLine = [
    `來源：${SOURCE_LABEL[p.source] || p.source || '—'}`,
    `複核狀態：${REVIEW_STATUS_LABEL[p.review_status] || p.review_status || '—'}`,
    `語料佐證：${p.evidence_count || 0} 則`,
    `置信度：${pct(p.confidence_score)}`,
  ].join('　｜　');
  paras.push(bodyText(metaLine, { color: '555555' }));

  if (p.solution) {
    paras.push(bodyText(`對應解決方案：${p.solution.product_name}（${p.solution.core_selling_point || '—'}）`));
  } else {
    paras.push(bodyText('尚未配對解決方案', { color: '999999' }));
  }

  if (p.ad_performance) {
    const ad = p.ad_performance;
    paras.push(bodyText(
      `真實廣告成效已驗證：CTR ${pct(ad.weighted_ctr)}｜CPA ${ad.weighted_cpa ?? '—'}｜CVR ${pct(ad.weighted_cvr)}` +
      (ad.weighted_roas != null ? `｜ROAS ${ad.weighted_roas}` : '') +
      `（依 ${ad.sample_size} 則廣告換算${ad.low_confidence ? '，樣本數過少僅供初步參考' : ''}）`,
      { color: '2f6f3e' }
    ));
  } else {
    paras.push(bodyText('尚無對應的真實廣告成效數據，目前僅有語料佐證。', { color: '999999' }));
  }

  return paras;
}

function buildReportDocx(report, meta) {
  const dp = report.domain_profile || {};
  const audiences = Array.isArray(dp.audiences) ? dp.audiences.join('、') : '（未設定）';
  const c = report.coverage || {};

  const children = [
    new Paragraph({
      children: [new TextRun({ text: '潛在受眾洞察報告', bold: true, size: 44 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `${dp.domain_tag || ''}／${audiences}${meta ? '　｜　' + meta : ''}`, color: '666666' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
  ];

  if (dp.business_constraints) {
    children.push(bodyText(`呈現媒介限制：${dp.business_constraints}`, { color: '666666' }));
  }

  children.push(heading('導讀', HeadingLevel.HEADING_2));
  children.push(bodyText(report.narrative || 'AI 導讀暫時無法產生，以下數據統計仍完整可用。'));

  children.push(heading('覆蓋率統計', HeadingLevel.HEADING_2));
  children.push(statsTable([
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
    children.push(heading('風險提示', HeadingLevel.HEADING_2));
    children.push(...bulletList(report.risk_flags));
  }

  if (Array.isArray(report.ad_performance_highlights) && report.ad_performance_highlights.length) {
    children.push(heading('廣告成效亮點', HeadingLevel.HEADING_2));
    children.push(...bulletList(report.ad_performance_highlights));
  }

  if (report.framework_recommendation) {
    children.push(heading('框架建議', HeadingLevel.HEADING_2));
    children.push(bodyText(`${report.framework_recommendation.name} — ${report.framework_recommendation.reason}`));
  }

  const points = Array.isArray(report.pain_points) ? report.pain_points : [];
  children.push(heading('受眾痛點逐項分析', HeadingLevel.HEADING_2));
  if (!points.length) {
    children.push(bodyText('此產品/服務設定尚無痛點資料。', { color: '999999' }));
  } else {
    points.forEach(p => children.push(...painPointSection(p)));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: {
      default: { document: { run: { font: 'Microsoft JhengHei', size: 22 } } },
    },
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildReportDocx };
