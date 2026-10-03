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
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ফায়ারবেজ এডমিন ইনিশিয়ালাইজেশন
if (!admin.apps.length) {
    admin.initializeApp({
        databaseURL: "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com"
    });
}
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Mega Income Bot Backend Status: Live & Running!');
});

const sessions = {};

// পেয়ারিং কোড জেনারেটর
async function generatePairingCode(phone) {
    const sessionDir = path.join(__dirname, 'sessions', phone);

    // পুরাতন সেশন মুছে ফেলা
    if (sessions[phone]) {
        try { sessions[phone].end(); } catch (e) {}
        delete sessions[phone];
    }
    if (fs.existsSync(sessionDir)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 60000
    });

    sessions[phone] = sock;
    sock.ev.on('creds.update', saveCreds);

    // কানেকশন লিসেনার
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`[WhatsApp] ${phone} লিঙ্কড হয়েছে!`);
            await db.ref(`whatsapp_accounts/${phone}`).set({
                status: 'linked',
                linkedAt: Date.now()
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            if (isLoggedOut) {
                await db.ref(`whatsapp_accounts/${phone}`).set({
                    status: 'logged_out',
                    disconnectedAt: Date.now()
                });

                delete sessions[phone];
                if (fs.existsSync(sessionDir)) {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                }
            } else {
                delete sessions[phone];
            }
        }
    });

    // ৩ সেকেন্ড সকেট রেডি হওয়ার পর কোড ফেচ করা
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!sock.authState.creds.registered) {
        const code = await sock.requestPairingCode(phone);
        await db.ref(`whatsapp_accounts/${phone}`).set({
            status: 'pending',
            requestedAt: Date.now()
        });
        return code;
    } else {
        throw new Error('এই নম্বরটি ইতিমধ্যে লিঙ্কড আছে।');
    }
}

// API Endpoint
app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const code = await generatePairingCode(phone);
        return res.json({ success: true, code: code });
    } catch (err) {
        console.error("[Pairing Error]:", err.message);
        return res.status(500).json({ success: false, error: err.message || 'কোড পাওয়া যায়নি, আবার চেষ্টা করুন।' });
    }
});

// ব্যাকগ্রাউন্ড মেসেজ রুট
app.post('/api/send-message', async (req, res) => {
    let { senderPhone, targetPhone, message, userId } = req.body;

    if (!senderPhone || !targetPhone || !message) {
        return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    senderPhone = senderPhone.replace(/[^0-9]/g, '');
    targetPhone = targetPhone.replace(/[^0-9]/g, '');

    try {
        const snapshot = await db.ref(`whatsapp_accounts/${senderPhone}`).once('value');
        const accountData = snapshot.val();

        if (!accountData || accountData.status !== 'linked') {
            return res.json({ 
                success: false, 
                reward: 0, 
                status: 'Unlinked or Logged Out', 
                error: 'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে।' 
            });
        }

        const sock = sessions[senderPhone];
        if (!sock) {
            return res.json({ success: false, reward: 0, status: 'Failed', error: 'সেশনটি অ্যাক্টিভ নেই, পুনরায় লিঙ্ক করুন।' });
        }

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
