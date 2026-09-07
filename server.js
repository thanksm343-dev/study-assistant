require('dns').setDefaultResultOrder('ipv4first'); 
            
const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const cron = require('node-cron'); 
const https = require('https'); 
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const Tesseract = require('tesseract.js'); // ✅ OCR
const OpenAI = require('openai'); // 🤖 استدعاء OpenAI

// ===================== 🤖 إعداد OpenAI Client =====================
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ===================== 🔄 إعداد ميزة إعادة المحاولة التلقائية =====================
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
               error.response?.status === 503 || 
               error.response?.status === 429;
    }
});

// ===================== 🎓 استدعاء ملفات الشعب الرسمية =====================
const allBacData = {};
const sections = ['math', 'technique', 'sciences', 'info', 'lettres', 'economie'];

sections.forEach(section => {
    try {
        allBacData[section] = require(`./bac-data/${section}`);
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            console.warn(`⚠️ تنبيه: لم يتم العثور على ملف الشعبة [./bac-data/${section}.js]`);
            allBacData[section] = [];
        } else {
            throw err;
        }
    }
});

const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// الحد الأقصى للمحاولات اليومية — 7 رسائل ناجحة، والثامنة توقف
const DAILY_LIMIT = 7; 
// الحد الأقصى لعداد الجلسة الواحدة (يشمل الصورة الأولى + الرسائل النصية) قبل طلب صورة جديدة
const MAX_MESSAGES_PER_SESSION = 3;

// 🆕 ===================== 💬 ردود الاقتراحات الجاهزة (بلا أي نداء OpenAI — 0 توكن) =====================
// كل مفتاح يقابل زر الاقتراح في الواجهة (تلخيص / امتحان / باكالوريا)
const SUGGESTION_REPLIES = {
    summary: `🖼️ ممتاز! اضغط على أيقونة 📎 بالأسفل وارفق صورة واضحة للدرس أو التمرين، وراح نلخصلك أهم المفاهيم، المعطيات الأساسية، ونقاط التركيز اللي لازم تراجعها قبل الامتحان.`,
    exam: `📝 تمام! ارفق صورة الامتحان من 📎 وبعدها راح نعطيك 3 خيارات: تصحيح خطوة بخطوة بالتفاعل، تصحيح كامل مباشرة مع الباريم، أو تمرين مشابه للتدرب.`,
    bac_mode: `🎓 رائع! اختر وضع "باكالوريا" من الأعلى، حدد شعبتك ومادتك، وارفق صورة موضوع باك سابق — ونشتغل عليه بنفس معايير التصحيح الرسمية بالضبط.`
};

// ===================== ✅ دالة مساعدة للتاريخ بتوقيت تونس =====================
function getTunisToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Tunis' });
}

// ===================== ✅ دالة OCR لاستخراج النص من الصورة =====================
async function extractTextFromImage(imageBase64) {
    try {
        const buffer = Buffer.from(imageBase64, 'base64');
        const { data: { text } } = await Tesseract.recognize(
            buffer,
            'fra+ara+eng', // فرنسي + عربي + إنجليزي
            { logger: () => {} } // إخفاء logs التقدم
        );
        const cleanText = text.trim();
        console.log(`📝 [OCR] نص مستخرج (${cleanText.length} حرف)`);
        return cleanText;
    } catch (err) {
        console.warn("⚠️ [OCR] فشل استخراج النص:", err.message);
        return null;
    }
}

// ===================== ✅ دالة فرض المصطلحات الفرنسية =====================
function enforceFrenchTerminology(text) {
    const translations = {
        'قابلة للتمديد بالاستمرارية': 'prolongeable par continuité',
        'قابل للتمديد بالاستمرارية': 'prolongeable par continuité',
        'التمديد بالاستمرارية': 'prolongement par continuité',
        'تمديد بالاستمرارية': 'prolongement par continuité',
        'التمديد': 'prolongement',
        'تمديد': 'prolongement',
        'قابلة للتمدد بالاستمرارية': 'prolongeable par continuité',
        'قابل للتمدد بالاستمرارية': 'prolongeable par continuité',
        'التمدد بالاستمرارية': 'prolongement par continuité',
        'تمدد بالاستمرارية': 'prolongement par continuité',
        'التمدد': 'prolongement',
        'تمدد': 'prolongement',
        'الامتداد بالاستمرارية': 'prolongement par continuité',
        'امتداد بالاستمرارية': 'prolongement par continuité',
        'الامتداد': 'prolongement',
        'امتداد': 'prolongement',
    };
    
    let result = text;
    for (const [arabic, french] of Object.entries(translations)) {
        result = result.split(arabic).join(french);
    }
    return result;
}

// ===================== ✅ دالة كشف لغة التمرين (فرنسي/عربي) =====================
function detectExamLanguage(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null; 
    }
    const arabicMatches = text.match(/[\u0600-\u06FF]/g) || [];
    const latinMatches = text.match(/[a-zA-Z]/g) || [];
    const arabicCount = arabicMatches.length;
    const latinCount = latinMatches.length;

    if (arabicCount === 0 && latinCount === 0) return null;
    if (arabicCount > latinCount) return 'Arabic';
    return 'French';
}

// ===================== FIREBASE INIT =====================
const firebaseAgent = new https.Agent({ family: 4, keepAlive: true });

admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json')),
    httpOptions: {
        timeout: 15000, 
        connectTimeout: 10000,
        agent: firebaseAgent
    }
});

const db = admin.firestore();

// ===================== MIDDLEWARE =====================
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

app.use((req, res, next) => {
    console.log("REQUEST:", req.method, req.url);
    next();
});

// ===================== CRON JOB =====================
cron.schedule('0 0 * * *', async () => {
    console.log("⏰ [CRON JOB] بدأت عملية خصم الأيام المتبقية وتحديث الأرصدة...");
    try {
        const now = new Date();
        const todayStr = getTunisToday();
        const usersSnapshot = await db.collection("users").get();

        if (usersSnapshot.empty) {
            console.log("ℹ️ لا يوجد مستخدمين لتحديثهم حالياً.");
            return;
        }

        const batch = db.batch(); 

        usersSnapshot.forEach((doc) => {
            const userData = doc.data();
            const userRef = db.collection("users").doc(doc.id);

            let updateData = {
                usageLeft: DAILY_LIMIT,
                messageCount: 0,
                sessionMessageCount: 0, // تصفير عداد الجلسة
                lastUsedDate: todayStr,
                dailyTokensUsed: 0,        
                totalTokensUsedToday: 0,   
                exerciseContext: null      
            };

            if (userData.plan === "pro" && userData.subscriptionExpiresAt) {
                const expiresAt = userData.subscriptionExpiresAt.toDate();
                const timeDiff = expiresAt.getTime() - now.getTime();
                const daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

                if (daysLeft <= 0 || expiresAt <= now) {
                    updateData.plan = "free";
                    updateData.isPro = false;
                    updateData.daysLeft = 0;
                    console.log(`❌ انتهى اشتراك البرو للمستخدم: ${doc.id}`);
                } else {
                    updateData.daysLeft = daysLeft;
                }
            }

            batch.update(userRef, updateData);
        });

        await batch.commit();
        console.log("✅ [CRON JOB] تم التحديث بنجاح!");
    } catch (error) {
        console.error("❌ خطأ في CRON JOB:", error.message);
    }
});

// ===================== AUTH MIDDLEWARE =====================
async function verifyUser(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        const userDocRef = db.collection("users").doc(decoded.uid);
        const userdoc = await userDocRef.get();

        req.user = decoded;
        req.isAdmin = userdoc.exists && userdoc.data().admin === true;
        
        let plan = "free";
        let daysLeft = 0;

        if (userdoc.exists) {
            let userData = userdoc.data();
            const now = new Date();
            const todayStr = getTunisToday();

            if (userData.lastUsedDate !== todayStr) {
                let updatedDays = Number(userData.daysLeft || 0);
                let currentPlan = userData.plan || "free";
                let currentIsPro = userData.isPro || false;

                if (userData.plan === "pro" && userData.subscriptionExpiresAt) {
                    const expiresAt = userData.subscriptionExpiresAt.toDate();
                    const timeDiff = expiresAt.getTime() - now.getTime();
                    const daysLeftVal = Math.max(0, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));

                    if (daysLeftVal <= 0) {
                        currentPlan = "free";
                        currentIsPro = false;
                        updatedDays = 0;
                    } else {
                        updatedDays = daysLeftVal;
                    }
                }

                const silentUpdate = {
                    usageLeft: DAILY_LIMIT,
                    messageCount: 0,
                    sessionMessageCount: 0,
                    daysLeft: updatedDays,
                    plan: currentPlan,
                    isPro: currentIsPro,
                    lastUsedDate: todayStr,
                    dailyTokensUsed: 0,        
                    totalTokensUsedToday: 0,   
                    exerciseContext: null      
                };

                await userDocRef.update(silentUpdate);
                
                userData.usageLeft = DAILY_LIMIT;
                userData.daysLeft = updatedDays;
                userData.plan = currentPlan;
                userData.dailyTokensUsed = 0;
                userData.totalTokensUsedToday = 0;
                userData.exerciseContext = null;
                userData.sessionMessageCount = 0;
            }

            const expiresAt = userData.subscriptionExpiresAt ? userData.subscriptionExpiresAt.toDate() : null;
            if (userData.plan === "pro" && expiresAt) {
                const timeDiff = expiresAt.getTime() - now.getTime();
                daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

                if (daysLeft > 0) {
                    plan = "pro";
                } else {
                    daysLeft = 0;
                    plan = "free";
                }
            }
        }
        
        req.plan = plan;
        req.daysLeft = daysLeft;
        next();

    } catch (err) {
        console.log("VERIFY ERROR:", err.message);
        return res.status(401).json({ error: "Invalid token" });
    }
}

// ===================== HEALTH =====================
app.get('/', (req, res) => {
    res.send("🚀 Server is running smoothly");
});

// ===================== BAC DATA API (Pro Only) =====================
app.get('/api/bac/:section', verifyUser, (req, res) => {
    // 🔒 أرشيف مواضيع الباكالوريا (2009+) محجوز للمشتركين Pro فقط
    if (req.plan !== "pro") {
        return res.status(403).json({
            success: false,
            upgradeRequired: true,
            message: "هذا المحتوى متاح فقط لمشتركي Pro. قم بالترقية للوصول إلى أرشيف مواضيع الباكالوريا الكامل."
        });
    }

    const section = req.params.section.toLowerCase().trim();
    if (allBacData[section]) {
        return res.json({
            success: true,
            section: section,
            exams: allBacData[section]
        });
    } else {
        return res.status(404).json({
            success: false,
            message: "الشعبة غير موجودة. الخيارات: math, technique, sciences, info, lettres, economie"
        });
    }
});
// ===================== 🧠 بناء System Prompt (نسخة مختزلة لتقليل استهلاك التوكن) =====================
function buildSystemInstruction(mode, subjectContext, examStructureContext) {

    const languageRule = `
🌐 LANGUAGE: Detect the language of the uploaded EXAM/document (not the user's chat message) and respond ENTIRELY in that language (French or Arabic).
🔒 SOURCE-LOCKED VOCABULARY: Any word/term that appears in French in the source stays in French in your response — never translate it, treat it like a proper noun. Only your own explanations/connectors may be in natural Arabic. Verify before sending: no source-French word was translated.

✍️ MATH (STRICT LATEX): Format every equation/variable/formula in LaTeX. Inline: $...$ (e.g. $f(x)=2x+3$, $\frac{1}{2}$). Block: $$...$$ on its own line. Every $ or $$ must close. Standard conventions: fractions $\frac{a}{b}$, roots $\sqrt{x}$, powers $x^2$, integrals $\int_{a}^{b} f(x)\,dx$, limits $\lim_{x \to +\infty}$, derivatives $f'(x)$, vectors $\vec{AB}$, infinity $+\infty$/$-\infty$, belonging $\in$. Tunisian Bac level notation.

📸 SOURCE OF TRUTH: When an image is given, read it visually as the single source of truth — never change, round, or invent numbers/values/terms/labels (keep "Exercice 1" as-is).
`;

    if (mode === "summary") {
        return `${languageRule}
You are an expert Tunisian teacher writing exam revision notes${subjectContext ? ` for ${subjectContext}` : ""}.${examStructureContext}
Keep numbers/equations exact. Write real content, not just labels — max 3 lines per concept, no filler intro/outro.

📋 STRUCTURE:
📌 [عنوان الدرس / Titre]
🔑 المفاهيم الأساسية: **[Terme]**: شرح قصير (1-2 سطر) — كل التعاريف والقواعد المهمة.
📊 المعطيات والأرقام الحاسمة: كل الأرقام/التواريخ/الصيغ/الثوابت المهمة كنقاط.
⚡ الأفكار الجوهرية: 4-6 نقاط تلخص جوهر الدرس.
⚠️ تحذير الامتحان: أكثر خطأ شائع يقع فيه التلاميذ.`;

    } else if (mode === "exam") {
        return `${languageRule}
You are a warm, interactive Tunisian teacher assistant.${examStructureContext}
Stick 100% to the exact text/numbers of the uploaded exam — never alter values. Style: short, friendly, conversational chat messages.

🎯 FIRST MESSAGE: Scan the ENTIRE image top to bottom FIRST — count every exercise/part (Exercice 1, I/, II/, Partie A, etc.) before writing anything. Your first message MUST briefly name EVERY exercise/part found (one short line each, e.g. "Exercice I: ..." / "Exercice II: ..." — just the topic, not the full statement or numbers), in 2-3 lines total maximum. Never restate the full text, equations, or sub-questions of any exercise here — that comes later during correction, not in this first message. Do not silently drop or skip any exercise/part that appears in the image, even if it is short or below the fold. Then ask (exact wording, matching exam language):
AR: "شو تحب نعملوا؟ 👇 1️⃣ إصلاح خطوة بخطوة (تفاعلي) 2️⃣ إصلاح كامل مباشرة 3️⃣ امتحان مشابه"
FR: "Qu'est-ce que tu veux faire ? 👇 1️⃣ Correction étape par étape (interactif) 2️⃣ Correction complète directement 3️⃣ Devoir similaire"
WAIT for the choice.

1️⃣ Étape par étape: cover EVERY exercise/part found in the image, one sub-question at a time in order (exact original numbers), praise/correct gently, then next question only — never the full solution upfront. Never stop after only the first exercise/part if more remain. Encouragement words must match the exercise's language only (never mix French/Arabic in one response).
2️⃣ Correction complète: full correction of ALL exercises/parts at once (never only the first one), all steps/calculations/justifications, official Tunisian barème format, no questions asked.
3️⃣ Devoir similaire: brand-new full exam covering the SAME NUMBER of exercises/parts as the original, same structure/topics/difficulty/point distribution, different numbers/scenarios, official Tunisian format.

Always: friendly Tunisian teacher tone, short messages, encouraging, single-language responses only.`;

    } else if (mode === "bac_mode") {
        return `${languageRule}
You are an expert Tunisian Baccalaureate teacher${subjectContext ? ` in ${subjectContext}` : ""}, following the official BAC format/grading.${examStructureContext}
Never alter numbers/equations from the student's BAC document.

🎓 FIRST MESSAGE: Scan the ENTIRE image top to bottom FIRST — count every exercise/part before writing anything. Identify subject/topics AND name every exercise/part found (one short line each) in 2-3 lines total, then ask (exact wording, matching exam language):
AR: "شو تحب نعملوا؟ 👇 1️⃣ إصلاح خطوة بخطوة (مع التنقيط الرسمي) 2️⃣ إصلاح كامل مباشرة (مع الباريم) 3️⃣ امتحان باكالوريا مشابه للامتحانات الوطنية"
FR: "Qu'est-ce que tu veux faire ? 👇 1️⃣ Correction étape par étape (avec barème officiel) 2️⃣ Correction complète directement (avec barème) 3️⃣ Sujet BAC similaire aux sujets nationaux"
WAIT for the choice.

1️⃣ Étape par étape: official grading criteria, cover EVERY exercise/part found in the image in order — never stop after only the first one — correct one question at a time, always state points (e.g. "2/4 points ✅"), rigorous.
2️⃣ Correction complète: full correction of the whole exam at once (ALL exercises/parts, never only the first) with all steps + official barème.
3️⃣ Sujet similaire: brand-new full BAC exam covering the SAME NUMBER of exercises/parts as the original — same official structure/topics/point distribution, different numbers/questions, correct language for the subject, includes model answer + official barème.

Strict: never deviate from official BAC structure, stay rigorous, one language only per response (never mix French/Arabic).`;

    } else if (mode === "content") {
        return `${languageRule}
You are an expert teacher${subjectContext ? ` in ${subjectContext}` : ""}.${examStructureContext}
Analyze/explain the content, then build a complete exam from it with a full model answer.

1. 📖 Content Analysis & Explanation (concise)
2. 📝 Complete Exam (official Tunisian format if applicable)
3. ✅ Full Model Answer & Correction (with points if relevant)`;

    } else {
        return `${languageRule}
You are a precise, professional educational assistant${subjectContext ? ` in ${subjectContext}` : ""}.${examStructureContext}
Answer with high educational accuracy, following Tunisian secondary school standards.`;
    }
}

// ===================== 🔒 رابط امتحانات الباكالوريا السابقة (Pro Only) =====================
// ⚠️ الرابط الحقيقي مخزّن هنا فقط فالسيرفر، ما عادش مكتوب فالفرونت خالص
const PAST_BAC_EXAMS_LINK = "http://www.bacweb.tn/";

app.get('/api/past-exam-link', verifyUser, (req, res) => {
    if (req.plan !== "pro") {
        return res.status(403).json({
            success: false,
            upgradeRequired: true,
            message: "هذا المحتوى متاح فقط لمشتركي Pro. قم بالترقية للوصول إلى أرشيف امتحانات الباكالوريا السابقة."
        });
    }
    return res.json({
        success: true,
        link: PAST_BAC_EXAMS_LINK
    });
});

// max_tokens متغير حسب المود: summary أقل، exam/bac_mode أكبر (شرح مفصل خطوة بخطوة أو إصلاح كامل)
function getMaxTokensForMode(mode) {
    if (mode === "summary") return 1000;
    if (mode === "exam" || mode === "bac_mode") return 2500;
    return 1500;
}
// ===================== GENERATE WITH STREAMING =====================
app.post('/generate', verifyUser, async (req, res) => {
  try {
    const { 
      text, 
      mode, 
      selectedSubject, 
      userSection, 
      history, 
      imageBase64, 
      imageMime, 
      isNewChat,
      suggestionId // 🆕 معرف اقتراح جاهز (تلخيص/امتحان/باكالوريا) — يتحسب كمحاولة عادية بلا نداء OpenAI
    } = req.body || {};
    const userId = req.user?.uid;

    if (!userId) {
      console.error("❌ [Auth Error]: userId غير موجود في الطلب");
      return res.status(401).json({ error: "غير مصرح لك بالوصول (Missing Auth)" });
    }

    if (!text && !imageBase64 && !suggestionId) {
      return res.status(400).json({ error: "Missing text or image" });
    }

    const userRef = db.collection("users").doc(userId);
    let userSnap = await userRef.get();
    const todayStr = typeof getTunisToday === 'function' ? getTunisToday() : new Date().toISOString().split('T')[0];

    if (!userSnap.exists) {
      await userRef.set({
        email: req.user.email || "",
        plan: "free",
        paymentStatus: "pending",
        usageLeft: DAILY_LIMIT, // 7 محاولات
        usage: 0,
        messageCount: 0,
        sessionMessageCount: 0, 
        daysLeft: 0,
        freeTrialUsed: false,  
        dailyTokensUsed: 0,    
        totalTokensUsedToday: 0, 
        currentExamLanguage: null, 
        exerciseContext: null,     
        lastUsedDate: todayStr
      });
      userSnap = await userRef.get();
    }

    const userData = userSnap.data() || {};
    const plan = req.plan || userData.plan || "free"; 
    const freeTrialUsed = userData.freeTrialUsed === true;

    const currentUsageLeft = Number(userData.usageLeft || 0);
    let messageCount = Number(userData.messageCount || 0);
    let sessionMessageCount = Number(userData.sessionMessageCount || 0);

    console.log(`----------------------------------------`);
    console.log(`📩 Request from: ${userData.email || userId} | Total Msg: ${messageCount + 1} | Session Msg: ${sessionMessageCount}${suggestionId ? ` | Suggestion: ${suggestionId}` : ""}`);
    console.log(`📊 Daily Usage Left: ${currentUsageLeft}/${DAILY_LIMIT}`);
    console.log(`----------------------------------------`);

    // 1️⃣ التحقق من المحاولة المجانية والحد اليومي (7 محاولات ناجحة، الثامنة توقف)
    if (plan === "free" && freeTrialUsed) {
      res.write(`data: ${JSON.stringify({ error: "🚫 لقد استهلكت محاولتك المجانية! قم بالترقية إلى Pro للمتابعة." })}\n\n`);
      return res.end();
    }

    if (isNaN(currentUsageLeft) || currentUsageLeft <= 0) {
      res.write(`data: ${JSON.stringify({ error: `⏳ لقد استوفيت رصيدك اليومي بالكامل. سيتم تجديده تلقائياً غداً.` })}\n\n`);
      return res.end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders(); 
    }

    req.on('close', () => {
      console.log("⚠️ [Stream Closed] تم إغلاق الطلب من جانب المستخدم.");
    });

    // 🆕 اقتراح جاهز: ما يحتاجش صورة إجبارية حتى في exam/bac_mode
    const noHistoryYet = !history || !Array.isArray(history) || history.length === 0;
    if (!suggestionId && (mode === "exam" || mode === "bac_mode") && !imageBase64 && noHistoryYet) {
      res.write(`data: ${JSON.stringify({ error: "📸 لازم تبعث صورة الامتحان باش نقدر نبدأ." })}\n\n`);
      return res.end();
    }

    let examLanguage = userData.currentExamLanguage || null;
    let exerciseContext = imageBase64 ? "" : (userData.exerciseContext || "");

    // ===================== 🛑 الفحص الوحيد لحد الـ3 رسائل (صورة أو نص أو اقتراح، بلا تمييز) =====================
    // 🆕 إصلاح: إذا الرسالة اللي وصلت للحد فيها صورة جديدة، نعتبرها هي نفسها "الصورة الجديدة"
    // المطلوبة ونعالجها مباشرة بدل ما نرفضها ونضيّع معطياتها (كانت قبل ترجع خطأ وتطلب صورة
    // جديدة حتى لو الصورة كانت موجودة فنفس الطلب، فيضطر المستخدم يبعثها مرة ثانية ويحس إنها ضاعت)
    if (sessionMessageCount >= MAX_MESSAGES_PER_SESSION && !imageBase64) {
      console.log(`🛑 [Session Limit Reached]: أتم المستخدم ${MAX_MESSAGES_PER_SESSION} رسائل. جاري تصفير السياق والتوكنز...`);
      
      // 1. تصفير الهيستوري في الواجهة
      res.write(`data: ${JSON.stringify({ clearHistory: true })}\n\n`);
      if (typeof res.flush === 'function') res.flush();

      // 2. هذي الرسالة (رسالة التنبيه) تُحتسب كمحاولة كاملة من الـ7 اليومية — نخصمها هنا
      //    مع تصفير عداد الجلسة (يبدأ يعد من جديد لـ3 رسائل أخرى) وتفريغ السياق
      await userRef.update({
        usage: admin.firestore.FieldValue.increment(1),
        usageLeft: admin.firestore.FieldValue.increment(-1),
        messageCount: messageCount + 1,
        sessionMessageCount: 0,
        exerciseContext: null,
        currentExamLanguage: null,
        lastUsedDate: todayStr
      });

      // 3. إرسال تنبيه للمستخدم بضرورة إرسال صورة جديدة لتجديد السياق
      res.write(`data: ${JSON.stringify({ 
        error: `📌 وصلت للحد الأقصى من الأسئلة على هذا التمرين. من فضلك أرسل صورة التمرين من جديد للمتابعة.`,
        requireNewImage: true 
      })}\n\n`);
      console.log(`✅ [Session Notice Sent] هذي الرسالة احتُسبت كمحاولة يومية | المحاولات اليومية المتبقية: ${currentUsageLeft - 1}/${DAILY_LIMIT}`);
      return res.end();
    }

    // ===================== 💬 رد جاهز على اقتراح (بلا أي نداء OpenAI — 0 توكن) =====================
    // ⚠️ لازم يجي بعد فحص حد الـ3 رسائل مباشرة، وقبل أي تجهيز لرسائل OpenAI
    if (suggestionId && SUGGESTION_REPLIES[suggestionId]) {
      const cannedText = SUGGESTION_REPLIES[suggestionId];
      res.write(`data: ${JSON.stringify({ text: cannedText })}\n\n`);
      if (typeof res.flush === 'function') res.flush();

      // ✅ تُحتسب كمحاولة عادية بالضبط (خصم من الـ7 + زيادة عداد الجلسة) — بس بلا أي توكنز
      const newSessionMessageCount = sessionMessageCount + 1;
      const suggestionUpdatePayload = {
        usage: admin.firestore.FieldValue.increment(1),
        usageLeft: admin.firestore.FieldValue.increment(-1),
        messageCount: messageCount + 1,
        sessionMessageCount: newSessionMessageCount,
        lastUsedDate: todayStr
        // 🆕 ما فيش أي زيادة في dailyTokensUsed / totalTokensUsedToday — بلا نداء OpenAI فعلي (0 توكن)
      };
      if (plan === "free") {
        suggestionUpdatePayload.freeTrialUsed = true;
      }
      await userRef.update(suggestionUpdatePayload);

      console.log(`----------------------------------------`);
      console.log(`💬 [Suggestion Reply] "${suggestionId}" — رد جاهز بلا أي نداء OpenAI (0 توكن)`);
      console.log(`📊 [الاستهلاك اليومي] المحاولات اليومية المتبقية: ${currentUsageLeft - 1}/${DAILY_LIMIT} | عداد الجلسة: ${newSessionMessageCount}/${MAX_MESSAGES_PER_SESSION}`);
      console.log(`----------------------------------------`);

      res.write('\ndata: [DONE]\n\n');
      return res.end();
    }

    // ===================== 🖼️ إذا أرسل المستخدم صورة جديدة: تصفير كامل لسياق التمرين =====================
    if (imageBase64) {
      res.write(`data: ${JSON.stringify({ clearHistory: true })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
      console.log(`🧹 [New Image Uploaded]: تصفير سياق التمرين. الصورة تُحتسب كرسالة عادية ضمن عداد الجلسة.`);

      // 🆕 إذا هاذي الصورة الجديدة وصلت ونحن أصلاً على/فوق حد الـ3 رسائل، نعتبرها بداية
      // جلسة جديدة وعداد الجلسة يرجع يبدا من 1 (بدل ما يكمل يزيد فوق الحد)
      if (sessionMessageCount >= MAX_MESSAGES_PER_SESSION) {
        sessionMessageCount = 0;
        console.log(`🔄 [Session Auto-Reset]: صورة جديدة وصلت عند حد الجلسة — تصفير العداد وبدء جلسة جديدة.`);
      }
    }


    if (imageBase64 && typeof extractTextFromImage === 'function') {
      try {
        const localOcrText = await extractTextFromImage(imageBase64);
        if (localOcrText && localOcrText.trim().length > 0) {
          res.write(`data: ${JSON.stringify({ ocrText: localOcrText })}\n\n`);
          if (typeof res.flush === 'function') res.flush();

          const detectedLang = typeof detectExamLanguage === 'function' ? detectExamLanguage(localOcrText) : null;
          if (detectedLang) {
            examLanguage = detectedLang;
          }
          exerciseContext = localOcrText.trim().slice(0, 2500);
        }
      } catch (ocrErr) {
        console.warn("⚠️ [Local OCR Warning]:", ocrErr.message);
      }
    }

    let examStructureContext = "";
    const isFirstMessageOfContext = !!imageBase64 || noHistoryYet;
    if (isFirstMessageOfContext && (mode === "bac_mode" || mode === "exam" || mode === "content") && userSection && selectedSubject) {
      if (typeof allBacData !== 'undefined' && userSection) {
        const normalizedSection = String(userSection).toLowerCase().trim();
        if (allBacData[normalizedSection] && Array.isArray(allBacData[normalizedSection])) {
          const matchedSubjectExams = allBacData[normalizedSection].find(
            e => e && e.subject && e.subject.trim().toLowerCase() === String(selectedSubject).trim().toLowerCase()
          );
          if (matchedSubjectExams) {
            examStructureContext = `\n\n📚 OFFICIAL TUNISIAN BAC STRUCTURE:\n${JSON.stringify(matchedSubjectExams.structure)}`;
          }
        }
      }
    }

    const subjectContext = selectedSubject || "";
    let systemInstructionText = "You are a helpful AI assistant.";
    if (typeof buildSystemInstruction === 'function') {
      systemInstructionText = buildSystemInstruction(mode, subjectContext, examStructureContext);
    }

    if (exerciseContext && !imageBase64) {
      systemInstructionText += `\n\n📋 EXERCISE CONTEXT:\n${exerciseContext}`;
    }

    // 🆕 [إصلاح باغ الرد بالعربية على تمرين فرنسي] — اللغة المكتشفة بالـ OCR (examLanguage) كانت
    // تتخزن فـ Firestore بس بلا ما تنقال فعلياً للموديل فهاذي الرسالة، فيبقى يخمّن اللغة من الصورة
    // فقط ويغلط أحياناً. نفرضها هنا صراحة كتعليمة صارمة، بغض النظر عن لغة كتابة التلميذ فالشات.
    if (examLanguage) {
      systemInstructionText += `\n\n🌐 DETECTED EXERCISE LANGUAGE (STRICT — OCR-verified): ${examLanguage}. Your ENTIRE response — every single word, including explanations, transitions, and comments — MUST be in ${examLanguage} only. Never switch to another language, even if the student's own chat message is written in a different language.`;
    }

    let messages = [{ role: "system", content: systemInstructionText }];

    const MAX_HISTORY_MESSAGES = 3; 
    let useHistory = imageBase64 ? [] : (history || []);
    if (useHistory.length > MAX_HISTORY_MESSAGES) {
      useHistory = useHistory.slice(-MAX_HISTORY_MESSAGES);
    }
    if (useHistory && Array.isArray(useHistory)) {
      useHistory.forEach(turn => {
        if (turn && turn.text && String(turn.text).trim() !== "") {
          let cleanRole = (turn.role === "user") ? "user" : "assistant";
          messages.push({ role: cleanRole, content: String(turn.text).trim() });
        }
      });
    }

    const currentContent = [];
    if (imageBase64 && imageMime) {
      currentContent.push({
        type: "image_url",
        image_url: { url: `data:${imageMime};base64,${imageBase64}`, detail: "high" }
      });
    }

    const cleanCurrentText = text ? String(text).trim() : "";
    if (cleanCurrentText) {
      currentContent.push({ type: "text", text: cleanCurrentText });
    }

    messages.push({
      role: "user",
      content: currentContent.length === 1 && currentContent[0].type === "text" ? currentContent[0].text : currentContent
    });

    const requestMaxTokens = getMaxTokensForMode(mode);
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      temperature: 0.1,
      top_p: 0.1,
      max_tokens: requestMaxTokens,
      stream: true,
      stream_options: { include_usage: true }
    });

    let tokenUsage = null; 
    let finishReason = null; 

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content || "";
      if (content) {
        const correctedContent = typeof enforceFrenchTerminology === 'function' ? enforceFrenchTerminology(content) : content;
        res.write(`data: ${JSON.stringify({ text: correctedContent })}\n\n`);
        if (res.flush) res.flush();
      }
      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.usage) {
        tokenUsage = chunk.usage; 
      }
    }

    let requestTokens = 0;
    if (tokenUsage) {
      requestTokens = tokenUsage.total_tokens || 0;
    }

    // ===================== ✅ التحديث في قاعدة البيانات (Firebase) =====================
    // الصورة تُحسب كرسالة عادية ضمن عداد الجلسة (بلا تمييز) — الصورة تصفر الـ history/exerciseContext
    // (تم فوق عبر clearHistory + OCR الجديد) لكن ما تلمسش عداد الجلسة نفسه
    const newSessionMessageCount = sessionMessageCount + 1;

    const updatePayload = {
      usage: admin.firestore.FieldValue.increment(1),      
      usageLeft: admin.firestore.FieldValue.increment(-1), // خصم محاولة من الـ 7 اليومية
      messageCount: messageCount + 1,
      sessionMessageCount: newSessionMessageCount,        
      dailyTokensUsed: imageBase64 ? requestTokens : admin.firestore.FieldValue.increment(requestTokens),
      totalTokensUsedToday: admin.firestore.FieldValue.increment(requestTokens),
      currentExamLanguage: examLanguage || userData.currentExamLanguage || null, 
      exerciseContext: exerciseContext || null, 
      lastUsedDate: todayStr
    };

    if (plan === "free") {
      updatePayload.freeTrialUsed = true;
    }

    await userRef.update(updatePayload);

    // 🔍 طباعة التوكن المستهلك بدقة في التيرمينال لكل رسالة ولليوم بالكامل
    const previousTotalToday = Number(userData.totalTokensUsedToday || 0);
    const updatedTotalToday = previousTotalToday + requestTokens;
    console.log(`🔢 [Tokens Report] الرسالة الحالية: ${requestTokens} توكن | 📊 إجمالي التوكنز لليوزر اليوم: ${updatedTotalToday} توكن`);
    console.log(`✅ تم الرد بنجاح | المحاولات اليومية المتبقية: ${currentUsageLeft - 1}/${DAILY_LIMIT} | عداد الجلسة الحالي: ${newSessionMessageCount}/${MAX_MESSAGES_PER_SESSION}`);
    
    res.write('\ndata: [DONE]\n\n');
    return res.end();

  } catch (error) {
    console.error("❌ [CRITICAL ERROR]:", error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || "Internal Server Error" });
    }
    res.write(`data: ${JSON.stringify({ error: error.message || "حدث خطأ غير متوقع" })}\n\n`);
    return res.end();
  }
});
// ===================== CREATE PAYMENT =====================
app.post('/flouci-create', verifyUser, async (req, res) => {
  try {
    const method = (req.headers["x-pay-method"] || "").toLowerCase().trim();
    const { plan, price } = req.body || {}; 

    let provider;
    if (method === "flouci") provider = "flouci";
    else if (method === "d17") provider = "d17";
    else return res.status(400).json({ error: "Invalid payment method" });

    const orderId = "ORDER-" + Date.now();

    await db.collection("payments").doc(orderId).set({
      userId: req.user.uid,
      orderId,
      provider,
      plan: plan || "3_months",   
      price: price || 30,          
      status: "pending",
      createdAt: new Date()
    });

    return res.json({
      url: "https://example.com/payment/" + orderId,
      orderId,
      provider
    });
  } catch (error) {
    console.error("❌ [Error in /flouci-create]:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ===================== CONFIRM PAYMENT =====================
app.post('/confirm-payment', verifyUser, async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({ error: "Payment not found" });
    }

    const paymentData = paymentSnap.data() || {};
    const userId = paymentData.userId;
    const chosenPlan = paymentData.plan || "3_months";

    let daysToAdd = 90; 
    if (chosenPlan === "6_months") daysToAdd = 180;
    else if (chosenPlan === "12_months") daysToAdd = 365;

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysToAdd);

    await paymentRef.update({ status: "approved" });

    const todayStr = typeof getTunisToday === 'function' ? getTunisToday() : new Date().toISOString().split('T')[0];

    await db.collection("users").doc(userId).update({
      plan: "pro",
      isPro: true, 
      subscriptionExpiresAt: expiryDate, 
      paymentStatus: "approved",
      dailyLimit: 8,  
      usageLeft: 8,
      daysLeft: daysToAdd, 
      lastUsedDate: todayStr
    });

    return res.json({
      success: true,
      message: `Payment confirmed and limits set to 10 with ${daysToAdd} days`
    });
  } catch (error) {
    console.error("❌ [Error in /confirm-payment]:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ===================== ADMIN APPROVE =====================
app.post('/approve-payment', verifyUser, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "NOT ALLOWED" });
  }

  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({ error: "Not found" });
    }

    const paymentData = paymentSnap.data() || {};
    const userId = paymentData.userId;
    const chosenPlan = paymentData.plan || "3_months"; 

    let daysToAdd = 90; 
    if (chosenPlan === "6_months") daysToAdd = 180; 
    else if (chosenPlan === "12_months") daysToAdd = 365; 

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysToAdd);

    await paymentRef.update({ status: "approved" });

    const todayStr = typeof getTunisToday === 'function' ? getTunisToday() : new Date().toISOString().split('T')[0];

    await db.collection("users").doc(userId).update({
      plan: "pro",
      isPro: true, 
      subscriptionExpiresAt: expiryDate, 
      paymentStatus: "approved",
      dailyLimit: 10,  
      usageLeft: 10,
      daysLeft: daysToAdd, 
      lastUsedDate: todayStr
    });

    return res.json({
      success: true,
      message: `User upgraded to Pro for ${daysToAdd} days`
    });
  } catch (error) {
    console.error("❌ [Error in /approve-payment]:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ===================== ADMIN ROUTES =====================
app.get('/admin.html', verifyUser, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).send("🚫 Access Denied: Admin only");
  }
  return res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/check-admin', verifyUser, (req, res) => {
  return res.json({ isAdmin: !!req.isAdmin });
});

app.get('/admin-test', verifyUser, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "NOT ALLOWED" });
  }
  return res.json({ success: true, message: "You are an admin!" });
});

// ===================== START =====================
app.listen(3000, '0.0.0.0', () => {
  console.log("Server running on port 3000");
});