const express = require('express');
const cors = require('cors');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const FIREBASE_DB_URL = "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";

// ফায়ারবেজ হেলপার
async function updateFirebaseNode(pathNode, data) {
    try {
        await fetch(`${FIREBASE_DB_URL}/${pathNode}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error("Firebase update error:", e.message);
    }
}

async function getFirebaseNode(pathNode) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathNode}.json`);
        return await res.json();
    } catch (e) {
        return null;
    }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Mega Income Bot Backend Status: Live & Running!');
});

const sessions = {};

// সকেট তৈরি ও অ্যাক্টিভ রাখা
async function getOrCreateSocket(phone) {
    if (sessions[phone] && sessions[phone].ws && sessions[phone].ws.readyState === 1) {
        return sessions[phone];
    }

    const sessionDir = path.join(__dirname, 'sessions', phone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000
    });

    sessions[phone] = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`[WhatsApp] ${phone} লিঙ্কড হয়েছে!`);
            await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
                status: 'linked',
                linkedAt: Date.now()
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            if (isLoggedOut) {
                await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
                    status: 'logged_out',
                    disconnectedAt: Date.now()
                });

                delete sessions[phone];
                if (fs.existsSync(sessionDir)) {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                }
            } else {
                // সাময়িক ডিসকানেক্ট হলে মেমোরি ক্লিয়ার করে রিকানেক্ট সুযোগ রাখা
                delete sessions[phone];
            }
        }
    });

    return sock;
}

// ১. সঠিক পেয়ারিং কোড জেনারেটর রুট
app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });

    // শুধুমাত্র ডিজিট রাখা (যেমন: 8801337176976)
    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) {
        phone = '88' + phone;
    }

    const sessionDir = path.join(__dirname, 'sessions', phone);

    // আগের কোনো ইনকমপ্লিট সেশন ফোল্ডার থাকলে রিমুভ করা
    if (sessions[phone]) {
        try { sessions[phone].end(); } catch (e) {}
        delete sessions[phone];
    }
    if (fs.existsSync(sessionDir)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    }

    try {
        const sock = await getOrCreateSocket(phone);

        // সকেট ইনিশিয়ালাইজ হওয়ার জন্য ৪ সেকেন্ড অপেক্ষা
        await new Promise(r => setTimeout(r, 4000));

        if (!sock.authState.creds.registered) {
            const code = await sock.requestPairingCode(phone);
            
            await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
                status: 'pending',
                requestedAt: Date.now()
            });

            return res.json({ success: true, code: code });
        } else {
            return res.json({ success: false, error: 'এই নম্বরটি ইতিমধ্যে লিঙ্কড আছে।' });
        }

    } catch (err) {
        console.error("[Pairing Error]:", err.message);
        return res.status(500).json({ success: false, error: 'কোড পেতে সমস্যা হয়েছে: ' + err.message });
    }
});

// ২. ব্যাকগ্রাউন্ড মেসেজ রুট
app.post('/api/send-message', async (req, res) => {
    let { senderPhone, targetPhone, message, userId } = req.body;

    if (!senderPhone || !targetPhone || !message) {
        return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    senderPhone = senderPhone.replace(/[^0-9]/g, '');
    if (senderPhone.startsWith('0')) senderPhone = '88' + senderPhone;

    targetPhone = targetPhone.replace(/[^0-9]/g, '');
    if (targetPhone.startsWith('0')) targetPhone = '88' + targetPhone;

    try {
        const accountData = await getFirebaseNode(`whatsapp_accounts/${senderPhone}`);

        if (!accountData || accountData.status !== 'linked') {
            return res.json({ 
                success: false, 
                reward: 0, 
                status: 'Unlinked or Logged Out', 
                error: 'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে।' 
            });
        }

        const sock = await getOrCreateSocket(senderPhone);
        const jid = `${targetPhone}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: message });

        if (sent) {
            return res.json({ success: true, reward: 2, status: 'Sent' });
        } else {
            return res.json({ success: false, reward: 0, status: 'Failed' });
        }
    } catch (err) {
        return res.json({ 
            success: false, 
            reward: 0, 
            status: 'Failed', 
            error: err.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
