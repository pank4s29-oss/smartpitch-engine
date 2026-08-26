// 受眾分析報告 Word 匯出器：只輸出受眾潛在痛點列表與潛在受眾地圖。
let docxLibPromise = null;
function loadDocx() {
  if (!docxLibPromise) docxLibPromise = import('docx');
  return docxLibPromise;
}

function run(D, text, opts = {}) {
  return new D.TextRun({
    text: String(text || ''),
    bold: !!opts.bold,
    italics: !!opts.italics,
    color: opts.color,
    size: opts.size || 22,
    font: opts.font || 'Microsoft JhengHei',
  });
}

function paragraph(D, text = '', opts = {}) {
  return new D.Paragraph({
    children: [run(D, text, opts)],
    alignment: opts.alignment,
    spacing: { before: opts.before || 0, after: opts.after === undefined ? 120 : opts.after, line: 300 },
    keepNext: !!opts.keepNext,
  });
}

function heading(D, text, level) {
  return new D.Paragraph({
    children: [run(D, text, { bold: true, color: '1E4936', size: level === D.HeadingLevel.HEADING_1 ? 30 : 26 })],
    heading: level,
    spacing: { before: level === D.HeadingLevel.HEADING_1 ? 360 : 240, after: 140 },
    keepNext: true,
  });
}

function card(D, paragraphs) {
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    layout: D.TableLayoutType ? D.TableLayoutType.FIXED : undefined,
    borders: {
      top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      left: { style: D.BorderStyle.SINGLE, size: 18, color: '3E7A5C' },
      right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4E1DA' },
      insideHorizontal: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [new D.TableRow({
      cantSplit: true,
      children: [new D.TableCell({
        shading: { type: D.ShadingType.CLEAR, fill: 'F6FAF7' },
        margins: { top: 180, bottom: 180, left: 220, right: 220 },
        children: paragraphs,
      })],
    })],
  });
}

function title(D, text) {
  return paragraph(D, text, { bold: true, color: '18332B', size: 25, after: 90, keepNext: true });
}

function painPointCard(D, p, index) {
  const body = [title(D, `痛點 ${index + 1}：${p.surface_problem || '未命名痛點'}`)];
  if (p.deep_desire) body.push(paragraph(D, `深層渴望：${p.deep_desire}`, { color: '315F4A', after: 90 }));
  if (p.detail) body.push(paragraph(D, p.detail, { italics: true, color: '5B6862', after: 0 }));
  return card(D, body);
}

function segmentCard(D, seg, index, painPointMap) {
  const body = [title(D, `受眾 ${index + 1}：${seg.segment_name || '未命名族群'}`)];
  if (seg.description) body.push(paragraph(D, seg.description, { after: 90 }));
  if (seg.rationale) body.push(paragraph(D, `為什麼這些痛點特別打中他們：${seg.rationale}`, { color: '5B6862', after: 90 }));
  if (seg.differentiation) body.push(paragraph(D, `與目標受眾的差異：${seg.differentiation}`, { color: '5B6862', after: 90 }));
  const ids = Array.isArray(seg.matched_pain_point_ids) ? seg.matched_pain_point_ids : [];
  const matched = ids.map(id => painPointMap.get(id)).filter(Boolean);
  if (matched.length) body.push(paragraph(D, `對應的痛點：${matched.join('、')}`, { color: '2F6F3E', after: 90 }));
  const formats = Array.isArray(seg.suggested_formats) ? seg.suggested_formats : [];
  if (formats.length) {
    body.push(paragraph(D, '適合的數位資產形式：', { bold: true, color: '315F4A', after: 50 }));
    formats.forEach(f => body.push(paragraph(D, `${f.format || ''}${f.reason ? ' — ' + f.reason : ''}`, { after: 45 })));
  }
  return card(D, body);
}

async function buildReportDocx(data, meta) {
  let D;
  try { D = await loadDocx(); }
  catch (err) { throw new Error('無法載入 Word 文件產生套件：' + err.message); }

  const dp = data.domain_profile || {};
  const audiences = Array.isArray(dp.audiences) && dp.audiences.length ? dp.audiences.join('、') : '未設定';
  const painPoints = Array.isArray(data.pain_points) ? data.pain_points : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const painPointMap = new Map(painPoints.map(p => [p.id, p.surface_problem]));

  const children = [
    paragraph(D, '受眾分析報告', { bold: true, color: '18332B', size: 40, alignment: D.AlignmentType.CENTER, after: 100 }),
    paragraph(D, `${dp.domain_tag || '未設定領域'}　｜　${audiences}`, { color: '64736B', alignment: D.AlignmentType.CENTER, after: 50 }),
    paragraph(D, meta || '', { color: '8A948F', size: 18, alignment: D.AlignmentType.CENTER, after: 260 }),
  ];

  children.push(heading(D, '一、受眾潛在痛點列表', D.HeadingLevel.HEADING_1));
  if (!painPoints.length) children.push(paragraph(D, '目前尚無已確認的受眾潛在痛點。', { color: '8A948F' }));
  else painPoints.forEach((p, i) => { children.push(painPointCard(D, p, i)); children.push(paragraph(D, '', { after: 100 })); });

  children.push(new D.Paragraph({ children: [], pageBreakBefore: true }));
  children.push(heading(D, '二、潛在受眾地圖', D.HeadingLevel.HEADING_1));
  if (!segments.length) children.push(paragraph(D, '目前尚無潛在受眾分析結果。', { color: '8A948F' }));
  else segments.forEach((seg, i) => { children.push(segmentCard(D, seg, i, painPointMap)); children.push(paragraph(D, '', { after: 100 })); });

  return D.Packer.toBuffer(new D.Document({
    creator: '受眾策略引擎',
    title: '受眾分析報告',
    description: '受眾潛在痛點列表與潛在受眾地圖',
    sections: [{
      properties: {
        page: { margin: { top: 900, right: 1000, bottom: 900, left: 1000 }, size: { orientation: D.PageOrientation.PORTRAIT, width: 11906, height: 16838 } },
      },
      headers: { default: new D.Header({ children: [paragraph(D, '受眾策略引擎　／　受眾分析報告', { color: '7A8881', size: 17, after: 0 })] }) },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [run(D, '— ', { color: '9AA59F', size: 17 }), new D.TextRun({ children: [D.PageNumber], size: 17, color: '9AA59F', font: 'Microsoft JhengHei' }), run(D, ' —', { color: '9AA59F', size: 17 })] })] }) },
      children,
    }],
    styles: {
      default: { document: { run: { font: 'Microsoft JhengHei', size: 22 }, paragraph: { spacing: { line: 300 } } } },
      paragraphStyles: [{ id: 'Normal', name: 'Normal', run: { font: 'Microsoft JhengHei', size: 22 }, paragraph: { spacing: { line: 300, after: 120 } } }],
    },
  }));
}

module.exports = { buildReportDocx };
