const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const app = express();

app.use(express.json());

// ১. এক্সপ্রেস সার্ভার পোর্ট (Render বা লোকাল হোস্টিংয়ের জন্য)
const PORT = process.env.PORT || 3000;

async function startBot() {
    // ২. সেশন ডেটা সেভ করার জন্য ফোল্ডার তৈরি
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // ফালতু লগ বন্ধ রাখবে
        printQRInTerminal: false // আমরা QR কোড চাই না, পেয়ারিং কোড চাই
    });

    // ৩. হোয়াটসঅ্যাপ কানেকশন স্ট্যাটাস মনিটর করা
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('কানেকশন বন্ধ হয়ে গেছে। আবার চেষ্টা করা হচ্ছে...', shouldReconnect);
            if (shouldReconnect) {
                startBot(); // আবার বট চালু করবে
            }
        } else if (connection === 'open') {
            console.log('হোয়াটসঅ্যাপ সফলভাবে বাইন্ড/কানেক্ট হয়েছে! এখন মেসেজ পাঠানো যাবে।');
        }
    });

    // ৪. ক্রেডেনশিয়াল সেভ করা
    sock.ev.on('creds.update', saveCreds);

    // ৫. এপিআই রুট: আপনার ওয়েবসাইটের ফ্রন্টএন্ড থেকে এই লিংকে নম্বর পাঠানো হবে
    app.post('/get-code', async (req, res) => {
        let phoneNumber = req.body.phone; // ইউজার যে নম্বর ইনপুট দেবে

        if (!phoneNumber) {
            return res.status(400).json({ error: "দয়া করে হোয়াটসঅ্যাপ নম্বরটি দিন।" });
        }

        // নম্বর থেকে +, স্পেস বা ড্যাশ কেটে ফেলা (শুধু সংখ্যা রাখা)
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

        // নম্বরটি যদি ০ দিয়ে শুরু হয় (যেমন: 01337176976), তবে শুরুতে ৮৮ যোগ করা
        if (phoneNumber.startsWith('0')) {
            phoneNumber = '88' + phoneNumber;
        }

        try {
            console.log(`নম্বর ${phoneNumber}-এর জন্য কোড রিকোয়েস্ট করা হচ্ছে...`);
            
            // হোয়াটসঅ্যাপ সার্ভার থেকে ৮ ডিজিটের কোড আনা
            // এই ফাংশনটি কল হওয়ামাত্রই ইউজারের ফোনে অফিশিয়াল নোটিফিকেশন চলে যাবে
            const code = await sock.requestPairingCode(phoneNumber);
            
            console.log(`জেনারেট হওয়া কোড: ${code}`);
            
            // আপনার ওয়েবসাইটের UI-তে কোডটি রেসপন্স হিসেবে পাঠানো
            return res.status(200).json({ 
                success: true, 
                code: code,
                message: "আপনার ফোনে লিংক ডিভাইসের নোটিফিকেশন পাঠানো হয়েছে।" 
            });

        } catch (error) {
            console.error("কোড জেনারেট করতে সমস্যা হয়েছে:", error);
            return res.status(500).json({ error: "কোড জেনারেট করা যায়নি। আবার চেষ্টা করুন।" });
        }
    });
}

// বট ও এক্সপ্রেস সার্ভার চালু করা
startBot();
app.listen(PORT, () => {
    console.log(`সার্ভার চলছে পোর্ট: ${PORT}-এ`);
});
