import axios from 'axios';
import Parser from 'rss-parser';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// الحد الأقصى لعمر الخبر بالساعات (مثلاً أخبار آخر 24 ساعة فقط)
const MAX_NEWS_AGE_HOURS = 24;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// مصادر إخبارية عربية موثوقة
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/arabic/sport/rss.xml',
  'https://www.skynewsarabia.com/web/rss/sport.xml',
  'https://arabic.rt.com/rss/sport/'
];

// استبعاد الرياضات الأخرى والمحتوى غير المناسب
const BLACKLIST_KEYWORDS = [
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى',
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست', 'كاريكاتير'
];

// كلمات تدل على كرة القدم
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

  const hasBlacklisted = BLACKLIST_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
  if (hasBlacklisted) return false;

  return FOOTBALL_KEYWORDS.some(word => cleanTitle.includes(word.toLowerCase()));
}

function calculateScore(title) {
  const cleanTitle = title.toLowerCase();
  let score = 0;

  const priorityTerms = ['ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 'دوري أبطال', 'صفقة', 'رسمياً'];
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
        
        // حساب عمر الخبر بالساعات
        const ageInHours = (now - articleDate.getTime()) / (1000 * 60 * 60);

        // 1. استبعاد أي خبر أقدم من 24 ساعة
        if (ageInHours > MAX_NEWS_AGE_HOURS) {
          continue;
        }

        // 2. التحقق من عدم إرساله مسبقاً وتوافقه مع معايير كرة القدم
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

  // الترتيب: الأحدث أولاً، وإذا تساوى الوقت تقريباً يتم تقديم الأخبار الأهم
  candidates.sort((a, b) => {
    // إذا كان فارق التوقيت كبيراً (أكثر من ساعتين)، فالأحدث له الأولوية
    const timeDiffHours = (b.pubDate - a.pubDate) / (1000 * 60 * 60);
    if (Math.abs(timeDiffHours) >= 2) {
      return b.pubDate - a.pubDate;
    }
    // إذا كانت الأخبار متقاربة زمنياً، يتم الاعتماد على قوة الخبر
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.pubDate - a.pubDate;
  });

  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] جاري فحص أهم وأحدث أخبار كرة القدم...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط المتغيرات البيئية.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار جديدة خلال الـ 24 ساعة الماضية.');
    return;
  }

  let message = `⚽ <b>أهم وأحدث أخبار كرة القدم الآن:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">قراءة الخبر كاملاً</a>\n\n`;
  });

  await sendTelegramMessage(message);
  console.log('تم إرسال الأخبار الحديثة بنجاح.');

  if (sentArticles.size > 200) {
    const arr = Array.from(sentArticles);
    arr.splice(0, 100);
    sentArticles.clear();
    arr.forEach(id => sentArticles.add(id));
  }
}

// تشغيل عند بدء التشغيل
runNewsJob();

// تكرار كل ساعة
cron.schedule('0 * * * *', () => {
  runNewsJob();
});
