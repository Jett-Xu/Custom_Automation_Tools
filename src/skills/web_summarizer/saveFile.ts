import { GeminiAIService } from "../../services/ai/gemini.js";

/**
 * 簡易的 HTML 清洗工具，移除不需要的標籤，避免浪費 Token
 */
function stripHtml(html: string) {
  return html
    .replace(/<script[^>]*>([\S\s]*?)<\/script>/gmi, '') // 移除 script
    .replace(/<style[^>]*>([\S\s]*?)<\/style>/gmi, '')   // 移除 style
    .replace(/<\/?[^>]+(>|$)/g, " ")                     // 移除 HTML tag
    .replace(/\s+/g, ' ')                                // 壓縮多餘空白
    .trim();
}

/**
 * Executor 進入點
 * Orchestrator 在使用 AI 解析出 URL 之後，會將結果傳給這裡的 content
 */
export async function execute(content: string) {
  const url = content.trim();

  // 1. 防呆檢查：確認 AI 提取出的是真的網址
  if (!url.startsWith('http')) {
    return '無法自動識別網址。請確認對話中是否包含完整的 http 或 https 連結！';
  }

  try {
    // 2. 向外發送真實的 HTTP 請求 (爬蟲核心)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP 錯誤狀態碼: ${response.status}`);
    }

    const htmlText = await response.text();
    
    // 簡易清洗 HTML，並截取前 30,000 字元避免過長爆發 Token
    const cleanText = stripHtml(htmlText).substring(0, 30000); 

    // 3. 在執行期實例化 AI Service 進行文意總結 (運用了 DI 原則的高解耦性)
    const aiBrain = new GeminiAIService();
    const systemPrompt = `你是一個專業的內容摘要工具。請閱讀以下我為你爬取的網頁內文，並整理出：
1. 💡 【一句話總結主旨】
2. 📌 【核心重點】 (請用 Bullet points 條列 3-5 點)
3. 🎯 【個人見解或行動建議】 (給出簡短的洞察)

請排版清爽易讀，並固定使用繁體中文回覆。`;

    // 4. 請 AI 做最後的歸納與輸出
    const summary = await aiBrain.ask(cleanText, systemPrompt);
    
    return `🌐 **網頁爬取成功並已為您彙整**\n🔗 來源: ${url}\n\n${summary}`;

  } catch (error) {
    console.error("爬蟲錯誤:", error);
    return `無法讀取該網頁內容，可能是該網站有阻擋簡易爬蟲機制。錯誤訊息: ${error instanceof Error ? error.message : "未知錯誤"}`;
  }
}
