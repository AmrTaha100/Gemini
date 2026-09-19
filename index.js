import fs from 'fs';
import path from 'path';
import axios from 'axios';
import Parser from 'rss-parser';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MAX_NEWS_AGE_HOURS = 36;

// تحديد مسار التخزين الدائم (Railway Volume)
const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/app/data') ? '/app/data' : '.');
const DB_FILE = path.resolve(VOLUME_DIR, 'sent_news.json');

const DEFAULT_FOOTBALL_IMAGE = 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=1200&q=80';

// قارئ الخلاصات بمهلة اتصال محددة
const parser = new Parser({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['enclosure', 'enclosure']
    ]
  }
});

const RSS_FEEDS = [
  'https://www.france24.com/ar/sport/rss',
  'https://www.skynewsarabia.com/web/rss/sport.xml',
  'https://www.hespress.com/sport/feed',
  'https://arabic.cnn.com/api/v1/rss/sport/rss.xml'
];

const BLACKLIST_KEYWORDS = [
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة', 'الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى', 'بيسبول',
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست', 'تمساح', 'العناية بالنباتات'
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

const FOOTBALL_ENTITIES = [
  'ريال مدريد', 'برشلونة', 'مانشستر سيتي', 'ليفربول', 'أرسنال', 
  'مانشستر يونايتد', 'تشيلسي', 'بايرن ميونخ', 'باريس سان جيرمان',
  'يوفنتوس', 'إنتر ميلان', 'ميلان', 'الهلال', 'النصر', 'الاتحاد', 'الأهلي',
  'دوري أبطال أوروبا', 'البريميرليغ', 'الليغا', 'الدوري الإنجليزي', 'الدوري الإسباني',
  'صلاح', 'محمد صلاح', 'رونالدو', 'ميسي', 'مبابي', 'هالاند', 'يامال', 'فينيسيوس',
  'كرة القدم', 'المونديال', 'كأس العالم', 'قمة', 'مواجهة'
];

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadSentArticles() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')));
    }
  } catch (err) {
    console.error('خطأ في قراءة ملف التخزين الدائم:', err.message);
  }
  return new Set();
}

function saveSentArticles(articlesSet) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const list = Array.from(articlesSet);
    fs.writeFileSync(DB_FILE, JSON.stringify(list.slice(-300), null, 2), 'utf-8');
    console.log(`تم حفظ قاعدة البيانات بنجاح في: ${DB_FILE}`);
  } catch (err) {
    console.error('خطأ في كتابة ملف التخزين الدائم:', err.message);
  }
}

const sentArticles = loadSentArticles();

function extractRssImageUrl(item) {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url;
  if (item['media:content']?.$?.url) return item['media:content'].$.url;

  const htmlContent = item.content || item.description || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1] && imgMatch[1].startsWith('http')) return imgMatch[1];

  return DEFAULT_FOOTBALL_IMAGE;
}

// سحب الصورة فائقة الدقة مع حدود لحجم الصفحة ومهلة انتظار
async function fetchHighResImageUrl(articleUrl, fallbackUrl) {
  try {
    const response = await axios.get(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 6000,
      maxContentLength: 3 * 1024 * 1024 // حظر تحميل الصفحات الأكبر من 3 ميجابايت
    });

    const html = response.data;
    const ogMatch = html.match(/<meta[^>]*property=["'](?:og:image|og:image:secure_url)["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og:image|og:image:secure_url)["']/i) ||
                    html.match(/<meta[^>]*name=["'](?:twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["']/i);

    if (ogMatch && ogMatch[1]) {
      return ogMatch[1].replace(/&amp;/g, '&');
    }
  } catch {
    // الرجوع للرابط البديل فوراً
  }

  if (fallbackUrl && fallbackUrl !== DEFAULT_FOOTBALL_IMAGE) {
    return fallbackUrl.replace(/\/thumbnail\//i, '/original/').replace(/_\d+x\d+\./i, '.');
  }

  return fallbackUrl;
}

// إرسال البطاقة والتحقق الحقيقي من التسليم مع ضبط طول الـ Caption
async function sendTelegramPhotoCard(photoUrl, caption, articleUrl) {
  const photoEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const messageEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  // التحقق من حد 1024 حرفاً في صور تليجرام
  let safeCaption = caption;
  if (safeCaption.length > 1000) {
    safeCaption = safeCaption.slice(0, 997) + '...';
  }

  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: '🌐 قراءة التفاصيل من المصدر',
          url: articleUrl
        }
      ]
    ]
  };

  try {
    await axios.post(photoEndpoint, {
      chat_id: CHAT_ID,
      photo: photoUrl,
      caption: safeCaption,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard
    }, { timeout: 10000 });
    return true;
  } catch (err) {
    console.error('فشل إرسال الصورة، جاري الإرسال كرسالة نصية:', err.response?.data?.description || err.message);
    try {
      await axios.post(messageEndpoint, {
        chat_id: CHAT_ID,
        text: safeCaption,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: inlineKeyboard
      }, { timeout: 10000 });
      return true;
    } catch (fallbackErr) {
      console.error('فشل الإرسال البديل أيضاً:', fallbackErr.response?.data?.description || fallbackErr.message);
      return false; // الإرسال فشل تماماً
    }
  }
}

async function generateAISummary(title, snippet, category) {
  if (!GEMINI_API_KEY) return null;

  // ترشيد استهلاك التوكنز وقص المقتطف الطويل
  const compactSnippet = (snippet || title).slice(0, 500);

  const prompt = `أنت صحفي رياضي خبير بكرة القدم.
الخبر:
- التصنيف: ${category}
- العنوان: ${title}
- التفاصيل: ${compactSnippet}

المطلوب:
اكتب ملخصاً دقيقاً في سطرين فقط باللغة العربية لعشاق الكرة (اللاعب/الناديين/المبلغ إن وجد، أو النتيجة ومسجلي الأهداف). ابدأ فوراً دون أي مقدمات أو ترحيب.`;

  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response.text()?.trim();
      if (text) return text;
    } catch (err) {
      console.warn(`تعذر التلخيص بنموذج ${modelName}:`, err.message || err);
    }
  }

  return null;
}

function classifyAndScore(title, snippet = '') {
  const cleanText = `${title} ${snippet}`.toLowerCase();

  if (BLACKLIST_KEYWORDS.some(w => cleanText.includes(w.toLowerCase()))) return null;

  let score = 0;
  let category = '';

  if (TRANSFER_KEYWORDS.some(w => cleanText.includes(w.toLowerCase()))) {
    score += 5;
    category = 'انتقالات 🔄';
  } else if (RESULTS_KEYWORDS.some(w => cleanText.includes(w.toLowerCase()))) {
    score += 5;
    category = 'نتائج ومباريات ⚽';
  } else if (FOOTBALL_ENTITIES.some(e => cleanText.includes(e.toLowerCase()))) {
    category = 'أخبار الكرة ⚽';
    score += 3;
  }

  if (!category) return null;

  FOOTBALL_ENTITIES.forEach(entity => {
    if (cleanText.includes(entity.toLowerCase())) score += 2;
  });

  return { score, category };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log(`[${new Date().toISOString()}] بدء فحص الأخبار بالنسخة الشاملة المحسنة...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('بيانات تليجرام مفقودة.');
    process.exit(1);
  }

  const candidates = [];
  const now = Date.now();

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);

      for (const item of feed.items) {
        const rawLink = item.link?.trim();
        // تجاهل العناصر بدون روابط صالحة لتفادي كسر أزرار تليجرام
        if (!rawLink || !rawLink.startsWith('http')) continue;

        const id = item.guid || rawLink;
        const title = item.title?.trim() || '';
        if (!title) continue;

        const snippet = item.contentSnippet?.trim() || item.content?.trim() || '';
        
        let articleDate = new Date(item.pubDate || item.isoDate || now);
        if (isNaN(articleDate.getTime())) {
          articleDate = new Date(now);
        }
        
        const ageInHours = (now - articleDate.getTime()) / (1000 * 60 * 60);
        if (ageInHours > MAX_NEWS_AGE_HOURS) continue;

        if (!sentArticles.has(id)) {
          const analysis = classifyAndScore(title, snippet);
          if (analysis) {
            candidates.push({
              id,
              title,
              snippet,
              link: rawLink,
              rawImageUrl: extractRssImageUrl(item),
              score: analysis.score,
              category: analysis.category,
              pubDate: articleDate
            });
          }
        }
      }
    } catch (err) {
      console.error(`خطأ أثناء جلب الخلاصة ${feedUrl}:`, err.message);
    }
  }

  candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.pubDate - a.pubDate);
  const selectedNews = candidates.slice(0, 3);

  if (selectedNews.length === 0) {
    console.log('لا توجد أخبار جديدة ومهمة في هذه الدورة. إنهاء العملية.');
    process.exit(0);
  }

  for (let i = 0; i < selectedNews.length; i++) {
    const news = selectedNews[i];

    const [highResImage, summary] = await Promise.all([
      fetchHighResImageUrl(news.link, news.rawImageUrl),
      generateAISummary(news.title, news.snippet, news.category)
    ]);

    const safeCategory = escapeHtml(news.category);
    const safeTitle = escapeHtml(news.title);
    const safeSummary = summary ? escapeHtml(summary) : '';

    let caption = `<b>${safeCategory} | ${safeTitle}</b>\n\n`;
    if (safeSummary) {
      caption += `📌 <i>${safeSummary}</i>`;
    }

    // إرسال البطاقة والتحقق من وصولها بنجاح قبل وضعها في قائمة الأخبار المرسلة
    const isSuccess = await sendTelegramPhotoCard(highResImage, caption, news.link);
    if (isSuccess) {
      sentArticles.add(news.id);
      console.log(`تم إرسال البطاقة التفاعلية بنجاح (${i + 1}/${selectedNews.length}): ${news.title}`);
    } else {
      console.warn(`تم تخطي حفظ الخبر لعدم تأكيد وصوله لتليجرام: ${news.title}`);
    }

    if (i < selectedNews.length - 1) {
      await sleep(1000);
    }
  }

  saveSentArticles(sentArticles);
  console.log(`اكتملت الدورة بنجاح.`);
  process.exit(0);
}

// تشغيل الدورة مع حماية شاملة من أي استثناء غير متوقع
run().catch(err => {
  console.error('فشل غير متوقع أثناء تشغيل البوت:', err);
  process.exit(1);
});
