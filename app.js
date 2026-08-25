require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
app.listen(PORT, () => console.log(`[Server] Berjalan di http://localhost:${PORT}. Buka browser di http://localhost:${PORT}`));

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
        knowledgeData = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    } catch (e) {
        console.error('[AI] Gagal membaca knowledge_base.json:', e.message);
    }
}

let aiConfig = {
    apiKey: process.env.GEMINI_API_KEY || '',
    autoReply: process.env.AI_AUTO_REPLY === 'true',
    modelName: 'gemini-3.6-flash'
};

let isClientReady = false;
let clientStatus = 'Menyiapkan sesi WhatsApp...';
let currentQr = null;
let currentPairingCode = null;
let userInfo = null;

// Fungsi Pintar: Generate Balasan Gemini AI Berdasarkan Knowledge Base Rumah Etnik Papua
async function generateAiResponse(userMessage) {
    const key = aiConfig.apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error('Gemini API Key belum diatur. Silakan masukkan API Key di menu Bot AI.');
    }

    const genAI = new GoogleGenerativeAI(key);
    
    const fullSystemInstruction = `${knowledgeData.systemInstruction || 'Anda adalah Asisten Virtual Resmi Rumah Etnik Papua.'}

=== BASIS PENGETAHUAN RESMI RUMAH ETNIK PAPUA ===
${knowledgeData.knowledgeText || ''}

=== PANDUAN MENJAWAB ===
1. Jawablah dengan nada bicara yang ramah, sopan, bersahabat, dan mencerminkan keramahan khas tanah Papua (misal gunakan sapaan hangat 'Halo Kaka', 'Bapak/Ibu', dll).
2. Gunakan emoji yang selaras (🌿, 🏞️, 🛖, ✨, 🙏) agar pesan WhatsApp terasa hidup dan natural.
3. Jawab secara ringkas, to-the-point, dan mudah dipahami di layar HP.
4. Jika pengunjung ingin melakukan reservasi/booking, tanyakan tanggal rencana kunjungan dan berapa orang, lalu sarankan untuk konfirmasi langsung ke nomor WhatsApp Pengelola: ${knowledgeData.contactPhone || '0811-4600-1602'}.
5. Jika ada pertanyaan di luar konteks wisata/budaya/layanan Rumah Etnik Papua, jawab dengan sopan bahwa Anda adalah asisten khusus Rumah Etnik Papua.`;

    const candidateModels = [
        aiConfig.modelName || 'gemini-3.6-flash',
        'gemini-3.6-flash',
        'gemini-2.5-flash',
        'gemini-1.5-flash'
    ];

    let lastError = null;
    for (const modelName of [...new Set(candidateModels)]) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: fullSystemInstruction
            });
            const result = await model.generateContent(userMessage);
            return result.response.text();
        } catch (err) {
            lastError = err;
            console.warn(`[AI Model Fallback] Gagal dengan model ${modelName}:`, err.message);
        }
    }

    throw lastError || new Error('Gagal menghasilkan balasan AI.');
}

// Simpan sesi di AppData Local agar tidak terkunci oleh Microsoft OneDrive
const sessionPath = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\abdyf\\AppData\\Local', 'wa-blast-session');
console.log('[Server] Lokasi Sesi WhatsApp:', sessionPath);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
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
    }
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

// Event saat ada pesan WhatsApp masuk dari calon tamu / pelanggan
client.on('message', async (msg) => {
    // Abaikan jika fitur auto-reply AI sedang dimatikan
    if (!aiConfig.autoReply) return;

    // Abaikan pesan dari grup, broadcast status, atau pesan dari bot sendiri
    if (msg.from.includes('@g.us') || msg.isStatus || msg.fromMe) return;

    const messageText = msg.body ? msg.body.trim() : '';
    if (!messageText) return;

    console.log(`\n[WA Pesan Masuk dari ${msg.from}]: "${messageText}"`);

    try {
        const aiReply = await generateAiResponse(messageText);
        if (aiReply) {
            // Beri jeda manusiawi 1.5 detik agar respon terasa natural
            await new Promise(r => setTimeout(r, 1500));
            await msg.reply(aiReply);
            console.log(`[AI Auto-Reply Terkirim ke ${msg.from}]: "${aiReply.substring(0, 80)}..."\n`);
        }
    } catch (err) {
        console.error('[AI Auto-Reply Error]:', err.message);
    }
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
app.get('/api/ai-config', (req, res) => {
    res.json({
        autoReply: aiConfig.autoReply,
        hasApiKey: !!(aiConfig.apiKey || process.env.GEMINI_API_KEY),
        modelName: aiConfig.modelName,
        knowledge: knowledgeData
    });
});

// Endpoint AI 2: Simpan Konfigurasi AI & Knowledge Base
app.post('/api/ai-config', (req, res) => {
    const { apiKey, autoReply, knowledge } = req.body;
    
    if (typeof autoReply === 'boolean') {
        aiConfig.autoReply = autoReply;
    }
    if (apiKey !== undefined && apiKey.trim() !== '') {
        aiConfig.apiKey = apiKey.trim();
    }
    if (knowledge && typeof knowledge === 'object') {
        knowledgeData = { ...knowledgeData, ...knowledge };
        
        // Simpan ke file knowledge_base.json
        try {
            fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledgeData, null, 2), 'utf8');
        } catch (e) {
            console.error('[AI] Gagal menyimpan knowledge_base.json:', e.message);
        }
    }

    res.json({
        success: true,
        message: 'Pengaturan Bot AI & Basis Pengetahuan Rumah Etnik Papua berhasil disimpan!',
        config: {
            autoReply: aiConfig.autoReply,
            hasApiKey: !!(aiConfig.apiKey || process.env.GEMINI_API_KEY),
            knowledge: knowledgeData
        }
    });
});

// Endpoint AI 3: Uji Coba Chat Simulator AI dari Browser
app.post('/api/ai-test-chat', async (req, res) => {
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
app.get('/status', (req, res) => {
    res.json({
        ready: isClientReady,
        status: clientStatus,
        qr: currentQr,
        pairingCode: currentPairingCode,
        user: userInfo
    });
});

// 2. Endpoint Meminta Kode Verifikasi Pairing (Input Nomor HP)
app.post('/request-pairing-code', async (req, res) => {
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
app.post('/logout', async (req, res) => {
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
app.post('/send-test', async (req, res) => {
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
app.post('/send-blast', async (req, res) => {
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