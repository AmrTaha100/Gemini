import axios from 'axios';
import Parser from 'rss-parser';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// خلاصات موثوقة مخصصة لكرة القدم العالمية فقط
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/sport/football/rss.xml',
  'https://www.skysports.com/rss/12040' // Sky Sports Football
];

// تخزين المعرفات لتفادي تكرار إرسال نفس الخبر
const sentArticles = new Set();

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
  } catch (error) {
    console.error('خطأ أثناء إرسال رسالة التليجرام:', error.response?.data || error.message);
  }
}

async function fetchTopFootballNews() {
  const candidates = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      
      for (const item of feed.items) {
        const id = item.guid || item.link;
        if (!sentArticles.has(id)) {
          candidates.push({
            id: id,
            title: item.title?.trim(),
            link: item.link,
            pubDate: new Date(item.pubDate || Date.now())
          });
        }
      }
    } catch (err) {
      console.error(`تعذر جلب الخلاصة من ${feedUrl}:`, err.message);
    }
  }

  // ترتيب الأخبار من الأحدث للأقدم
  candidates.sort((a, b) => b.pubDate - a.pubDate);

  // اختيار أول 3 أخبار جديدة غير مكررة
  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] بدء جلب أخبار كرة القدم...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في المتغيرات البيئية.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار جديدة في هذه الساعة.');
    return;
  }

  let message = `⚽ <b>أهم أخبار كرة القدم الآن:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">قراءة الخبر كاملاً</a>\n\n`;
  });

  await sendTelegramMessage(message);
  console.log('تم إرسال 3 أخبار بنجاح إلى تليجرام.');

  // تنظيف الذاكرة إذا زادت الأخبار المحفوظة عن 200 لمنع تسريب الذاكرة
  if (sentArticles.size > 200) {
    const arr = Array.from(sentArticles);
    arr.splice(0, 100);
    sentArticles.clear();
    arr.forEach(id => sentArticles.add(id));
  }
}

// تشغيل الفحص فور بدء السيرفر للتأكد من عمله
runNewsJob();

// الجدولة: تشغيل المهمة كل ساعة عند الدقيقة 0
cron.schedule('0 * * * *', () => {
  runNewsJob();
});

console.log('البوت قيد التشغيل ومجدول ليعمل كل ساعة.');
