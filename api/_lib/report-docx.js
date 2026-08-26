// 受眾分析報告 Word 匯出器：只輸出受眾潛在痛點列表與潛在受眾地圖。
// 使用保守的 OOXML 結構，避免不同版本的 Microsoft Word 因頁碼欄位或複雜樣式而拒絕開啟。
let docxLibPromise = null;
function loadDocx() {
  if (!docxLibPromise) docxLibPromise = import('docx');
  return docxLibPromise;
}

const FONT = 'Microsoft JhengHei';

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

function heading(D, text) {
  return new D.Paragraph({
    children: [run(D, text, { bold: true, color: '1E4936', size: 30 })],
    spacing: { before: 260, after: 140, line: 320 },
    keepNext: true,
  });
}

function card(D, paragraphs) {
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
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

function segmentCard(D, segment, index, painPointMap) {
  const content = [cardTitle(D, `受眾 ${index + 1}：${segment.segment_name || '未命名族群'}`)];
  if (segment.description) content.push(paragraph(D, segment.description, { after: 90 }));
  if (segment.rationale) content.push(paragraph(D, `為什麼這些痛點特別打中他們：${segment.rationale}`, { color: '5B6862', after: 90 }));
  if (segment.differentiation) content.push(paragraph(D, `與目標受眾的差異：${segment.differentiation}`, { color: '5B6862', after: 90 }));

  const ids = Array.isArray(segment.matched_pain_point_ids) ? segment.matched_pain_point_ids : [];
  const matched = ids.map(id => painPointMap.get(id)).filter(Boolean);
  if (matched.length) content.push(paragraph(D, `對應的痛點：${matched.join('、')}`, { color: '2F6F3E', after: 90 }));

  const formats = Array.isArray(segment.suggested_formats) ? segment.suggested_formats : [];
  if (formats.length) {
    content.push(paragraph(D, '適合的數位資產形式：', { bold: true, color: '315F4A', after: 50 }));
    formats.forEach(item => content.push(paragraph(D, `${item.format || ''}${item.reason ? ' — ' + item.reason : ''}`, { after: 45 })));
  }
  return card(D, content);
}

async function buildReportDocx(data, meta) {
  let D;
  try { D = await loadDocx(); }
  catch (err) { throw new Error('無法載入 Word 文件產生套件：' + err.message); }

  const profile = data.domain_profile || {};
  const audiences = Array.isArray(profile.audiences) && profile.audiences.length ? profile.audiences.join('、') : '未設定';
  const painPoints = Array.isArray(data.pain_points) ? data.pain_points : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const painPointMap = new Map(painPoints.map(point => [point.id, point.surface_problem]));

  const children = [
    paragraph(D, '受眾分析報告', { bold: true, color: '18332B', size: 40, alignment: D.AlignmentType.CENTER, after: 100 }),
    paragraph(D, `${profile.domain_tag || '未設定領域'}　｜　${audiences}`, { color: '64736B', alignment: D.AlignmentType.CENTER, after: 50 }),
    paragraph(D, meta || '', { color: '8A948F', size: 18, alignment: D.AlignmentType.CENTER, after: 260 }),
    heading(D, '一、受眾潛在痛點列表'),
  ];

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
  children.push(heading(D, '二、潛在受眾地圖'));
  if (!segments.length) {
    children.push(paragraph(D, '目前尚無潛在受眾分析結果。', { color: '8A948F' }));
  } else {
    segments.forEach((segment, index) => {
      children.push(segmentCard(D, segment, index, painPointMap));
      children.push(paragraph(D, '', { after: 100 }));
    });
  }

  const document = new D.Document({
    creator: '受眾策略引擎',
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
