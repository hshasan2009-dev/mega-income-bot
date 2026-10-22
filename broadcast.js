const fetch = require('node-fetch');

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";
const TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg";

console.log("📢 Broadcast Bot Server is running and monitoring...");

// সার্ভার চালু হওয়ার ঠিক পরের মুহূর্তের আগের সব পুরোনো মেসেজ আইডি সেভ করে রাখা, 
// যাতে পুরোনো কোনো মেসেজ হুট করে রি-সেন্ড না হয়।
let processedMessages = new Set();

async function initOldMessages() {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/broadcast_messages.json`);
        const data = await res.json();
        if (data) {
            Object.keys(data).forEach(key => processedMessages.add(key));
        }
    } catch (e) {}
}
initOldMessages();

// প্রতি ১০ সেকেন্ড পর পর চেক করা
setInterval(async () => {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/broadcast_messages.json`);
        const broadcasts = await res.json();
        
        if (!broadcasts) return;

        for (let key in broadcasts) {
            let data = broadcasts[key];
            
            // যদি মেসেজটি নতুন হয় এবং পূর্বে পাঠানো না হয়ে থাকে
            if (data && data.message && !processedMessages.has(key) && !data.sentToTelegram) {
                processedMessages.add(key); // সাথে সাথে লিস্টে যোগ করা যাতে ডাবল না যায়
                let messageText = data.message;
                console.log(`🚀 New broadcast found: "${messageText}". Sending to all users...`);

                // ১. ইউজারদের ডাটা ফেচ করা (আপনার ফায়ারবেসের স্ট্রাকচার অনুযায়ী 'users' নোড)
                const userRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
                const users = await userRes.json();

                if (users) {
                    let success = 0;
                    let failed = 0;

                    for (let userKey in users) {
                        let user = users[userKey];
                        
                        // ইউজারের টেলিগ্রাম আইডি খুঁজে বের করার বিভিন্ন সম্ভাব্য পথ
                        let chatId = user.telegramId || user.chatId || userKey;

                        if (chatId) {
                            try {
                                const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: chatId,
                                        text: messageText
                                    })
                                });
                                
                                const tgData = await tgRes.json();
                                if (tgData.ok) {
                                    success++;
                                } else {
                                    failed++;
                                }
                            } catch (err) {
                                failed++;
                            }
                        }
                    }
                    console.log(`✅ Broadcast Finished. Success: ${success}, Failed: ${failed}`);
                }

                // ২. ফায়ারবেসে এই মেসেজটিকে পার্মানেন্টলি 'sentToTelegram: true' করে দেওয়া, যাতে সার্ভার রিস্টার্ট হলেও আর ডাবল না যায়
                await fetch(`${FIREBASE_DB_URL}/broadcast_messages/${key}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sentToTelegram: true })
                });
            }
        }
    } catch (err) {
        console.error('Broadcast loop error:', err.message);
    }
}, 10000);
