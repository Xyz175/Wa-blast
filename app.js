require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const cors = require('cors');

// Inisialisasi Firebase Admin
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
        console.log('[Firebase] Admin SDK berhasil diinisialisasi.');
    } catch (e) {
        console.error('[Firebase] Gagal inisialisasi Admin SDK:', e.message);
    }
} else {
    console.warn('[Firebase] Konfigurasi Firebase Admin SDK tidak lengkap di .env. Mode bypass Auth aktif.');
}

const db = admin.getApps().length > 0 ? admin.firestore() : null;

// Middleware Autentikasi Firebase
async function requireAuth(req, res, next) {
    // Jika Firebase tidak dikonfigurasi, bypass login sepenuhnya
    if (!process.env.FIREBASE_PROJECT_ID && !process.env.FIREBASE_PRIVATE_KEY) {
        req.user = { email: 'bypass@local', uid: 'bypass' };
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // Izinkan endpoint tertentu diakses publik jika gagal auth
        if (req.path === '/status') return next();
        
        return res.status(401).json({ success: false, message: 'Akses Ditolak. Token tidak ditemukan.' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    // Hardcode bypass login untuk Dyreza175@gmail.com
    if (idToken === 'local-bypass-token') {
        req.user = { email: 'Dyreza175@gmail.com', uid: 'local-admin' };
        return next();
    }

    if (admin.getApps().length === 0) {
        // Jika tidak ada firebase, bypass auth untuk backward compatibility
        return next();
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('[Auth Error]', error.message);
        return res.status(403).json({ success: false, message: 'Akses Ditolak. Token tidak valid atau kedaluwarsa.' });
    }
}

const app = express();

// Keamanan & Optimasi Payload
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Konfigurasi CORS agar frontend (baik via http://localhost:3000 maupun file:///) dapat mengakses API
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Konfigurasi agar Express bisa membaca JSON yang besar dan file statis
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Folder untuk file statis HTML/CSS/JS

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Berjalan di port ${PORT}. Buka browser di http://localhost:${PORT}`));

// Sanitasi nama model AI (otomatis migrasi model yang sudah decommissioned/usang dari Groq/Gemini ke model aktif terbaru)
function sanitizeAiModel(model) {
    if (!model) return '';
    const clean = String(model).trim();
    const groqDeprecatedMap = {
        'llama3-70b-8192': 'llama-3.3-70b-versatile',
        'llama3-8b-8192': 'llama-3.1-8b-instant',
        'llama-3.1-70b-versatile': 'llama-3.3-70b-versatile',
        'mixtral-8x7b-32768': 'llama-3.3-70b-versatile',
        'gemma2-9b-it': 'llama-3.3-70b-versatile',
        'gemma-7b-it': 'llama-3.1-8b-instant',
        'llama-guard-2-8b': 'meta-llama/llama-guard-3-8b'
    };
    const geminiDeprecatedMap = {
        'gemini-1.0-pro': 'gemini-1.5-flash',
        'gemini-pro': 'gemini-1.5-flash'
    };
    return groqDeprecatedMap[clean] || geminiDeprecatedMap[clean] || clean;
}

// Path file database pengetahuan AI
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge_base.json');
let knowledgeData = {
    businessName: "Rumah Etnik Papua",
    tagline: "Pusat Wisata Budaya, Homestay Etnik, & Pengalaman Autentik Tanah Papua",
    location: "Sorong, Papua Barat Daya (Gerbang Wisata Raja Ampat)",
    contactPhone: "+62 811-4600-1602",
    csPhone: "+62 811-4600-1602",
    botMenu: "1. Info Harga\n2. Paket Wisata\n3. Reservasi\n4. Bicara dengan CS",
    systemInstruction: "Anda adalah Asisten Virtual Resmi 'Rumah Etnik Papua' yang ramah, hangat, dan informatif.",
    knowledgeText: ""
};
let managedAdmins = [];

function normalizeAdminRecord(adminRecord) {
    const expiresAt = adminRecord.expiresAt || new Date(Date.now() + 3 * 86400000).toISOString();
    return { ...adminRecord, expiresAt, status: new Date(expiresAt) > new Date() ? 'Aktif' : 'Kedaluwarsa' };
}

async function saveManagedAdmins() {
    knowledgeData.ownerAdmins = managedAdmins;
    if (db) await db.collection('settings').doc('knowledge_base').set({ ownerAdmins: managedAdmins }, { merge: true });
    else fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeData, null, 2), 'utf8');
}

let aiConfig = {
    apiKeys: (process.env.AI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '').split(/[\n,]+/).map(key => key.trim()).filter(Boolean),
    provider: process.env.AI_PROVIDER || 'gemini',
    autoReply: process.env.AI_AUTO_REPLY === 'true',
    modelName: sanitizeAiModel(process.env.AI_MODEL_NAME || 'gemini-1.5-flash')
};

if (fs.existsSync(KNOWLEDGE_FILE)) {
    try {
        const rawKnowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        knowledgeData = { ...knowledgeData, ...rawKnowledge };
        managedAdmins = (rawKnowledge.ownerAdmins || []).map(normalizeAdminRecord);
        // Ambil aiConfig yang tersimpan jika ada
        if (rawKnowledge.aiConfig) {
            aiConfig = {
                apiKeys: Array.isArray(rawKnowledge.aiConfig.apiKeys)
                    ? rawKnowledge.aiConfig.apiKeys.filter(Boolean)
                    : String(rawKnowledge.aiConfig.apiKey || process.env.AI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '').split(/[\n,]+/).map(key => key.trim()).filter(Boolean),
                provider: rawKnowledge.aiConfig.provider || process.env.AI_PROVIDER || 'gemini',
                autoReply: typeof rawKnowledge.aiConfig.autoReply === 'boolean' 
                    ? rawKnowledge.aiConfig.autoReply 
                    : (process.env.AI_AUTO_REPLY === 'true'),
                modelName: sanitizeAiModel(rawKnowledge.aiConfig.modelName || process.env.AI_MODEL_NAME || 'gemini-1.5-flash')
            };
        }
    } catch (e) {
        console.error('[AI] Gagal membaca knowledge_base.json:', e.message);
    }
}

// Sinkronisasi data dari Firestore (jika ada) yang menimpa default/file lokal
async function loadKnowledgeFromFirestore() {
    if (!db) return;
    try {
        const docRef = db.collection('settings').doc('knowledge_base');
        const doc = await docRef.get();
        if (doc.exists) {
            const data = doc.data();
            knowledgeData = { ...knowledgeData, ...data };
            managedAdmins = (data.ownerAdmins || []).map(normalizeAdminRecord);
            if (data.aiConfig) {
                aiConfig = { ...aiConfig, ...data.aiConfig };
                aiConfig.apiKeys = Array.isArray(data.aiConfig.apiKeys)
                    ? data.aiConfig.apiKeys.filter(Boolean)
                    : String(data.aiConfig.apiKey || aiConfig.apiKeys.join('\n') || process.env.AI_API_KEYS || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '').split(/[\n,]+/).map(key => key.trim()).filter(Boolean);
                if (aiConfig.modelName) {
                    aiConfig.modelName = sanitizeAiModel(aiConfig.modelName);
                }
            }
            console.log('[Firestore] Data knowledge_base berhasil dimuat.');
        } else {
            console.log('[Firestore] Dokumen knowledge_base belum ada. Menggunakan default lokal, menyimpan ke Firestore...');
            knowledgeData.aiConfig = aiConfig;
            await docRef.set(knowledgeData);
        }
    } catch (e) {
        console.error('[Firestore] Gagal memuat knowledge_base:', e.message);
    }
}
loadKnowledgeFromFirestore();

// Inisialisasi aiConfig dengan prioritas: Disimpan di File -> ENV Variable
if (!Array.isArray(aiConfig.apiKeys) || aiConfig.apiKeys.length === 0) {
    aiConfig.apiKeys = (process.env.AI_API_KEYS || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '').split(/[\n,]+/).map(key => key.trim()).filter(Boolean);
}
if (process.env.AI_AUTO_REPLY === 'true') {
    aiConfig.autoReply = true;
}

console.log(`[AI Bot] Status Auto-Reply Awal: ${aiConfig.autoReply ? 'AKTIF 🟢' : 'NONAKTIF ⚪'}`);
let aiKeyRotationIndex = 0;
console.log(`[AI Bot] API Key Terpasang: ${aiConfig.apiKeys.length ? `Ya (${aiConfig.apiKeys.length} key)` : 'Belum diatur ⚠️'}`);

let isClientReady = false;
let clientStatus = 'Menyiapkan sesi WhatsApp...';
let currentQr = null;
let currentPairingCode = null;
let userInfo = null;
const dashboardStats = { queued: 0, sentToday: 0, activeProcesses: 0, failedToday: 0 };
const inboxContacts = new Map();
let integrations = [];

function recordInboxContact(from, body) {
    if (!from || !body) return;
    const current = inboxContacts.get(from) || { phone: from.replace('@c.us', ''), lastMessage: '', updatedAt: null, status: 'Hubungi Admin' };
    current.lastMessage = body;
    current.updatedAt = new Date().toISOString();
    if (/\bdp\b|uang muka|down payment|transfer|bayar/i.test(body)) current.status = 'DP';
    else if (/reserv|booking|pesan|harga|kamar|paket/i.test(body)) current.status = 'Reservasi';
    else current.status = 'Hubungi Admin';
    inboxContacts.set(from, current);
}

function getKnowledgeTopic(keyword, fallback) {
    const source = knowledgeData.knowledgeText || '';
    const match = source.match(new RegExp(`(?:^|\\n)([^\\n]*${keyword}[^\\n]*)([\\s\\S]*?)(?=\\n#{1,3} |\\n\\d+\\. |$)`, 'i'));
    return match ? `${match[1].trim()}${match[2].trim()}`.trim() : fallback;
}

// Fungsi Khusus: Memanggil Groq Cloud AI (Llama 3.3 70B & Llama 3.1 8B) - Super Cepat & Kuota Gratis 14.400 req/hari
async function callGroqAi(apiKey, systemInstruction, userMessage) {
    const selectedModel = sanitizeAiModel(aiConfig.modelName) || 'llama-3.3-70b-versatile';
    const candidateModels = [
        selectedModel,
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'llama3-8b-8192',
        'llama3-70b-8192',
        'mixtral-8x7b-32768'
    ];

    let lastError = null;
    for (const model of [...new Set(candidateModels.map(m => sanitizeAiModel(m)).filter(Boolean))]) {
        try {
            console.log(`[Groq AI] Mencoba model: ${model}...`);
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: userMessage }
                    ],
                    temperature: 0.6,
                    max_tokens: 1024
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(`Groq Error (${res.status}): ${errData.error?.message || res.statusText}`);
            }

            const data = await res.json();
            if (data.choices && data.choices[0] && data.choices[0].message) {
                console.log(`[Groq AI] Berhasil dijawab oleh model: ${model}`);
                return data.choices[0].message.content;
            }
            throw new Error('Format balasan Groq AI tidak valid.');
        } catch (err) {
            lastError = err;
            console.warn(`[Groq AI Fallback] Model ${model} gagal:`, err.message);
        }
    }
    throw lastError || new Error('Gagal memanggil Groq AI.');
}

// Fungsi Khusus: Memanggil Google Gemini AI
async function callGeminiAi(apiKey, systemInstruction, userMessage) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const selectedModel = sanitizeAiModel(aiConfig.modelName) || 'gemini-1.5-flash';
    const candidateModels = [
        selectedModel,
        'gemini-1.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-pro'
    ];

    let lastError = null;
    for (const modelName of [...new Set(candidateModels.map(m => sanitizeAiModel(m)).filter(Boolean))]) {
        try {
            console.log(`[Gemini AI] Mencoba model: ${modelName}...`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: systemInstruction
            });
            const result = await model.generateContent(userMessage);
            const text = result.response.text();
            console.log(`[Gemini AI] Berhasil dijawab oleh model: ${modelName}`);
            return text;
        } catch (err) {
            lastError = err;
            console.warn(`[Gemini AI Fallback] Model ${modelName} gagal:`, err.message);
        }
    }
    throw lastError || new Error('Gagal memanggil Gemini AI.');
}

// Fungsi Utama: Generate Balasan AI Berdasarkan Knowledge Base Rumah Etnik Papua (Otomatis Mendukung Groq & Gemini)
async function generateAiResponse(userMessage) {
    const keyList = Array.isArray(aiConfig.apiKeys) ? aiConfig.apiKeys.filter(Boolean) : [];
    if (!keyList.length) {
        throw new Error('API Key belum diatur. Silakan masukkan Groq API Key (gsk_...) di menu Bot AI.');
    }

    const fullSystemInstruction = `${knowledgeData.systemInstruction || 'Anda adalah Asisten Virtual Resmi Rumah Etnik Papua.'}

=== BASIS PENGETAHUAN RESMI RUMAH ETNIK PAPUA ===
${knowledgeData.knowledgeText || ''}

=== MENU BOT ===
${knowledgeData.botMenu || ''}
Nomor CS: ${knowledgeData.csPhone || knowledgeData.contactPhone || ''}
Jika pelanggan meminta reservasi, arahkan ke nomor pengelola. Jika meminta CS, arahkan ke nomor CS.

=== PANDUAN MENJAWAB ===
1. Jawablah dengan nada bicara yang ramah, sopan, bersahabat, dan mencerminkan keramahan khas tanah Papua (misal gunakan sapaan hangat 'Halo Kaka', 'Bapak/Ibu', dll).
2. Gunakan emoji yang selaras (🌿, 🏞️, 🛖, ✨, 🙏) agar pesan WhatsApp terasa hidup dan natural.
3. Jawab secara ringkas, to-the-point, dan mudah dipahami di layar HP.
4. Jika pengunjung ingin melakukan reservasi/booking, tanyakan tanggal rencana kunjungan dan berapa orang, lalu sarankan untuk konfirmasi langsung ke nomor WhatsApp Pengelola: ${knowledgeData.contactPhone || '0811-4600-1602'}.
5. Jika ada pertanyaan di luar konteks wisata/budaya/layanan Rumah Etnik Papua, jawab dengan sopan bahwa Anda adalah asisten khusus Rumah Etnik Papua.`;

    let lastError = null;

    // Mulai dari key berikutnya agar beban tersebar, lalu coba semua key sekali.
    const startIndex = aiKeyRotationIndex % keyList.length;
    aiKeyRotationIndex = (startIndex + 1) % keyList.length;
    for (let attempt = 0; attempt < keyList.length; attempt++) {
        const kIdx = (startIndex + attempt) % keyList.length;
        const activeKey = keyList[kIdx];
        const isGroq = activeKey.startsWith('gsk_');

        try {
            if (isGroq) {
                return await callGroqAi(activeKey, fullSystemInstruction, userMessage);
            } else {
                return await callGeminiAi(activeKey, fullSystemInstruction, userMessage);
            }
        } catch (err) {
            lastError = err;
            const errMsg = err.message || '';
            console.warn(`[AI Key ${kIdx + 1} Error]:`, errMsg);
            if (errMsg.includes('429') || errMsg.includes('Quota exceeded') || errMsg.includes('rate_limit')) {
                console.warn(`[Rotasi Key] Kuota limit pada key ke-${kIdx + 1}, beralih ke key berikutnya...`);
            }
        }
    }

    throw lastError || new Error('Gagal menghasilkan balasan dari AI Provider.');
}

// Simpan sesi di AppData Local (jika di Windows) atau folder lokal .wwebjs_auth (jika di Linux / Railway Cloud)
const sessionPath = process.env.LOCALAPPDATA 
    ? path.join(process.env.LOCALAPPDATA, 'wa-blast-session') 
    : path.join(__dirname, '.wwebjs_auth');

console.log('[Server] Lokasi Sesi WhatsApp:', sessionPath);

const puppeteerConfig = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--js-flags="--max-old-space-size=256"',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-features=AudioServiceOutOfProcess',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-notifications',
        '--disable-offer-store-unmasked-wallet-cards',
        '--disable-popup-blocking',
        '--disable-print-preview',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--hide-scrollbars',
        '--ignore-gpu-blacklist',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-pings',
        '--password-store=basic',
        '--use-gl=swiftshader',
        '--use-mock-keychain'
    ]
};

// Jika berjalan di container Docker (Railway / Render) yang menggunakan Chromium bawaan sistem
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

let client = null;

// Set untuk mencegah duplikasi balasan jika event terpanggil ganda
const processedMessages = new Set();
const userState = new Map();

// Handler terpusat untuk memproses pesan masuk WhatsApp
async function handleIncomingMessage(msg, eventSource) {
    if (!msg) return;

    const from = msg.from || '';
    const body = msg.body ? msg.body.trim() : '';
    const isFromMe = msg.fromMe;
    const isGroup = from.includes('@g.us');
    const isStatus = msg.isStatus || from === 'status@broadcast';

    // Abaikan pesan lama (saat sinkronisasi riwayat awal)
    const now = Math.floor(Date.now() / 1000);
    if (msg.timestamp && msg.timestamp < now - 60) {
        return; // Pesan lebih lama dari 60 detik (riwayat lama), abaikan tanpa log
    }

    // 1. Abaikan jika pesan dikirim dari diri sendiri (bot sendiri)
    if (isFromMe) return;
    
    // 2. Abaikan pesan dari grup atau status
    if (isGroup || isStatus) return;

    // 3. Pastikan ada teks
    if (!body) return;
    recordInboxContact(from, body);

    // Log aktivitas pesan masuk (HANYA UNTUK PESAN BARU YANG RELEVAN)
    console.log(`\n--------------------------------------------------`);
    console.log(`[WhatsApp Inbound] Dari: ${from} | Tipe: ${msg.type}`);
    console.log(`[WhatsApp Inbound] Pesan: "${body}"`);


    // 4. Cek apakah fitur Auto-Reply aktif
    if (!aiConfig.autoReply) {
        console.log(`[AI Auto-Reply DILEWATI] Fitur Auto-Reply saat ini NONAKTIF (aiConfig.autoReply = false).`);
        console.log(`[Tips] Aktifkan sakelar Auto-Reply di Web Dashboard atau set AI_AUTO_REPLY=true di Railway Variables.`);
        console.log(`--------------------------------------------------\n`);
        return;
    }

    // Cegah proses ganda untuk message ID yang sama
    const msgId = msg.id?._serialized || msg.id?.id || `${from}_${Date.now()}`;
    if (processedMessages.has(msgId)) {
        console.log(`[AI Inbound] Pesan dengan ID ${msgId} sudah diproses sebelumnya.`);
        return;
    }
    processedMessages.add(msgId);
    if (processedMessages.size > 300) {
        const oldest = processedMessages.values().next().value;
        processedMessages.delete(oldest);
    }

    const currentState = userState.get(from) || 'MENU_UTAMA';
    const textLower = body.toLowerCase();

    // Selalu izinkan untuk kembali ke menu utama dari mana saja
    if (textLower === '0' || textLower === 'menu' || textLower === 'kembali') {
        userState.set(from, 'MENU_UTAMA');
        const menuMsg = `Selamat datang di *${knowledgeData.businessName || 'Rumah Etnik Papua'}*! 🛖🌿\nSilakan balas dengan mengetik *angka* pilihan menu di bawah ini:\n\n${knowledgeData.botMenu || '1️⃣ Harga Tiket Masuk & Layanan\n2️⃣ Daftar Paket Wisata\n3️⃣ Reservasi\n4️⃣ Hubungi Admin'}`;
        if (client) await client.sendMessage(from, menuMsg);
        return;
    }

    if (currentState === 'MENU_UTAMA') {
        if (textLower === '1') {
            const reply = `✨ *Info Harga* ✨\n\n${getKnowledgeTopic('Harga|Tarif', 'Silakan hubungi admin untuk detail harga terbaru.')}\n\n_(Ketik *0* untuk kembali ke Menu Utama)_`;
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '2') {
            userState.set(from, 'MENU_PAKET');
            const reply = "🎒 *Daftar Paket Rumah Etnik Papua* 🎒\n\nSilakan balas dengan mengetik *angka* sub-menu paket berikut:\n\n1️⃣ Paket Tour Group\n2️⃣ Paket Pengalaman Khusus (Saswar & Sopendo)\n3️⃣ Paket Wisata Edukasi (Sekolah/Kampus)\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '3') {
            const reply = "🛏️ *Informasi Kamar (Rumsram Homestay)* 🛏️\n\nFasilitas Gratis: Makan 2x, Snack 2x, Teras, Free Kostum, Kunjungan Rumah/Museum Tradisional.\n*(Tarif per orang, Kapasitas maks 2 orang/kamar)*\n\n• *Double Room AC*: Rp 1.100.000 (Kamar Mandi Dalam, ±15m²)\n• *Standar Room AC*: Rp 950.000 (Kamar Mandi Luas, ±9m²)\n• *Standar Non AC*: Rp 900.000 (Kamar Mandi Luas, ±9m²)\n• *Single*: Rp 550.000 (Non AC, Kamar Mandi Luas, ±9m²)\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '4') {
            const reply = "🎁 *Cinderamata & Kesenian* 🎁\n\n• *Kalung Kerang*: Diberikan gratis (bisa dibawa pulang) khusus pada Paket Sopendo.\n• *Noken & Mahkota*: Anda akan diajarkan cara membuatnya langsung pada Paket Sopendo & Paket Wisata Edukasi.\n• *Sewa Patung*: (Sebagai properti acara) Ukuran Sedang Rp 300.000/hari | Besar Rp 500.000/hari.\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '5') {
            const reply = "❓ *FAQ (Pertanyaan Umum)* ❓\n\n📍 *Lokasi:* Jl. Baru Aimas Klamono, Km 21 Kab. Sorong, Papua Barat Daya.\n🕒 *Jam Buka:* Senin-Sabtu 08.00-18.00 WIT | Minggu 12.00-18.00 WIT.\n👗 *Sewa Kostum Keluar:* Dlm kota Rp 170rb, Luar kota Rp 350rb (Syarat KTP & Jaminan 50%).\n🎪 *Sewa Tempat Acara:* Mulai Rp 1.000.000 s/d Rp 2.500.000 (termasuk sound, bangku, free tiket & karaoke).\n🍲 *Catering:* Tersedia Paket Snack (Rp 15rb) hingga Prasmanan (Rp 40rb).\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '6') {
            userState.set(from, 'AI_MODE');
            const reply = "🤖 *Asisten AI Rumah Etnik Papua*\n\nHalo Kaka! Saya adalah asisten virtual cerdas di sini. Silakan tanyakan hal lain seputar Rumah Etnik Papua yang mungkin belum ada di menu, atau minta rekomendasi!\n\n_(Ketik *0* kapan saja untuk mengakhiri sesi AI dan kembali ke menu utama)_";
            if (client) await client.sendMessage(from, reply);
        } else {
            // Tampilkan Menu Utama Default
            const menuMsg = `Selamat datang di *${knowledgeData.businessName || 'Rumah Etnik Papua'}*! 🛖🌿\nSilakan balas dengan mengetik *angka* pilihan menu di bawah ini:\n\n${knowledgeData.botMenu || '1️⃣ Harga Tiket Masuk & Layanan\n2️⃣ Daftar Paket Wisata\n3️⃣ Reservasi\n4️⃣ Hubungi Admin'}`;
            if (client) await client.sendMessage(from, menuMsg);
        }
    } else if (currentState === 'MENU_PAKET') {
        if (textLower === '1') {
            const reply = "👥 *Paket Tour Group* 👥\n\nTermasuk penyambutan, penggunaan kostum, tour museum/rumah, makanan ringan, tarian, & dokumentasi.\n\n• 1 - 5 Orang: Rp 3.000.000\n• 6 - 10 Orang: Rp 5.000.000\n• 11 - 15 Orang: Rp 6.700.000\n• 16 - 20 Orang: Rp 8.000.000\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '2') {
            const reply = "🌟 *Paket Pengalaman Khusus* 🌟\n\n• *Paket Saswar (Rp 799.000/orang)*\nTermasuk: Penyambutan, kostum lengkap dgn ukiran, tour, tarian, teh/kopi, dan aneka gorengan (kasbi, pisang).\n\n• *Paket Sopendo (Rp 949.000/orang) - PREMIUM*\nTermasuk: Penyambutan kalung kerang, praktek pembuatan Papeda/Sinole, praktek Noken & Mahkota, kuliner khas, dan jasa fotografer.\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else if (textLower === '3') {
            const reply = "🎓 *Paket Wisata Edukasi* 🎓\n\n(Minimal 10 orang. Termasuk: Kostum, menari, pengenalan museum/rumah, makanan tradisional, & kesenian)\n\n• TK: Rp 50.000/anak\n• SD: Rp 60.000/orang\n• SMP/SMA: Rp 70.000/orang\n• Mahasiswa: Rp 85.000/orang\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        } else {
            const reply = "Mohon maaf, pilihan tidak ada.\n\nSilakan pilih angka:\n1️⃣ Paket Tour Group\n2️⃣ Paket Pengalaman Khusus\n3️⃣ Paket Wisata Edukasi\n\n_(Ketik *0* untuk kembali ke Menu Utama)_";
            if (client) await client.sendMessage(from, reply);
        }
    } else if (currentState === 'AI_MODE') {
        // Cek API Key sebelum memanggil AI
        if (!aiConfig.apiKeys.length) {
            console.error(`[AI Auto-Reply GAGAL] API Key belum diisi! Silakan masukkan API Key di Web Dashboard.`);
            console.log(`--------------------------------------------------\n`);
            return;
        }

        console.log(`[AI Thinking] Memproses balasan dengan Gemini AI untuk: "${body}"...`);

        try {
            const aiReply = await generateAiResponse(body);
            if (aiReply) {
                let replyWithActions = aiReply;
                const managerPhone = String(knowledgeData.contactPhone || '').replace(/\D/g, '');
                const csPhone = String(knowledgeData.csPhone || knowledgeData.contactPhone || '').replace(/\D/g, '');
                if (/reserv|booking/i.test(body) && managerPhone) replyWithActions += `\n\n📅 *Reservasi:* https://wa.me/${managerPhone}`;
                if (/cs|admin|bicara|hubungi/i.test(body) && csPhone) replyWithActions += `\n\n👤 *Bicara dengan CS:* https://wa.me/${csPhone}`;
                console.log(`[AI Reply Generated]: "${aiReply.substring(0, 100)}..."`);
                await new Promise(r => setTimeout(r, 1500));
                
                try {
                    await msg.reply(replyWithActions);
                } catch (replyErr) {
                    console.warn(`[msg.reply failed, trying sendMessage]:`, replyErr.message);
                    if (client) await client.sendMessage(from, replyWithActions);
                }
                
                console.log(`[AI Auto-Reply SUKSES] Berhasil dikirim ke ${from}!`);
            }
        } catch (err) {
            console.error(`[AI Auto-Reply Error]:`, err.message);
            const errMsg = err.message || '';
            // Tangkap error limit / 429
            if (errMsg.includes('429') || errMsg.includes('Quota exceeded') || errMsg.includes('rate limit') || errMsg.includes('rate_limit')) {
                const waitMsg = "⏳ *Mohon Maaf Kaka*\n\nAsisten AI kami sedang melayani antrean pertanyaan yang sangat padat saat ini. Mohon tunggu beberapa menit dan kirimkan kembali pertanyaan Kaka ya 🙏. Terima kasih atas pengertiannya!";
                if (client) await client.sendMessage(from, waitMsg);
                console.log(`[AI Rate Limit] Mengirimkan pesan tunggu ke pelanggan.`);
            }
        }
    }
    console.log(`--------------------------------------------------\n`);
}

async function startWhatsAppClient() {
    let authStrategy;
    
    if (process.env.MONGODB_URI) {
        console.log('[Server] MONGODB_URI ditemukan. Menghubungkan ke MongoDB untuk sesi WhatsApp...');
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('[Server] MongoDB terhubung. Sesi akan disimpan permanen di database.');
            const store = new MongoStore({ mongoose: mongoose });
            authStrategy = new RemoteAuth({
                store: store,
                backupSyncIntervalMs: 300000 // Sinkronisasi setiap 5 menit
            });
        } catch (err) {
            console.error('[Server] Gagal terhubung ke MongoDB:', err.message);
            console.log('[Server] Fallback ke LocalAuth (Sesi File Lokal)...');
            authStrategy = new LocalAuth({ dataPath: sessionPath });
        }
    } else {
        console.log('[Server] MONGODB_URI tidak diatur. Menggunakan LocalAuth (Sesi File Lokal)...');
        authStrategy = new LocalAuth({ dataPath: sessionPath });
    }

    client = new Client({
        authStrategy: authStrategy,
        puppeteer: puppeteerConfig
    });

    // Event saat QR Code / Pairing Code siap
    client.on('qr', (qr) => {
        isClientReady = false;
        currentQr = qr;
        clientStatus = 'Siap ditautkan via Nomor HP atau QR Code';
        console.log('\n=============================================');
        console.log('[WHATSAPP SIAP] Buka http://localhost:3000 untuk menautkan via Nomor Telepon atau QR Code.');
        console.log('=============================================\n');
    });

    // Event saat Remote Auth berhasil disimpan
    client.on('remote_session_saved', () => {
        console.log('[WhatsApp] Sesi berhasil disimpan ke Database (MongoDB)!');
    });

    // Event saat proses autentikasi berhasil
    client.on('authenticated', () => {
        clientStatus = 'Autentikasi Berhasil! Menyiapkan data WhatsApp...';
        currentQr = null;
        currentPairingCode = null;
        console.log('[WhatsApp] Autentikasi berhasil!');
    });

    // Event jika autentikasi gagal
    client.on('auth_failure', (msg) => {
        isClientReady = false;
        currentQr = null;
        currentPairingCode = null;
        userInfo = null;
        clientStatus = 'Autentikasi Gagal. Silakan coba lagi.';
        console.error('[WhatsApp] Autentikasi gagal:', msg);
    });

    // Event saat WhatsApp siap digunakan untuk kirim pesan
    client.on('ready', () => {
        isClientReady = true;
        currentQr = null;
        currentPairingCode = null;
        clientStatus = 'WhatsApp Terhubung & Siap';
        
        if (client.info) {
            userInfo = {
                name: client.info.pushname || 'Akun WhatsApp',
                number: client.info.wid ? client.info.wid.user : ''
            };
            console.log(`[WhatsApp] Siap! Terhubung sebagai: ${userInfo.name} (+${userInfo.number})`);
        } else {
            userInfo = { name: 'WhatsApp Web', number: '' };
            console.log('[WhatsApp] Siap! Silakan buka http://localhost:3000');
        }
    });

    // Event saat koneksi terputus
    client.on('disconnected', (reason) => {
        isClientReady = false;
        currentQr = null;
        currentPairingCode = null;
        userInfo = null;
        clientStatus = 'Koneksi Terputus (' + reason + ')';
        console.log('[WhatsApp] Terputus:', reason);
    });

    // Event saat ada pesan WhatsApp masuk dari calon tamu / pelanggan
    client.on('message', async (msg) => {
        await handleIncomingMessage(msg, 'message');
    });

    // Event cadangan message_create untuk memastikan pesan selalu tertangkap
    client.on('message_create', async (msg) => {
        if (msg.fromMe) return; // Hanya tangkap pesan dari orang lain
        await handleIncomingMessage(msg, 'message_create');
    });

    // Jalankan client WhatsApp
    client.initialize().catch((err) => {
        console.error('[WhatsApp Init Error]:', err.message);
        clientStatus = 'Gagal inisialisasi: ' + err.message;
    });
}

startWhatsAppClient();

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Endpoint AI 1: Ambil Konfigurasi AI & Knowledge Base
app.get('/api/ai-config', requireAuth, (req, res) => {
    res.json({
        autoReply: aiConfig.autoReply,
        hasApiKey: aiConfig.apiKeys.length > 0,
        apiKeyCount: aiConfig.apiKeys.length,
        modelName: aiConfig.modelName,
        knowledge: knowledgeData
    });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
    managedAdmins = managedAdmins.map(normalizeAdminRecord);
    res.json({ stats: dashboardStats, inbox: Array.from(inboxContacts.values()), integrations, admins: managedAdmins });
});

app.post('/api/integrations', requireAuth, (req, res) => {
    const { platform, name, identifier, status } = req.body || {};
    if (!platform || !name) return res.status(400).json({ success: false, message: 'Platform dan nama akun wajib diisi.' });
    const item = { id: Date.now().toString(), platform, name, identifier: identifier || '-', status: status || 'Menunggu koneksi' };
    integrations.push(item);
    res.json({ success: true, integration: item, integrations });
});

app.delete('/api/integrations/:id', requireAuth, (req, res) => {
    integrations = integrations.filter(item => item.id !== req.params.id);
    res.json({ success: true, integrations });
});

app.get('/api/owner/admins', requireAuth, (req, res) => res.json({ success: true, admins: managedAdmins }));
app.get('/api/subscription', requireAuth, (req, res) => {
    const account = managedAdmins.find(item => item.email.toLowerCase() === String(req.query.email || '').toLowerCase());
    if (!account) return res.json({ success: true, subscription: null });
    const normalized = normalizeAdminRecord(account);
    res.json({ success: true, subscription: { packageName: normalized.packageName || '-', expiresAt: normalized.expiresAt, status: normalized.status } });
});
app.post('/api/owner/admins', requireAuth, (req, res) => {
    const { name, email, businessName, phone, durationDays } = req.body || {};
    if (!name || !email) return res.status(400).json({ success: false, message: 'Nama dan email admin wajib diisi.' });
    const duration = [3, 7, 14, 30].includes(Number(durationDays)) ? Number(durationDays) : 3;
    const adminRecord = normalizeAdminRecord({ id: Date.now().toString(), name, email, businessName: businessName || '-', phone: phone || '-', packageName: `${duration} Hari`, expiresAt: new Date(Date.now() + duration * 86400000).toISOString() });
    managedAdmins.push(adminRecord);
    saveManagedAdmins().then(() => res.json({ success: true, admin: adminRecord, admins: managedAdmins })).catch(error => res.status(500).json({ success: false, message: error.message }));
});

app.patch('/api/owner/admins/:id/extend', requireAuth, (req, res) => {
    const adminRecord = managedAdmins.find(item => item.id === req.params.id);
    const duration = Number(req.body?.durationDays);
    if (!adminRecord || ![3, 7, 14, 30].includes(duration)) return res.status(400).json({ success: false, message: 'Admin atau durasi tidak valid.' });
    const currentExpiry = new Date(adminRecord.expiresAt) > new Date() ? new Date(adminRecord.expiresAt) : new Date();
    adminRecord.expiresAt = new Date(currentExpiry.getTime() + duration * 86400000).toISOString();
    adminRecord.packageName = `${duration} Hari tambahan`;
    adminRecord.status = 'Aktif';
    saveManagedAdmins().then(() => res.json({ success: true, admin: adminRecord, admins: managedAdmins })).catch(error => res.status(500).json({ success: false, message: error.message }));
});

app.delete('/api/owner/admins/:id', requireAuth, (req, res) => {
    managedAdmins = managedAdmins.filter(item => item.id !== req.params.id);
    saveManagedAdmins().then(() => res.json({ success: true, admins: managedAdmins })).catch(error => res.status(500).json({ success: false, message: error.message }));
});

// Endpoint AI 2: Simpan Konfigurasi AI & Knowledge Base
app.post('/api/ai-config', requireAuth, async (req, res) => {
    const { apiKey, apiKeys, autoReply, knowledge, provider, modelName } = req.body;
    
    if (typeof autoReply === 'boolean') {
        aiConfig.autoReply = autoReply;
    }
    if (apiKeys !== undefined || apiKey !== undefined) {
        const submittedKeys = Array.isArray(apiKeys) ? apiKeys : String(apiKey || '').split(/[\n,]+/);
        aiConfig.apiKeys = submittedKeys.map(key => String(key).trim()).filter(Boolean);
    }
    if (provider) {
        aiConfig.provider = provider;
    }
    if (modelName !== undefined) {
        aiConfig.modelName = sanitizeAiModel(modelName);
    }
    if (knowledge && typeof knowledge === 'object') {
        knowledgeData = { ...knowledgeData, ...knowledge };
    }

    // Selalu simpan knowledgeData dan aiConfig ke Firestore / File
    knowledgeData.aiConfig = {
        apiKeys: aiConfig.apiKeys,
        provider: aiConfig.provider,
        autoReply: aiConfig.autoReply,
        modelName: aiConfig.modelName
    };
    try {
        if (db) {
            await db.collection('settings').doc('knowledge_base').set(knowledgeData);
            console.log(`[Firestore] AI Config Berhasil disimpan. Auto-Reply: ${aiConfig.autoReply ? 'AKTIF' : 'NONAKTIF'}`);
        } else {
            fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeData, null, 2), 'utf8');
            console.log(`[File] AI Config Berhasil disimpan ke ${KNOWLEDGE_FILE}. Auto-Reply: ${aiConfig.autoReply ? 'AKTIF' : 'NONAKTIF'}`);
        }
    } catch (e) {
        console.error('[Storage Error] Gagal menyimpan konfigurasi:', e.message);
    }

    res.json({
        success: true,
        message: 'Pengaturan Bot AI & Basis Pengetahuan Rumah Etnik Papua berhasil disimpan!',
        config: {
            autoReply: aiConfig.autoReply,
            hasApiKey: aiConfig.apiKeys.length > 0,
            apiKeyCount: aiConfig.apiKeys.length,
            provider: aiConfig.provider,
            modelName: aiConfig.modelName,
            knowledge: knowledgeData
        }
    });
});

// Endpoint AI 3: Uji Coba Chat Simulator AI dari Browser
app.post('/api/ai-test-chat', requireAuth, async (req, res) => {
    const { message } = req.body;
    if (!message || message.trim() === '') {
        return res.status(400).json({ success: false, message: 'Pesan pertanyaan tidak boleh kosong.' });
    }

    try {
        const reply = await generateAiResponse(message.trim());
        res.json({ success: true, reply });
    } catch (err) {
        console.error('[AI Simulator Error]:', err.message);
        res.status(500).json({ success: false, message: err.message || 'Terjadi kesalahan pada Gemini AI.' });
    }
});

// 1. Endpoint status & QR / Pairing Code untuk tampilan web
app.get('/status', requireAuth, (req, res) => {
    res.json({
        ready: isClientReady,
        status: clientStatus,
        qr: currentQr,
        pairingCode: currentPairingCode,
        user: userInfo
    });
});

// 2. Endpoint Meminta Kode Verifikasi Pairing (Input Nomor HP)
app.post('/request-pairing-code', requireAuth, async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: 'Nomor WhatsApp wajib diisi.' });
    }

    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
    } else if (cleanNumber.startsWith('8')) {
        cleanNumber = '628' + cleanNumber.substring(1);
    }

    if (cleanNumber.length < 10) {
        return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid (minimal 10 digit).' });
    }

    try {
        if (!client) {
            return res.status(503).json({ success: false, message: 'Client WhatsApp belum siap. Tunggu sampai server selesai menyiapkan sesi.' });
        }
        console.log(`[PAIRING] Meminta kode verifikasi untuk nomor: +${cleanNumber}`);
        clientStatus = `Meminta kode pairing untuk +${cleanNumber}...`;
        
        const pairingCode = await client.requestPairingCode(cleanNumber);
        currentPairingCode = pairingCode;
        clientStatus = `Kode verifikasi ${pairingCode} terbit. Menunggu dimasukkan di HP.`;
        
        console.log(`[PAIRING SUKSES] KODE VERIFIKASI: ${pairingCode}`);

        res.json({
            success: true,
            code: pairingCode,
            formattedNumber: cleanNumber,
            message: 'Kode verifikasi berhasil dibuat.'
        });
    } catch (err) {
        console.error('[PAIRING ERROR]', err.message);
        res.status(500).json({
            success: false,
            message: 'Gagal meminta kode verifikasi: ' + (err.message || err)
        });
    }
});

// 3. Endpoint untuk Logout / Ganti Akun WhatsApp
app.post('/logout', requireAuth, async (req, res) => {
    try {
        isClientReady = false;
        currentQr = null;
        currentPairingCode = null;
        userInfo = null;
        clientStatus = 'Sedang Logout...';
        
        await client.logout();
        console.log('[WhatsApp] Berhasil logout.');
        clientStatus = 'Menyiapkan sesi baru...';
        
        setTimeout(() => {
            client.initialize().catch(e => console.error('Re-init error:', e));
        }, 1500);
        
        res.json({ success: true, message: 'Berhasil logout. Silakan tautkan nomor baru.' });
    } catch (e) {
        console.error('[WhatsApp] Gagal logout:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 4. Endpoint Kirim Pesan Uji Coba (Single Test Message)
app.post('/send-test', requireAuth, async (req, res) => {
    const { phone, message } = req.body;
    
    if (!isClientReady) {
        return res.status(400).json({ 
            success: false, 
            message: 'WhatsApp belum terhubung. Silakan tautkan nomor terlebih dahulu.' 
        });
    }

    if (!phone || !message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nomor telepon dan pesan uji coba wajib diisi.' 
        });
    }

    let cleanNumber = String(phone).replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.substring(1);
    } else if (cleanNumber.startsWith('8')) {
        cleanNumber = '628' + cleanNumber.substring(1);
    }

    const numberId = cleanNumber + "@c.us";

    try {
        await client.sendMessage(numberId, message);
        console.log(`[TEST] Pesan uji coba berhasil dikirim ke: ${cleanNumber}`);
        res.json({ success: true, message: `Pesan uji coba berhasil terkirim ke +${cleanNumber}` });
    } catch (error) {
        console.error(`[TEST GAGAL] Gagal mengirim ke ${cleanNumber}:`, error.message);
        res.status(500).json({ success: false, message: error.message || 'Gagal mengirim pesan' });
    }
});

// 5. Endpoint Kirim Pesan Blast Massal dengan Laporan Detail per Kontak
app.post('/send-blast', requireAuth, async (req, res) => {
    const { contacts, messageTemplate } = req.body;
    let successCount = 0;
    let failedCount = 0;
    const reportDetails = [];

    if (!isClientReady) {
        return res.status(400).json({ 
            status: 'Error', 
            message: 'WhatsApp belum terhubung! Silakan tautkan nomor terlebih dahulu.' 
        });
    }

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ 
            status: 'Error', 
            message: 'Data kontak kosong atau tidak valid.' 
        });
    }

    console.log(`[BLAST] Memulai pengiriman pesan ke ${contacts.length} kontak...`);
    dashboardStats.activeProcesses++;
    dashboardStats.queued = contacts.length;

    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const rawNoWa = contact.NO_WA ? String(contact.NO_WA).trim() : '';
        const nama = contact.NAMA ? String(contact.NAMA).trim() : 'Tanpa Nama';
        const perusahaan = contact.PERUSAHAAN ? String(contact.PERUSAHAAN).trim() : '-';
        const video = contact.VIDEO ? String(contact.VIDEO).trim() : '';
        
        // Cek jika nomor kosong
        if (!rawNoWa) {
            failedCount++;
            dashboardStats.failedToday++;
            dashboardStats.queued = Math.max(0, dashboardStats.queued - 1);
            reportDetails.push({
                index: i,
                no_wa: '-',
                nama: nama,
                perusahaan: perusahaan,
                video: video,
                status: 'Gagal',
                reason: 'Nomor WhatsApp Kosong / Tidak Diisi'
            });
            console.log(`[${i + 1}/${contacts.length}] Gagal: Nomor kosong untuk ${nama}`);
            continue;
        }

        let cleanNumber = rawNoWa.replace(/\D/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.substring(1);
        } else if (cleanNumber.startsWith('8')) {
            cleanNumber = '628' + cleanNumber.substring(1);
        }

        // Cek validitas panjang nomor (Indonesia umumnya 10 - 14 digit dengan kode negara 62)
        if (cleanNumber.length < 9) {
            failedCount++;
            dashboardStats.failedToday++;
            dashboardStats.queued = Math.max(0, dashboardStats.queued - 1);
            reportDetails.push({
                index: i,
                no_wa: rawNoWa,
                nama: nama,
                perusahaan: perusahaan,
                video: video,
                status: 'Gagal',
                reason: 'Nomor terlalu pendek / tidak valid'
            });
            console.log(`[${i + 1}/${contacts.length}] Gagal: Nomor ${rawNoWa} terlalu pendek`);
            continue;
        }

        let finalMessage = (messageTemplate || '')
            .replace(/\[NAMA\]/g, contact.NAMA || '')
            .replace(/\[PERUSAHAAN\]/g, contact.PERUSAHAAN || '')
            .replace(/\[VIDEO\]/g, contact.VIDEO || '');
        Object.keys(contact).forEach((key, keyIndex) => {
            const value = contact[key] == null ? '' : String(contact[key]);
            finalMessage = finalMessage.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'gi'), value);
            finalMessage = finalMessage.replace(new RegExp(`\\{\\{${keyIndex + 1}\\}\\}`, 'g'), value);
        });
            
        const numberId = cleanNumber + "@c.us";
        
        try {
            await client.sendMessage(numberId, finalMessage);
            successCount++;
            dashboardStats.sentToday++;
            dashboardStats.queued = Math.max(0, dashboardStats.queued - 1);
            reportDetails.push({
                index: i,
                no_wa: cleanNumber,
                nama: nama,
                perusahaan: perusahaan,
                video: video,
                status: 'Sukses',
                reason: 'Terkirim'
            });
            console.log(`[${i + 1}/${contacts.length}] Sukses terkirim ke: ${nama} (+${cleanNumber})`);
            
            // Jeda 3 detik per pesan untuk keamanan anti-ban WhatsApp
            if (i < contacts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        } catch (error) {
            failedCount++;
            dashboardStats.failedToday++;
            dashboardStats.queued = Math.max(0, dashboardStats.queued - 1);
            const errRaw = String(error.message || error);
            let friendlyReason = 'Gagal mengirim pesan';

            if (errRaw.includes('No LID for user') || errRaw.includes('wid') || errRaw.includes('not registered') || errRaw.includes('Evaluation failed')) {
                friendlyReason = 'Nomor tidak terdaftar di WhatsApp';
            } else if (errRaw.includes('Rate limit') || errRaw.includes('ban')) {
                friendlyReason = 'Dibatasi oleh WhatsApp (Rate Limit)';
            } else {
                friendlyReason = errRaw;
            }

            reportDetails.push({
                index: i,
                no_wa: cleanNumber,
                nama: nama,
                perusahaan: perusahaan,
                video: video,
                status: 'Gagal',
                reason: friendlyReason
            });
            console.log(`[${i + 1}/${contacts.length}] Gagal mengirim ke +${cleanNumber} (${nama}): ${friendlyReason}`);
        }
    }
    
    console.log(`[BLAST SELESAI] Terkirim: ${successCount}, Gagal/Skip: ${failedCount}, Total: ${contacts.length}`);
    dashboardStats.activeProcesses = Math.max(0, dashboardStats.activeProcesses - 1);

    res.json({ 
        status: 'Selesai', 
        terkirim: successCount, 
        gagal: failedCount,
        total: contacts.length,
        details: reportDetails
    });
});