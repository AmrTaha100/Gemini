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

// خلاصات متخصصة في الدوريات والبطولات الأوروبية الكبرى فقط
const RSS_FEEDS = [
  'https://www.skysports.com/rss/11095',            // Sky Sports Premier League
  'https://www.theguardian.com/football/rss',       // The Guardian Football (تحليلات وأخبار قوية)
  'https://www.skysports.com/rss/12040'             // Sky Sports Football Top News
];

// كلمات يتم استبعاد الخبر فوراً إذا احتوى عليها (فواصل، مسابقات، شائعات فرعية)
const BLACKLIST_KEYWORDS = [
  'quiz', 'quizzes', 'gossip', 'podcast', 'round-up',
  'how to watch', 'live text', 'ratings', 'stream', 'anniversary'
];

// أندية وبطولات تعطي الخبر أولوية قصوى
const PRIORITY_KEYWORDS = [
  'champions league', 'premier league', 'la liga', 'real madrid',
  'barcelona', 'manchester city', 'liverpool', 'arsenal', 'chelsea',
  'bayern', 'psg', 'transfer', 'official', 'signed', 'injury'
];

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

function isHighValueArticle(title) {
  const lowerTitle = title.toLowerCase();

  // 1. استبعاد أي خبر ترفيهي أو غير إخباري
  const hasBlacklistedWord = BLACKLIST_KEYWORDS.some(kw => lowerTitle.includes(kw));
  if (hasBlacklistedWord) return false;

  return true;
}

function calculateScore(title) {
  const lowerTitle = title.toLowerCase();
  let score = 0;

  // إعطاء نقاط أعلى للأندية والبطولات الكبرى والأحداث المؤكدة
  PRIORITY_KEYWORDS.forEach(kw => {
    if (lowerTitle.includes(kw)) score += 2;
  });

  return score;
}

async function fetchTopFootballNews() {
  const candidates = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      
      for (const item of feed.items) {
        const id = item.guid || item.link;
        const title = item.title?.trim() || '';

        // التحقق من أن الخبر جديد ويجتاز معايير الأهمية
        if (!sentArticles.has(id) && isHighValueArticle(title)) {
          candidates.push({
            id: id,
            title: title,
            link: item.link,
            score: calculateScore(title),
            pubDate: new Date(item.pubDate || Date.now())
          });
        }
      }
    } catch (err) {
      console.error(`تعذر جلب الخلاصة من ${feedUrl}:`, err.message);
    }
  }

  // الترتيب حسب: الأهمية أولاً (الأندية والبطولات الكبرى)، ثم التوقيت
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.pubDate - a.pubDate;
  });

  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] جاري فحص واختيار أهم 3 أخبار...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط متغيرات البيئة.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار جديدة تنطبق عليها معايير الأهمية حالياً.');
    return;
  }

  let message = `⚽ <b>أهم 3 أخبار كرة قدم حالياً:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">قراءة التفاصيل</a>\n\n`;
  });

  await sendTelegramMessage(message);
  console.log('تم الإرسال بنجاح.');

  if (sentArticles.size > 200) {
    const arr = Array.from(sentArticles);
    arr.splice(0, 100);
    sentArticles.clear();
    arr.forEach(id => sentArticles.add(id));
  }
}

runNewsJob();

cron.schedule('0 * * * *', () => {
  runNewsJob();
});
