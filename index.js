import axios from 'axios';
import Parser from 'rss-parser';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// نقبل الأخبار الحديثة فقط (آخر 12 ساعة) لضمان سرعة متابعة النتائج والصفقات
const MAX_NEWS_AGE_HOURS = 12;

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// مصادر إخبارية رياضية عربية سريعة التحديث
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/arabic/sport/rss.xml',
  'https://www.skynewsarabia.com/web/rss/sport.xml',
  'https://arabic.rt.com/rss/sport/'
];

// استبعاد أي رياضات أخرى أو حوادث عامة
const BLACKLIST_KEYWORDS = [
  'مقتل', 'قتلى', 'ضحايا', 'انفجار', 'حادث', 'اغتيال', 'صاروخ', 
  'غارة', 'قصف', 'شرطة', 'جيش', 'مسجد', 'زلزال', 'حريق', 'محاكمة',
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى',
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست'
];

// كلمات مفتاحية تركز على انتقالات اللاعبين
const TRANSFER_KEYWORDS = [
  'صفقة', 'صفقات', 'انتقال', 'انتقالات', 'ميركاتو', 'يوقع', 'وقع', 
  'تعاقد', 'يتعاقد', 'عرض رسمي', 'شرط جزائي', 'تمديد عقد', 'يجدد', 
  'إعارة', 'رحيل', 'يقترب من', 'مفاوضات', 'رسمياً'
];

// كلمات مفتاحية تركز على نتائج المباريات ومجرياتها
const RESULTS_KEYWORDS = [
  'فوز', 'يفوز', 'انتصار', 'هزيمة', 'يسحق', 'يكتسح', 'يتعادل', 'تعادل',
  'أهداف', 'هدف', 'هاتريك', 'ثنائية', 'ركلات ترجيح', 'ريمونتادا',
  'يتأهل', 'تأهل', 'يقصي', 'صدارة', 'ترتيب الدوري', 'نهائي', 'نصف نهائي'
];

// كبار الأندية والبطولات لزيادة أهمية الخبر
const TOP_TEAMS_AND_LEAGUES = [
  'ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 
  'مانشستر يونايتد', 'تشيلسي', 'بايرن ميونخ', 'باريس سان جيرمان',
  'يوفنتوس', 'إنتر ميلان', 'ميلان', 'الهلال', 'النصر', 'الاتحاد', 'الأهلي',
  'دوري أبطال أوروبا', 'البريميرليغ', 'الليغا', 'الدوري الإنجليزي', 'الدوري الإسباني'
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

function classifyAndScore(title) {
  const cleanTitle = title.toLowerCase();

  // 1. فلتر الاستبعاد
  const isBlacklisted = BLACKLIST_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isBlacklisted) return null;

  let score = 0;
  let category = 'عام';

  // هل هو خبر انتقالات؟
  const isTransfer = TRANSFER_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isTransfer) {
    score += 4;
    category = 'انتقالات 🔄';
  }

  // هل هو خبر نتائج وأهداف؟
  const isResult = RESULTS_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isResult) {
    score += 4;
    category = 'نتائج ومباريات ⚽';
  }

  // إذا لم يكن نتيجة ولا انتقال، نتجاهله لأنك حددت تفضيلك لهما
  if (!isTransfer && !isResult) {
    return null;
  }

  // دعم النتيجة إذا كان الخبر لنادٍ أو بطولة كبرى
  TOP_TEAMS_AND_LEAGUES.forEach(team => {
    if (cleanTitle.includes(team.toLowerCase())) score += 2;
  });

  return { score, category };
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

        if (ageInHours > MAX_NEWS_AGE_HOURS) continue;

        if (!sentArticles.has(id)) {
          const analysis = classifyAndScore(title);
          if (analysis) {
            candidates.push({
              id: id,
              title: title,
              link: item.link,
              score: analysis.score,
              category: analysis.category,
              pubDate: articleDate
            });
          }
        }
      }
    } catch (err) {
      console.error(`تعذر جلب الخلاصة من ${feedUrl}:`, err.message);
    }
  }

  // الترتيب: الأحدث أولاً، مع تقديم الأخبار القوية جداً
  candidates.sort((a, b) => {
    const timeDiffHours = (b.pubDate - a.pubDate) / (1000 * 60 * 60);
    if (Math.abs(timeDiffHours) >= 2) {
      return b.pubDate - a.pubDate;
    }
    return b.score - a.score;
  });

  // نأخذ حتى 3 أخبار ممتازة
  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] فحص الصفقات والنتائج الجديدة...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط المتغيرات البيئية.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد نتائج أو صفقات جديدة خلال هذه الساعة.');
    return;
  }

  let message = `🔥 <b>جديد الانتقالات ونتائج الكرة:</b>\n\n`;

  selectedNews.forEach((news, index) => {
    sentArticles.add(news.id);
    message += `<b>${index + 1}. [${news.category}] ${news.title}</b>\n`;
    message += `🔗 <a href="${news.link}">التفاصيل الكاملة</a>\n\n`;
  });

  await sendTelegramMessage(message);
  console.log(`تم إرسال ${selectedNews.length} أخبار بنجاح.`);

  if (sentArticles.size > 200) {
    const arr = Array.from(sentArticles);
    arr.splice(0, 100);
    sentArticles.clear();
    arr.forEach(id => sentArticles.add(id));
  }
}

// تجربة فورية عند الإقلاع
runNewsJob();

// الفحص كل ساعة بانتظام
cron.schedule('0 * * * *', () => {
  runNewsJob();
});
