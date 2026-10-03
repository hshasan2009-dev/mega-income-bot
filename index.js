const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ফায়ারবেজ ইনিশিয়ালাইজেশন
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

// ১. সঠিক নিয়মে পেয়ারিং কোড জেনারেটর ফংশন
function getPairingCode(phone) {
    return new Promise(async (resolve, reject) => {
        const sessionDir = path.join(__dirname, 'sessions', phone);

        // পুরাতন সেশন ও মেমোরি ক্লিনআপ
        if (sessions[phone]) {
            try { sessions[phone].end(); } catch (e) {}
            delete sessions[phone];
        }
        if (fs.existsSync(sessionDir)) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000
            });

            sessions[phone] = sock;
            sock.ev.on('creds.update', saveCreds);

            let codeRequested = false;

            // কানেকশন লিসেনার (যেখানে সঠিক সময়ে কোড রিকোয়েস্ট করতে হয়)
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // সকেট যখন QR ইমিট করবে (মানে সকেট এখন পেয়ারিং কোড নেওয়ার জন্য সম্পূর্ণ প্রস্তুত)
                if (qr && !sock.authState.creds.registered && !codeRequested) {
                    codeRequested = true;
                    try {
                        // সকেট রেডি হওয়ার পর পেয়ারিং কোড রিকোয়েস্ট
                        const code = await sock.requestPairingCode(phone);
                        
                        await db.ref(`whatsapp_accounts/${phone}`).set({
                            status: 'pending',
                            requestedAt: Date.now()
                        });

                        resolve({ success: true, code: code });
                    } catch (codeErr) {
                        reject(new Error("কোড জেনারেট করতে ব্যর্থ: " + codeErr.message));
                    }
                }

                if (connection === 'open') {
                    console.log(`[WhatsApp] ${phone} নম্বরটি লিঙ্কড হয়েছে!`);
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
                            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e){}
                        }
                    } else {
                        delete sessions[phone];
                    }
                }
            });

            // ১৫ সেকেন্ডের টাইমআউট সিকিউরিটি (যদি কোনো কারণে হ্যাটশেক না হয়)
            setTimeout(() => {
                if (!codeRequested) {
                    reject(new Error("WhatsApp সার্ভার থেকে সাড়া পাওয়া যায়নি। আবার চেষ্টা করুন।"));
                }
            }, 15000);

        } catch (err) {
            reject(err);
        }
    });
}

// API Endpoint
app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number required' });

    phone = phone.replace(/[^0-9]/g, '');

    try {
        const result = await getPairingCode(phone);
        return res.json(result);
    } catch (err) {
        console.error("[Pairing Error]:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ২. ব্যাকগ্রাউন্ড মেসেজ রুট
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
