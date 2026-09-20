import fs from 'fs';
import path from 'path';
import axios from 'axios';
import Parser from 'rss-parser';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID.trim() : '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MAX_NEWS_AGE_HOURS = 36;

const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/app/data') ? '/app/data' : '.');
const DB_FILE = path.resolve(VOLUME_DIR, 'sent_news.json');

const DEFAULT_FOOTBALL_IMAGE = 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=1200&q=80';

function sanitizeLog(text) {
  if (!text || typeof text !== 'string') return text;
  if (!BOT_TOKEN) return text;
  return text.replaceAll(BOT_TOKEN, '[REDACTED_TOKEN]');
}

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

function normalizeArabic(text) {
  if (!text) return '';
  return text
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[،؟؛!?,.:"'\-_()[\]{}]/g, ' ')
    .replace(/[^\w\s\u0600-\u06FF]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RAW_STOPWORDS = [
  'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'تم', 'بعد',
  'قبل', 'حيث', 'كل', 'وقد', 'قد', 'كان', 'كانت', 'يكون', 'ان', 'أن', 'إن',
  'التي', 'الذي', 'الذين', 'هو', 'هي', 'هم', 'ضد', 'بين', 'حول', 'خلال', 'نحو',
  'بسبب', 'أمام', 'امام', 'رسميا', 'رسمياً'
];

const ARABIC_STOPWORDS = new Set(RAW_STOPWORDS.map(w => normalizeArabic(w)));

const BLACKLIST_KEYWORDS = [
  'كرة السلة', 'كرة سلة', 'تنس', 'كرة اليد', 'كرة يد', 'كرة الطائرة', 'الطائرة',
  'فورمولا', 'سباق', 'ملاكمة', 'مصارعة', 'جودو', 'سباحة', 'ألعاب قوى', 'بيسبول',
  'بث مباشر', 'مشاهدة مباراة', 'كويز', 'بودكاست', 'تمساح', 'العناية بالنباتات',
  'الأرجنتين', 'الارجنتين', 'التانجو' // 👈 تم إضافة حظر الأرجنتين هنا
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

function matchKeyword(normalizedText, rawKeyword) {
  const normKeyword = normalizeArabic(rawKeyword).toLowerCase();
  if (normKeyword.includes(' ')) {
    return normalizedText.includes(normKeyword);
  }
  const regex = new RegExp(`(^|\\s)(?:ال)?${normKeyword}(?:\\s|$)`, 'i');
  return regex.test(normalizedText);
}

function getTextKeywords(title, snippet = '') {
  const text = `${title} ${snippet}`;
  if (!text.trim()) return new Set();
  const clean = normalizeArabic(text);
  return new Set(
    clean.split(' ').filter(w => w.length > 2 && !ARABIC_STOPWORDS.has(w))
  );
}

function isContentSimilar(titleA, snippetA, titleB, snippetB) {
  if (!titleA || !titleB) return false;

  const titleSetA = getTextKeywords(titleA);
  const titleSetB = getTextKeywords(titleB);

  let titleCommon = 0;
  for (const word of titleSetA) {
    if (titleSetB.has(word)) titleCommon++;
  }

  const titleDice = (2 * titleCommon) / (titleSetA.size + titleSetB.size || 1);
  if (titleDice >= 0.65) return true; 

  const fullSetA = getTextKeywords(titleA, snippetA);
  const fullSetB = getTextKeywords(titleB, snippetB);

  let fullCommon = 0;
  for (const word of fullSetA) {
    if (fullSetB.has(word)) fullCommon++;
  }

  const fullDice = (2 * fullCommon) / (fullSetA.size + fullSetB.size || 1);
  return fullDice >= 0.55; 
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isValidHttpUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function loadSentArticles() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        return data.map(item => (typeof item === 'string' ? { id: item, title: '', snippet: '' } : item));
      }
    }
  } catch (err) {
    console.error('خطأ في قراءة ملف التخزين الدائم:', sanitizeLog(err.message));
  }
  return [];
}

function saveSentArticles(articlesList) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(articlesList.slice(-300), null, 2), 'utf-8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('خطأ في كتابة ملف التخزين الدائم:', sanitizeLog(err.message));
  }
}

const sentArticles = loadSentArticles();
const sentIdsSet = new Set(sentArticles.map(a => a.id));

function isNewsAlreadySent(id, title, snippet) {
  if (sentIdsSet.has(id)) return true;
  const recentItems = sentArticles.slice(-60);
  return recentItems.some(sentItem => isContentSimilar(sentItem.title, sentItem.snippet || '', title, snippet));
}

function extractRssImageUrl(item) {
  if (item.enclosure?.url && item.enclosure.url.startsWith('http')) return item.enclosure.url;
  if (item.mediaContent?.$?.url && item.mediaContent.$.url.startsWith('http')) return item.mediaContent.$.url;

  const htmlContent = item.content || item.description || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1] && imgMatch[1].startsWith('http')) return imgMatch[1];

  return DEFAULT_FOOTBALL_IMAGE;
}

async function fetchHighResImageUrl(articleUrl, fallbackUrl) {
  try {
    const response = await axios.get(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 6000,
      maxContentLength: 3 * 1024 * 1024
    });

    const html = response.data;
    const ogMatch = html.match(/<meta[^>]*property=["'](?:og:image|og:image:secure_url)["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og:image|og:image:secure_url)["']/i) ||
                    html.match(/<meta[^>]*name=["'](?:twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["']/i);

    if (ogMatch && ogMatch[1]) {
      const candidate = ogMatch[1].replace(/&amp;/g, '&');
      if (isValidHttpUrl(candidate)) return candidate;
    }
  } catch {
    //
  }

  if (fallbackUrl && fallbackUrl !== DEFAULT_FOOTBALL_IMAGE) {
    return fallbackUrl.replace(/\/thumbnail\//i, '/original/').replace(/_\d+x\d+\./i, '.');
  }

  return fallbackUrl;
}

function buildSafeCaption(category, title, summary) {
  const safeCategory = escapeHtml(category);
  const safeTitle = escapeHtml(title);
  const header = `<b>${safeCategory} | ${safeTitle}</b>`;

  if (!summary) return header;

  const maxSummaryLen = 1000 - header.length - 25;
  let cleanSummary = summary.trim();

  if (cleanSummary.length > maxSummaryLen && maxSummaryLen > 30) {
    cleanSummary = cleanSummary.slice(0, maxSummaryLen).replace(/\s+\S*$/, '') + '...';
  }

  return `${header}\n\n📌 <i>${escapeHtml(cleanSummary)}</i>`;
}

async function sendTelegramPhotoCard(photoUrl, caption, articleUrl) {
  const photoEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const messageEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const hasValidUrl = isValidHttpUrl(articleUrl);
  const keyboard = hasValidUrl ? {
    inline_keyboard: [[{ text: '🌐 قراءة التفاصيل من المصدر', url: articleUrl }]]
  } : undefined;

  try {
    await axios.post(photoEndpoint, {
      chat_id: CHAT_ID,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_notification: true // تم الإضافة هنا
    }, { timeout: 10000 });
    return { success: true };
  } catch (err) {
    const errorStatus = err.response?.status;
    const errorDesc = err.response?.data?.description || err.message;
    console.error('فشل إرسال الصورة:', sanitizeLog(errorDesc));

    try {
      await axios.post(messageEndpoint, {
        chat_id: CHAT_ID,
        text: caption,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
        disable_notification: true // وتم الإضافة هنا
      }, { timeout: 10000 });
      return { success: true };
    } catch (fallbackErr) {
      try {
        await axios.post(messageEndpoint, {
          chat_id: CHAT_ID,
          text: caption,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          disable_notification: true // وتم الإضافة هنا
        }, { timeout: 10000 });
        return { success: true };
      } catch (finalErr) {
        console.error('فشل الإرسال النهائي:', sanitizeLog(finalErr.response?.data?.description || finalErr.message));
        const isPermanent = errorStatus === 400 || finalErr.response?.status === 400;
        return { success: false, permanentError: isPermanent };
      }
    }
  }
}

async function generateAISummary(title, snippet, category) {
  if (!GEMINI_API_KEY) return null;

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
      console.warn(`تعذر التلخيص بنموذج ${modelName}:`, sanitizeLog(err.message || String(err)));
    }
  }

  return null;
}

function classifyAndScore(title, snippet = '') {
  const rawText = `${title} ${snippet}`;
  const cleanText = normalizeArabic(rawText).toLowerCase();

  if (BLACKLIST_KEYWORDS.some(w => matchKeyword(cleanText, w))) return null;

  let score = 0;
  let category = '';

  if (TRANSFER_KEYWORDS.some(w => matchKeyword(cleanText, w))) {
    score += 5;
    category = 'انتقالات 🔄';
  } else if (RESULTS_KEYWORDS.some(w => matchKeyword(cleanText, w))) {
    score += 5;
    category = 'نتائج ومباريات ⚽';
  } else if (FOOTBALL_ENTITIES.some(e => matchKeyword(cleanText, e))) {
    category = 'أخبار الكرة ⚽';
    score += 3;
  }

  if (!category) return null;

  FOOTBALL_ENTITIES.forEach(entity => {
    if (matchKeyword(cleanText, entity)) score += 2;
  });

  return { score, category };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log(`[${new Date().toISOString()}] بدء فحص الأخبار بالنسخة الشاملة المحصنة...`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('بيانات تليجرام مفقودة.');
    process.exit(1);
  }

  const now = Date.now();

  const feedPromises = RSS_FEEDS.map(async (feedUrl) => {
    try {
      const feed = await parser.parseURL(feedUrl);
      return feed.items || [];
    } catch (err) {
      console.error(`خطأ أثناء جلب الخلاصة ${feedUrl}:`, sanitizeLog(err.message));
      return [];
    }
  });

  const allFeedsItems = await Promise.all(feedPromises);
  const candidates = [];

  for (const items of allFeedsItems) {
    for (const item of items) {
      const rawLink = item.link?.trim();
      if (!rawLink || !isValidHttpUrl(rawLink)) continue;

      const id = item.guid || rawLink;
      const title = item.title?.trim() || '';
      if (!title) continue;

      const snippet = item.contentSnippet?.trim() || item.content?.trim() || '';

      let articleDate = new Date(item.isoDate || item.pubDate || now);
      if (isNaN(articleDate.getTime())) articleDate = new Date(now);

      const ageInHours = (now - articleDate.getTime()) / (1000 * 60 * 60);
      if (ageInHours > MAX_NEWS_AGE_HOURS) continue;

      if (!isNewsAlreadySent(id, title, snippet)) {
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
  }

  candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.pubDate - a.pubDate);

  const selectedNews = [];
  for (const candidate of candidates) {
    const isDuplicateInBatch = selectedNews.some(sel => isContentSimilar(sel.title, sel.snippet, candidate.title, candidate.snippet));
    if (!isDuplicateInBatch) {
      selectedNews.push(candidate);
      if (selectedNews.length === 3) break;
    }
  }

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

    const caption = buildSafeCaption(news.category, news.title, summary);
    const result = await sendTelegramPhotoCard(highResImage, caption, news.link);

    if (result.success) {
      sentArticles.push({ id: news.id, title: news.title, snippet: news.snippet });
      sentIdsSet.add(news.id);
      saveSentArticles(sentArticles);
      console.log(`تم إرسال البطاقة التفاعلية بنجاح (${i + 1}/${selectedNews.length}): ${news.title}`);
    } else if (result.permanentError) {
      console.warn(`تم تجاوز الخبر وحفظه لتفادي تعطيل الطابور (خطأ دائم): ${news.title}`);
      sentArticles.push({ id: news.id, title: news.title, snippet: news.snippet });
      sentIdsSet.add(news.id);
      saveSentArticles(sentArticles);
    } else {
      console.warn(`تم تخطي حفظ الخبر لتعثر الإرسال المؤقت: ${news.title}`);
    }

    if (i < selectedNews.length - 1) {
      await sleep(1000);
    }
  }

  console.log(`اكتملت الدورة بنجاح.`);
  process.exit(0);
}

run().catch(err => {
  const errText = err?.stack || err?.message || String(err);
  console.error('فشل غير متوقع أثناء تشغيل البوت:', sanitizeLog(errText));
  process.exit(1);
});
