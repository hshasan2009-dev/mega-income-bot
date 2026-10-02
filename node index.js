const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// সেশন ও হোয়াটসঅ্যাপ কানেকশন হ্যান্ডলার
async function connectToWhatsApp(phone) {
    const { state, saveCreds } = await useMultiFileAuthState(`sessions/${phone}`);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// ১. পেয়ারিং কোড তৈরির রুট
app.post('/api/get-code', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    try {
        const sock = await connectToWhatsApp(phone);
        setTimeout(async () => {
            const code = await sock.requestPairingCode(phone);
            res.json({ success: true, code: code });
        }, 3000);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ২. ব্যাকগ্রাউন্ড মেসেজ পাঠানো ও ২ টাকা ব্যালেন্স যোগের রুট
app.post('/api/send-message', async (req, res) => {
    const { senderPhone, targetPhone, message, userId } = req.body;

    try {
        const sock = await connectToWhatsApp(senderPhone);
        const jid = `${targetPhone}@s.whatsapp.net`;
        
        const sent = await sock.sendMessage(jid, { text: message });

        if (sent) {
            // মেসেজ সফল হলে ২ টাকা রিওয়ার্ড
            return res.json({ success: true, reward: 2, status: 'Sent' });
        } else {
            return res.json({ success: false, reward: 0, status: 'Failed' });
        }
    } catch (err) {
        res.json({ success: false, reward: 0, status: 'Failed', error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
