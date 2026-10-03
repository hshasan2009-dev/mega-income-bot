const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

async function getOrCreateSocket(phone) {
    if (sessions[phone] && sessions[phone].ws.readyState === 1) {
        return sessions[phone];
    }

    const sessionDir = path.join(__dirname, 'sessions', phone);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sessions[phone] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`[WhatsApp] ${phone} নম্বরটি সফলভাবে লিঙ্কড হয়েছে!`);
            await db.ref(`whatsapp_accounts/${phone}`).set({
                status: 'linked',
                linkedAt: Date.now()
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[WhatsApp] ${phone} ডিসকানেক্ট হয়েছে। কারণ:`, statusCode);

            if (isLoggedOut) {
                console.log(`[WhatsApp] ${phone} অ্যাকাউন্টটি লগআউট বা ব্যান করা হয়েছে।`);
                await db.ref(`whatsapp_accounts/${phone}`).set({
                    status: 'logged_out',
                    disconnectedAt: Date.now()
                });

                delete sessions[phone];

                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } else {
                delete sessions[phone];
            }
        }
    });

    return sock;
}

// ১. পেয়ারিং কোড তৈরির আপডেটেড রুট (সমস্যা সমাধান কোড)
app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const sessionDir = path.join(__dirname, 'sessions', phone);
        
        // পুরাতন অসমাপ্ত সেশন থাকলে ডিলেট করে ফ্রেশ স্টার্ট করা
        if (sessions[phone]) {
            try { sessions[phone].end(); } catch(e){}
            delete sessions[phone];
        }
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const sock = await getOrCreateSocket(phone);

        // সকেট কানেক্ট হওয়া পর্যন্ত সর্বোচ্চ ১০ সেকেন্ড অপেক্ষা করে কোড রিকোয়েস্ট
        let attempts = 0;
        const checkAndRequestCode = async () => {
            try {
                if (!sock.authState.creds.registered) {
                    const code = await sock.requestPairingCode(phone);
                    
                    await db.ref(`whatsapp_accounts/${phone}`).set({
                        status: 'pending',
                        requestedAt: Date.now()
                    });

                    return res.json({ success: true, code: code });
                } else {
                    return res.json({ success: false, error: 'এই নম্বরটি ইতিমধ্যে লিঙ্কড করা আছে।' });
                }
            } catch (err) {
                attempts++;
                if (attempts < 5) {
                    setTimeout(checkAndRequestCode, 2000);
                } else {
                    return res.status(500).json({ success: false, error: 'কোড পেতে সমস্যা হচ্ছে, পুনরায় চেষ্টা করুন: ' + err.message });
                }
            }
        };

        setTimeout(checkAndRequestCode, 2000);

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ২. ব্যাকগ্রাউন্ড মেসেজ পাঠানো ও রিওয়ার্ড দেওয়ার রুট
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
                error: 'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে। অনুগ্রহ করে আবার লিঙ্ক করুন।' 
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
        console.error(`[Message Error] ${senderPhone} থেকে মেসেজ পাঠানো যায়নি:`, err.message);
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
