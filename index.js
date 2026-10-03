const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ফায়ারবেজ এডমিন ইনিশিয়ালাইজেশন
if (!admin.apps.length) {
    admin.initializeApp({
        databaseURL: "https://mega-income-bot-default-rtdb.firebaseio.com"
    });
}
const db = admin.database();

const app = express();

// CORS ও JSON পার্সার মিডলওয়্যার
app.use(cors());
app.use(express.json());

// হোম রুট (যাতে ব্রাউজারে 'Cannot GET /' না দেখায়)
app.get('/', (req, res) => {
    res.status(200).send('Mega Income Bot Backend Status: Live & Running!');
});

// সক্রিয় সকেট সেভ রাখার অবজেক্ট
const sessions = {};

// হোয়াটসঅ্যাপ সকেট কানেকশন ও ইভেন্ট হ্যান্ডলার
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
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sessions[phone] = sock;

    // ক্রেনডেনশিয়াল আপডেট ইভেন্ট
    sock.ev.on('creds.update', saveCreds);

    // কানেকশন স্টেট আপডেট ইভেন্ট (Login / Logout / Ban Detection)
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

// ১. আসল পেয়ারিং কোড তৈরির রুট
app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const sock = await getOrCreateSocket(phone);

        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phone);
                    
                    await db.ref(`whatsapp_accounts/${phone}`).set({
                        status: 'pending',
                        requestedAt: Date.now()
                    });

                    return res.json({ success: true, code: code });
                } catch (codeErr) {
                    return res.status(500).json({ success: false, error: 'কোড তৈরি করতে ব্যর্থ হয়েছে: ' + codeErr.message });
                }
            }, 3000);
        } else {
            return res.json({ success: false, error: 'এই নম্বরটি ইতিমধ্যে লিঙ্কড করা আছে।' });
        }
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
