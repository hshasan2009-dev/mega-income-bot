const fetch = require('node-fetch'); // বা সরাসরি গ্লোবাল ফেচ ব্যবহার করতে পারেন

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";
const TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg"; // আপনার টেলিগ্রাম বট টোকেন

console.log("📢 Broadcast Bot Server is running...");

// প্রতি ১০ সেকেন্ড পর পর ফায়ারবেসের ব্রডকাস্ট নোড চেক করবে
setInterval(async () => {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/broadcast_messages.json`);
        const broadcasts = await res.json();
        
        if (!broadcasts) return;

        // নতুন মেসেজগুলো প্রসেস করা
        for (let key in broadcasts) {
            let data = broadcasts[key];
            // যদি মেসেজ পাঠানো না হয়ে থাকে বা নতুন হয়
            if (data && data.message && !data.sentToTelegram) {
                let messageText = data.message;
                console.log(`🚀 Sending broadcast: "${messageText}"`);

                // সব ইউজার আনা
                const userRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
                const users = await userRes.json();

                if (users) {
                    for (let userKey in users) {
                        let user = users[userKey];
                        let chatId = user.telegramId || userKey;

                        if (chatId) {
                            try {
                                await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: chatId, text: messageText })
                                });
                            } catch (e) {
                                console.log(`Failed to send to ${chatId}`);
                            }
                        }
                    }
                }

                // মেসেজ পাঠানো শেষ হলে ফায়ারবেসে মার্ক করে দেওয়া যাতে বারবার না পাঠায়
                await fetch(`${FIREBASE_DB_URL}/broadcast_messages/${key}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sentToTelegram: true })
                });
            }
        }
    } catch (err) {
        console.error('Broadcast check error:', err.message);
    }
}, 10000);
