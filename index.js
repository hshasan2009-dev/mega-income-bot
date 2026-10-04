const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers,
    delay 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_session');

    // হোয়াটসঅ্যাপ কানেকশন কনফিগারেশন ফিক্স
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        
        // Render বা ক্লাউড হোস্টিংয়ের জন্য এই অংশটি অত্যন্ত গুরুত্বপূর্ণ
        // এটি হোয়াটসঅ্যাপ সার্ভারকে বোঝাবে যে অনুরোধটি কোনো বট থেকে নয়, Chrome ব্রাউজার থেকে আসছে
        browser: Browsers.ubuntu('Chrome'), 
        
        connectTimeoutMs: 60000, // কানেকশন টাইমআউট বাড়িয়ে ১ মিনিট করা হলো
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    // কানেকশন মনিটর
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('কানেকশন বন্ধ হয়েছে। পুনরায় চেষ্টা করা হচ্ছে...', shouldReconnect);
            if (shouldReconnect) {
                // ২ সেকেন্ড অপেক্ষা করে আবার চেষ্টা করবে যাতে সার্ভার ক্র্যাশ না করে
                setTimeout(() => startBot(), 2000); 
            }
        } else if (connection === 'open') {
            console.log('হোয়াটসঅ্যাপ সার্ভারের সাথে সফলভাবে সংযোগ তৈরি হয়েছে!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // কোড জেনারেট করার এপিআই রুট
    app.post('/get-code', async (req, res) => {
        let phoneNumber = req.body.phone; 

        if (!phoneNumber) {
            return res.status(400).json({ error: "দয়া করে হোয়াটসঅ্যাপ নম্বরটি দিন।" });
        }

        // নম্বর ফরম্যাট ঠিক করা
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

        if (phoneNumber.startsWith('0')) {
            phoneNumber = '88' + phoneNumber;
        }

        try {
            console.log(`নম্বর ${phoneNumber}-এর জন্য কোড রিকোয়েস্ট করা হচ্ছে...`);
            
            // হোয়াটসঅ্যাপ থেকে কোড নেওয়ার আগে সকেট রেডি আছে কিনা তা নিশ্চিত করা
            if (!sock || connection === 'close') {
                throw new Error("হোয়াটসঅ্যাপ সকেট বর্তমানে বন্ধ আছে।");
            }

            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`জেনারেট হওয়া কোড: ${code}`);
            
            return res.status(200).json({ 
                success: true, 
                code: code,
                message: "আপনার ফোনে নোটিফিকেশন পাঠানো হয়েছে।" 
            });

        } catch (error) {
            console.error("হোয়াটসঅ্যাপ সার্ভার এরর:", error.message);
            // আপনার ফ্রন্টএন্ডে পপ-আপ মেসেজটি সুন্দরভাবে দেখানোর জন্য রেসপন্স
            return res.status(500).json({ 
                success: false,
                error: "WhatsApp সার্ভারের সাথে সংযোগ করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।" 
            });
        }
    });
}

startBot();
app.listen(PORT, () => {
    console.log(`সার্ভার চলছে পোর্ট: ${PORT}-এ`);
});
