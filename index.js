import axios from 'axios';
import Parser from 'rss-parser';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_NEWS_AGE_HOURS = 24;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/arabic/sport/rss.xml',
  'https://www.skynewsarabia.com/web/rss/sport.xml',
  'https://arabic.rt.com/rss/sport/'
];

// كلمات استبعاد صارمة للأخبار السياسية، الحوادث، والرياضات الأخرى
const BLACKLIST_KEYWORDS = [
  // حوادث وأخبار عامة (لمنع تسرب الأخبار العاجلة السياسية)
  'مقتل', 'قتلى', 'ضحايا', 'انفجار', 'حادث', 'اغتيال', 'صاروخ', 
  'غارة', 'قصف', 'شرطة', 'جيش', 'مسجد', 'زلزال', 'حريق', 'محاكمة',
  // رياضات أخرى
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى',
  // محتوى غير مناسب
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست', 'كاريكاتير'
];

// كلمات مخصصة لكرة القدم حصراً
const FOOTBALL_KEYWORDS = [
  'كرة القدم', 'دوري أبطال', 'الدوري الإنجليزي', 'الدوري الإسباني', 'الدوري الإيطالي',
  'الدوري الألماني', 'الدوري الفرنسي', 'البريميرليغ', 'الليغا', 'الكالتشيو', 'البوندسليغا',
  'كأس العالم', 'ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 'تشيلسي',
  'مانشستر يونايتد', 'بايرن ميونخ', 'باريس سان جيرمان', 'يوفنتوس', 'إنتر ميلان',
  'فيفا', 'يويفا', 'الكرة الذهبية', 'هاتريك', 'ركلة جزاء', 'سوق الانتقالات',
  'مبابي', 'فينيسيوس', 'هالاند', 'صلاح', 'ميسي', 'رونالدو', 'لامين جمال', 'هاري كين'
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

  // 1. استبعاد فوري إذا وُجدت أي كلمة سياسية أو حادث أو رياضة أخرى
  const hasBlacklisted = BLACKLIST_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
  if (hasBlacklisted) return false;

  // 2. التحقق من وجود كلمة كرة قدم صريحة لا تحتمل اللبس
  const isFootball = FOOTBALL_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
  return isFootball;
}

function calculateScore(title) {
  const cleanTitle = title.toLowerCase();
  let score = 0;

  const priorityTerms = [
    'ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 
    'دوري أبطال', 'الكرة الذهبية', 'رسمياً', 'صفقة'
  ];

  priorityTerms.forEach(term => {
    if (cleanTitle.includes(term.toLowerCase())) score += 2;
  });

  return score;
}

async function fetchTopFootballNews() {
  const candidates = [];
  const now = Date.now();

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);

      for (const item of feed.items) {
        const id = item.guid || item.link;
        const title = item.title?.trim() || '';
        const articleDate = new Date(item.pubDate || item.isoDate || now);
        
        const ageInHours = (now - articleDate.getTime()) / (1000 * 60 * 60);

        if (ageInHours > MAX_NEWS_AGE_HOURS) {
          continue;
        }

        if (!sentArticles.has(id) && isValidFootballNews(title)) {
          candidates.push({
            id: id,
            title: title,
            link: item.link,
            score: calculateScore(title),
            pubDate: articleDate
          });
        }
      }
    } catch (err) {
      console.error(`تعذر جلب الخلاصة من ${feedUrl}:`, err.message);
    }
  }

  candidates.sort((a, b) => {
    const timeDiffHours = (b.pubDate - a.pubDate) / (1000 * 60 * 60);
    if (Math.abs(timeDiffHours) >= 2) {
      return b.pubDate - a.pubDate;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.pubDate - a.pubDate;
  });

  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] جاري فحص الأخبار بالفلترة الصارمة...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط المتغيرات البيئية.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار جديدة مطابقة للشروط حالياً.');
    return;
  }

  let message = `⚽ <b>أهم وأحدث أخبار كرة القدم الآن:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">قراءة الخبر كاملاً</a>\n\n`;
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
