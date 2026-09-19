import fs from 'fs';
import path from 'path';
import axios from 'axios';
import Parser from 'rss-parser';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MAX_NEWS_AGE_HOURS = 12;
const DB_FILE = path.resolve('sent_news.json');

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// خلاصات موثوقة ونظيفة
const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/arabic/sport/rss.xml',
  'https://www.skynewsarabia.com/web/rss/sport.xml'
];

// استبعاد الأخبار السياسية والاقتصادية والحوادث
const BLACKLIST_KEYWORDS = [
  'نفط', 'أسعار النفط', 'اقتصاد', 'بورصة', 'أسهم', 'دولار', 'تضخم',
  'مورغان', 'ترامب', 'بايدن', 'بوتين', 'إيران', 'حرب', 'صاروخ', 'قصف',
  'غارة', 'مقتل', 'قتلى', 'ضحايا', 'انفجار', 'حادث', 'اغتيال', 'شرطة',
  'جيش', 'مسجد', 'زلزال', 'حريق', 'محاكمة', 'انتخابات', 'حكومة', 'رئيس الوزراء',
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى',
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست'
];

const TRANSFER_KEYWORDS = [
  'صفقة', 'صفقات', 'انتقال', 'انتقالات', 'ميركاتو', 'تعاقد', 'يتعاقد',
  'وقع مع', 'يوقع مع', 'وقع رسمياً', 'يوقع رسمياً', 'توقيع عقد', 'عقد جديد',
  'شرط جزائي', 'تمديد عقد', 'يجدد عقده', 'إعارة', 'رحيل', 'يقترب من الانتقال',
  'مفاوضات لضم', 'سوق الانتقالات'
];

const RESULTS_KEYWORDS = [
  'فوز', 'يفوز', 'انتصار', 'هزيمة', 'يسحق', 'يكتسح', 'يتعادل', 'تعادل',
  'أهداف', 'هدف', 'هاتريك', 'ثنائية', 'ركلات ترجيح', 'ريمونتادا',
  'يتأهل', 'تأهل', 'يقصي', 'صدارة', 'ترتيب الدوري', 'نهائي', 'نصف نهائي'
];

const TOP_TEAMS_AND_LEAGUES = [
  'ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 
  'مانشستر يونايتد', 'تشيلسي', 'بايرن ميونخ', 'باريس سان جيرمان',
  'يوفنتوس', 'إنتر ميلان', 'ميلان', 'الهلال', 'النصر', 'الاتحاد', 'الأهلي',
  'دوري أبطال أوروبا', 'البريميرليغ', 'الليغا', 'الدوري الإنجليزي', 'الدوري الإسباني'
];

// تحميل الأخبار المرسلة سابقاً من الملف المحلي لمنع التكرار نهائياً
function loadSentArticles() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      return new Set(JSON.parse(raw));
    }
  } catch (err) {
    console.error('خطأ في قراءة ملف sent_news.json:', err.message);
  }
  return new Set();
}

// حفظ المعرفات في الملف المحلي
function saveSentArticles(articlesSet) {
  try {
    const list = Array.from(articlesSet);
    const trimmed = list.slice(-200); // حفظ آخر 200 خبر فقط
    fs.writeFileSync(DB_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch (err) {
    console.error('خطأ في حفظ ملف sent_news.json:', err.message);
  }
}

const sentArticles = loadSentArticles();

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

// تلخيص تفاصيل الخبر كروياً باستخدام Gemini API
async function generateAISummary(title, snippet, category) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `أنت صحفي رياضي متخصص وخبير في كرة القدم الأوروبية والعالمية.
لدينا الخبر التالي:
- التصنيف: ${category}
- العنوان: ${title}
- التفاصيل المتوفرة: ${snippet || title}

المطلوب:
اكتب ملخصاً دقيقاً في سطرين فقط باللغة العربية لعشاق الكرة:
- إذا كان انتقالاً: اذكر اللاعب، الناديين، وتفاصيل العقد/المبلغ المالي إن وجدت.
- إذا كانت مباراة: اذكر النتيجة النهائية، مسجلي الأهداف أو النقطة المفصلية.
- اكتب الملخص مباشرة دون أي مقدمات أو علامات ترحيب.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    return response.text?.trim();
  } catch (err) {
    console.error('فشل التلخيص بالذكاء الاصطناعي:', err.message);
    return null;
  }
}

function classifyAndScore(title) {
  const cleanTitle = title.toLowerCase();

  const isBlacklisted = BLACKLIST_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isBlacklisted) return null;

  let score = 0;
  let category = '';

  const isTransfer = TRANSFER_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isTransfer) {
    score += 4;
    category = 'انتقالات 🔄';
  }

  const isResult = RESULTS_KEYWORDS.some(w => cleanTitle.includes(w.toLowerCase()));
  if (isResult) {
    score += 4;
    category = 'نتائج ومباريات ⚽';
  }

  if (!isTransfer && !isResult) return null;

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
        const snippet = item.contentSnippet?.trim() || item.content?.trim() || '';
        const articleDate = new Date(item.pubDate || item.isoDate || now);
        
        const ageInHours = (now - articleDate.getTime()) / (1000 * 60 * 60);
        if (ageInHours > MAX_NEWS_AGE_HOURS) continue;

        if (!sentArticles.has(id)) {
          const analysis = classifyAndScore(title);
          if (analysis) {
            candidates.push({
              id: id,
              title: title,
              snippet: snippet,
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

  candidates.sort((a, b) => {
    const timeDiffHours = (b.pubDate - a.pubDate) / (1000 * 60 * 60);
    if (Math.abs(timeDiffHours) >= 2) return b.pubDate - a.pubDate;
    return b.score - a.score;
  });

  return candidates.slice(0, 3);
}

async function runNewsJob() {
  console.log(`[${new Date().toISOString()}] بدء فحص وتلخيص جديد الكرة...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('تأكد من ضبط متغيرات التليجرام في البيئة.');
    return;
  }

  const selectedNews = await fetchTopFootballNews();

  if (selectedNews.length === 0) {
    console.log('لا توجد صفقات أو نتائج جديدة لإرسالها.');
    return;
  }

  let message = `🔥 <b>جديد الانتقالات ونتائج الكرة:</b>\n\n`;

  for (let i = 0; i < selectedNews.length; i++) {
    const news = selectedNews[i];
    sentArticles.add(news.id);

    // تلخيص الخبر عبر الذكاء الاصطناعي
    const summary = await generateAISummary(news.title, news.snippet, news.category);

    message += `<b>${i + 1}. [${news.category}] ${news.title}</b>\n`;
    if (summary) {
      message += `📌 <i>${summary}</i>\n`;
    }
    message += `🔗 <a href="${news.link}">التفاصيل الكاملة</a>\n\n`;
  }

  // حفظ المعرفات في ملف JSON بشكل دائم
  saveSentArticles(sentArticles);

  await sendTelegramMessage(message);
  console.log(`تم إرسال وتلخيص ${selectedNews.length} أخبار بنجاح.`);
}

runNewsJob();

cron.schedule('0 * * * *', () => {
  runNewsJob();
});
