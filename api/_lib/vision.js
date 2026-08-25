// 共用的圖片輔助函式：驗證前端傳來的 base64 圖片，以及純 OCR 轉錄。
// 「直接分析圖片內容（不經過 OCR 文字）」的 prompt 因為跟各自的業務邏輯（語料 vs
// 文案手法庫）綁得比較緊，維持寫在呼叫端（raw-feedback-hub.js／swipe-copies-hub.js）
// 自己的檔案裡，這裡只放兩邊都會用到、跟業務邏輯無關的共用部分。
const { callVision } = require('./provider');

const MAX_BASE64_LENGTH = Math.ceil((6 * 1024 * 1024 * 4) / 3); // 約 6MB 原始檔案换算成 base64 後的長度上限
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// 前端傳來的圖片物件可能是 { data, media_type }，也可能是完整的
// data URL 字串（data:image/png;base64,xxxx）；這裡統一正規化成 { data, media_type }，
// 減少前端一定要自己拆 data URL 的負擔。
function normalizeImage(image) {
  if (!image) throw new Error('缺少圖片內容。');
  let data = image.data;
  let mediaType = image.media_type || image.mediaType;
  if (typeof image === 'string') data = image;
  if (typeof data === 'string' && data.startsWith('data:')) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match) throw new Error('圖片格式無法辨識（data URL 格式不正確）。');
    mediaType = mediaType || match[1];
    data = match[2];
  }
  if (!data || typeof data !== 'string') throw new Error('缺少圖片內容。');
  mediaType = (mediaType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new Error('不支援的圖片格式，請上傳 PNG／JPG／WEBP／GIF。');
  }
  if (data.length > MAX_BASE64_LENGTH) {
    throw new Error('圖片檔案過大，請壓縮或裁切後再上傳（單張上限約 6MB）。');
  }
  return { data, media_type: mediaType };
}

function normalizeImages(images, maxCount) {
  if (!Array.isArray(images) || !images.length) {
    throw new Error('請至少上傳一張圖片。');
  }
  if (images.length > maxCount) {
    throw new Error(`單次最多上傳 ${maxCount} 張圖片，請分批上傳。`);
  }
  return images.map(normalizeImage);
}

// 純 OCR：把圖片中看得到的文字逐字轉錄出來，不摘要、不改寫、不加評論。
// 用於「語料匯入」與「文案手法庫」兩邊的 OCR 模式——OCR 出來的文字之後都會走
// 各自既有的文字匯入流程（雜訊過濾/去重，或既有的文案分析），不在這裡重複那些邏輯。
async function ocrImageToText(image, { budgetMs } = {}) {
  const img = normalizeImage(image);
  const system = '你是專業的圖片文字辨識（OCR）工具。只需要把圖片中「看得到的文字」逐字轉錄出來，不要摘要、不要翻譯、不要加上任何說明、評論或 Markdown 格式。若畫面中有多則對話、留言或段落，依畫面由上到下、由左到右的閱讀順序轉錄，不同段落之間用換行分隔；不確定或模糊看不清的字，依上下文合理判斷即可，不要用「[看不清]」之類的標記中斷內容。若圖片中完全沒有可辨識的文字，只回傳空字串，不要輸出任何其他內容。';
  const prompt = '請轉錄這張圖片中的所有文字內容。';
  const text = await callVision({ system, prompt, images: [img], maxTokens: 2000, budgetMs });
  return (text || '').trim();
}

module.exports = { normalizeImage, normalizeImages, ocrImageToText, MAX_BASE64_LENGTH };
