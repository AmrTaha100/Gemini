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

// مصادر إخبارية عربية موثوقة ومفتوحة
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/arabic/sport/rss.xml',      // بي بي سي عربي - رياضة
  'https://www.skynewsarabia.com/web/rss/sport.xml',     // سكاي نيوز عربية - رياضة
  'https://arabic.rt.com/rss/sport/'                     // RT Arabic - رياضة
];

// استبعاد الرياضات الأخرى والمحتوى غير الإخباري
const BLACKLIST_KEYWORDS = [
  // رياضات أخرى للتأكد من وصول كرة القدم فقط
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى',
  // محتوى ترفيهي أو غير مناسب كأخبار
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست', 'كاريكاتير'
];

// كلمات تدل على أهمية الخبر أو ارتباطه بكرة القدم
const FOOTBALL_KEYWORDS = [
  'كرة القدم', 'دوري', 'كأس', 'أبطال', 'ريال مدريد', 'برشلونة',
  'مانشستر سيتي', 'ليفربول', 'أرسنال', 'تشيلسي', 'بايرن ميونخ',
  'باريس سان جيرمان', 'مدرب', 'لاعب', 'صفقة', 'انتقال', 'إصابة',
  'فيفا', 'يويفا', 'البريميرليغ', 'الليغا', 'الكالتشيو'
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

function isValidFootballNews(title) {
  const cleanTitle = title.toLowerCase();

  // 1. استبعاد أي رياضة أخرى أو روابط البث
  const hasBlacklisted = BLACKLIST_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
  if (hasBlacklisted) return false;

  // 2. التحقق من وجود كلمة تدل بوضوح على كرة القدم
  const isFootball = FOOTBALL_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
  return isFootball;
}

function calculateScore(title) {
  const cleanTitle = title.toLowerCase();
  let score = 0;

  // أولوية مضاعفة لأخبار البطولات والأندية الكبرى
  const priorityTerms = ['ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 'دوري أبطال', 'صفقة', 'رسمياً'];
  priorityTerms.forEach(term => {
    if (cleanTitle.includes(term.toLowerCase())) score += 2;
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

        if (!sentArticles.has(id) && isValidFootballNews(title)) {
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

  // الترتيب حسب الأهمية ثم توقيت النشر
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.pubDate - a.pubDate;
  });

  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] جاري فحص أهم أخبار كرة القدم بالعربية...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط المتغيرات البيئية.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار كرة قدم جديدة تنطبق عليها الشروط حالياً.');
    return;
  }

  let message = `⚽ <b>أهم 3 أخبار كرة قدم الآن:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">قراءة الخبر كاملاً</a>\n\n`;
  });

  await sendTelegramMessage(message);
  console.log('تم إرسال الأخبار بنجاح.');

  if (sentArticles.size > 200) {
    const arr = Array.from(sentArticles);
    arr.splice(0, 100);
    sentArticles.clear();
    arr.forEach(id => sentArticles.add(id));
  }
}

// تشغيل تجريبي فوراً عند إقلاع السيرفر
runNewsJob();

// تكرار المهمة على رأس كل ساعة
cron.schedule('0 * * * *', () => {
  runNewsJob();
});
