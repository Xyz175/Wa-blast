require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

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

const db = admin.apps.length > 0 ? admin.firestore() : null;

// Middleware Autentikasi Firebase
async function requireAuth(req, res, next) {
    if (!admin.apps.length) {
        // Jika tidak ada firebase, bypass auth untuk backward compatibility
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Akses Ditolak. Token tidak ditemukan.' });
    }

    const idToken = authHeader.split('Bearer ')[1];
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

// Konfigurasi CORS agar frontend (baik via http://localhost:3000 maupun file:///) dapat mengakses API
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
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

// Path file database pengetahuan AI
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge_base.json');
let knowledgeData = {
    businessName: "Rumah Etnik Papua",
    tagline: "Pusat Wisata Budaya, Homestay Etnik, & Pengalaman Autentik Tanah Papua",
    location: "Sorong, Papua Barat Daya (Gerbang Wisata Raja Ampat)",
    contactPhone: "+62 811-4600-1602",
    systemInstruction: "Anda adalah Asisten Virtual Resmi 'Rumah Etnik Papua' yang ramah, hangat, dan informatif.",
    knowledgeText: ""
};

if (fs.existsSync(KNOWLEDGE_FILE)) {
    try {
        const rawKnowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        knowledgeData = { ...knowledgeData, ...rawKnowledge };
        // Ambil aiConfig yang tersimpan jika ada
        if (rawKnowledge.aiConfig) {
            aiConfig = {
                apiKey: rawKnowledge.aiConfig.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '',
                provider: rawKnowledge.aiConfig.provider || process.env.AI_PROVIDER || 'auto',
                autoReply: typeof rawKnowledge.aiConfig.autoReply === 'boolean' 
                    ? rawKnowledge.aiConfig.autoReply 
                    : (process.env.AI_AUTO_REPLY === 'true'),
                modelName: rawKnowledge.aiConfig.modelName || ''
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
            if (data.aiConfig) {
                aiConfig = { ...aiConfig, ...data.aiConfig };
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
if (!aiConfig.apiKey) {
    aiConfig.apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';
}
if (process.env.AI_AUTO_REPLY === 'true') {
    aiConfig.autoReply = true;
}

console.log(`[AI Bot] Status Auto-Reply Awal: ${aiConfig.autoReply ? 'AKTIF 🟢' : 'NONAKTIF ⚪'}`);
console.log(`[AI Bot] API Key Terpasang: ${aiConfig.apiKey ? 'Ya (' + aiConfig.apiKey.substring(0, 8) + '...)' : 'Belum diatur ⚠️'}`);

let isClientReady = false;
let clientStatus = 'Menyiapkan sesi WhatsApp...';
let currentQr = null;
let currentPairingCode = null;
let userInfo = null;

// Fungsi Khusus: Memanggil Groq Cloud AI (Llama 3.3 70B & Llama 3.1 8B) - Super Cepat & Kuota Gratis 14.400 req/hari
async function callGroqAi(apiKey, systemInstruction, userMessage) {
    const candidateModels = [
        aiConfig.modelName || 'llama-3.3-70b-versatile',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'llama3-70b-8192',
        'mixtral-8x7b-32768',
        'gemma2-9b-it'
    ];

    let lastError = null;
    for (const model of [...new Set(candidateModels)]) {
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
    const candidateModels = [
        aiConfig.modelName || 'gemini-1.5-flash',
        'gemini-1.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-pro'
    ];

    let lastError = null;
    for (const modelName of [...new Set(candidateModels)]) {
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
    const rawKeys = (aiConfig.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    if (!rawKeys) {
        throw new Error('API Key belum diatur. Silakan masukkan Groq API Key (gsk_...) di menu Bot AI.');
    }

    // Pisahkan jika pengguna memasukkan beberapa API Key (dipisah koma atau baris baru)
    const keyList = rawKeys.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);

    const fullSystemInstruction = `${knowledgeData.systemInstruction || 'Anda adalah Asisten Virtual Resmi Rumah Etnik Papua.'}

=== BASIS PENGETAHUAN RESMI RUMAH ETNIK PAPUA ===
${knowledgeData.knowledgeText || ''}

=== PANDUAN MENJAWAB ===
1. Jawablah dengan nada bicara yang ramah, sopan, bersahabat, dan mencerminkan keramahan khas tanah Papua (misal gunakan sapaan hangat 'Halo Kaka', 'Bapak/Ibu', dll).
2. Gunakan emoji yang selaras (🌿, 🏞️, 🛖, ✨, 🙏) agar pesan WhatsApp terasa hidup dan natural.
3. Jawab secara ringkas, to-the-point, dan mudah dipahami di layar HP.
4. Jika pengunjung ingin melakukan reservasi/booking, tanyakan tanggal rencana kunjungan dan berapa orang, lalu sarankan untuk konfirmasi langsung ke nomor WhatsApp Pengelola: ${knowledgeData.contactPhone || '0811-4600-1602'}.
5. Jika ada pertanyaan di luar konteks wisata/budaya/layanan Rumah Etnik Papua, jawab dengan sopan bahwa Anda adalah asisten khusus Rumah Etnik Papua.`;

    let lastError = null;

    // Coba setiap API Key yang dimasukkan
    for (let kIdx = 0; kIdx < keyList.length; kIdx++) {
        const activeKey = keyList[kIdx];
        const isGroq = activeKey.startsWith('gsk_') || aiConfig.provider === 'groq' || (!activeKey.startsWith('AIza') && activeKey.length > 20);

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
        '--disable-gpu'
    ]
};

// Jika berjalan di container Docker (Railway / Render) yang menggunakan Chromium bawaan sistem
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
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

// Set untuk mencegah duplikasi balasan jika event terpanggil ganda
const processedMessages = new Set();

// Handler terpusat untuk memproses pesan masuk WhatsApp
async function handleIncomingMessage(msg, eventSource) {
    if (!msg) return;

    const from = msg.from || '';
    const body = msg.body ? msg.body.trim() : '';
    const isFromMe = msg.fromMe;
    const isGroup = from.includes('@g.us');
    const isStatus = msg.isStatus || from === 'status@broadcast';

    // Log setiap aktivitas pesan masuk ke console / Railway logs
    console.log(`\n--------------------------------------------------`);
    console.log(`[WhatsApp Inbound (${eventSource})] Pengirim: ${from} | fromMe: ${isFromMe} | Tipe: ${msg.type}`);
    console.log(`[WhatsApp Inbound] Pesan: "${body || '<Media/Non-text>'}"`);

    // 1. Abaikan jika pesan dikirim dari diri sendiri (bot sendiri)
    if (isFromMe) {
        console.log(`[Filter Inbound] Pesan berasal dari akun bot sendiri (fromMe: true). Diabaikan.`);
        console.log(`--------------------------------------------------\n`);
        return;
    }

    // 2. Abaikan pesan dari grup atau status
    if (isGroup) {
        console.log(`[Filter Inbound] Pesan dari grup (${from}) diabaikan.`);
        console.log(`--------------------------------------------------\n`);
        return;
    }
    if (isStatus) {
        console.log(`[Filter Inbound] Status update diabaikan.`);
        console.log(`--------------------------------------------------\n`);
        return;
    }

    // 3. Pastikan ada teks
    if (!body) {
        console.log(`[Filter Inbound] Pesan tidak memiliki teks (stiker/audio/gambar).`);
        console.log(`--------------------------------------------------\n`);
        return;
    }

    // 4. Cek apakah fitur Auto-Reply aktif
    if (!aiConfig.autoReply) {
        console.log(`[AI Auto-Reply DILEWATI] Fitur Auto-Reply saat ini NONAKTIF (aiConfig.autoReply = false).`);
        console.log(`[Tips] Aktifkan sakelar Auto-Reply di Web Dashboard atau set AI_AUTO_REPLY=true di Railway Variables.`);
        console.log(`--------------------------------------------------\n`);
        return;
    }

    // 5. Cek apakah API Key sudah terpasang
    const apiKey = (aiConfig.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        console.error(`[AI Auto-Reply GAGAL] API Key belum diisi! Silakan masukkan Groq API Key di Web Dashboard.`);
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

    console.log(`[AI Thinking] Memproses balasan dengan Groq AI / Gemini untuk: "${body}"...`);

    try {
        const aiReply = await generateAiResponse(body);
        if (aiReply) {
            console.log(`[AI Reply Generated]: "${aiReply.substring(0, 100)}..."`);
            
            // Jeda 1.5 detik agar respon natural
            await new Promise(r => setTimeout(r, 1500));
            
            try {
                await msg.reply(aiReply);
            } catch (replyErr) {
                console.warn(`[msg.reply failed, trying sendMessage]:`, replyErr.message);
                await client.sendMessage(from, aiReply);
            }
            
            console.log(`[AI Auto-Reply SUKSES] Berhasil dikirim ke ${from}!`);
        }
    } catch (err) {
        console.error(`[AI Auto-Reply Error]:`, err.message);
    }
    console.log(`--------------------------------------------------\n`);
}

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

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Endpoint AI 1: Ambil Konfigurasi AI & Knowledge Base
app.get('/api/ai-config', requireAuth, (req, res) => {
    res.json({
        autoReply: aiConfig.autoReply,
        hasApiKey: !!(aiConfig.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
        modelName: aiConfig.modelName,
        knowledge: knowledgeData
    });
});

// Endpoint AI 2: Simpan Konfigurasi AI & Knowledge Base
app.post('/api/ai-config', requireAuth, async (req, res) => {
    const { apiKey, autoReply, knowledge, provider, modelName } = req.body;
    
    if (typeof autoReply === 'boolean') {
        aiConfig.autoReply = autoReply;
    }
    if (apiKey !== undefined && apiKey.trim() !== '') {
        aiConfig.apiKey = apiKey.trim();
    }
    if (provider) {
        aiConfig.provider = provider;
    }
    if (modelName !== undefined) {
        aiConfig.modelName = modelName;
    }
    if (knowledge && typeof knowledge === 'object') {
        knowledgeData = { ...knowledgeData, ...knowledge };
    }

    // Selalu simpan knowledgeData dan aiConfig ke Firestore / File
    knowledgeData.aiConfig = {
        apiKey: aiConfig.apiKey,
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
            hasApiKey: !!(aiConfig.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
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

    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const rawNoWa = contact.NO_WA ? String(contact.NO_WA).trim() : '';
        const nama = contact.NAMA ? String(contact.NAMA).trim() : 'Tanpa Nama';
        const perusahaan = contact.PERUSAHAAN ? String(contact.PERUSAHAAN).trim() : '-';
        const video = contact.VIDEO ? String(contact.VIDEO).trim() : '';
        
        // Cek jika nomor kosong
        if (!rawNoWa) {
            failedCount++;
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
            
        const numberId = cleanNumber + "@c.us";
        
        try {
            await client.sendMessage(numberId, finalMessage);
            successCount++;
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

    res.json({ 
        status: 'Selesai', 
        terkirim: successCount, 
        gagal: failedCount,
        total: contacts.length,
        details: reportDetails
    });
});