const fetch = require('node-fetch');

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";
const TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg";

console.log("📢 Broadcast Bot Server is running and monitoring...");

// সার্ভার চালু হওয়ার আগের পুরোনো মেসেজগুলো ট্র্যাক করার জন্য সেট
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

// প্রতি ১০ সেকেন্ড পর পর নতুন ব্রডকাস্ট চেক করা
setInterval(async () => {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/broadcast_messages.json`);
        const broadcasts = await res.json();
        
        if (!broadcasts) return;

        for (let key in broadcasts) {
            let data = broadcasts[key];
            
            // যদি মেসেজটি নতুন হয় এবং পূর্বে পাঠানো না হয়ে থাকে
            if (data && data.message && !processedMessages.has(key) && !data.sentToTelegram) {
                processedMessages.add(key); // ডাবল সেন্ড রোধ করতে সাথে সাথে সেটে যুক্ত করা
                let messageText = data.message;
                console.log(`🚀 New broadcast found: "${messageText}". Sending to all users...`);

                // ফায়ারবেস থেকে সকল ইউজারের ডেটা আনা
                const userRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
                const users = await userRes.json();

                if (users) {
                    let success = 0;
                    let failed = 0;

                    for (let userKey in users) {
                        let user = users[userKey];
                        
                        // প্রতিটি ইউজারের telegramId বা chatId বের করার লজিক
                        let chatId = user.telegramId || user.chatId;

                        // যদি টেলিগ্রাম আইডি সেভ না থাকে, তবে ইউজারের ইউজারনেম বা ফোন নম্বর টেলিগ্রাম আইডি হিসেবে কাজ করতে পারে কি না যাচাই
                        if (!chatId && user.username && !isNaN(user.username)) {
                            chatId = user.username;
                        }

                        if (chatId) {
                            try {
                                const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: chatId,
                                        text: messageText,
                                        parse_mode: "Markdown"
                                    })
                                });
                                
                                const tgData = await tgRes.json();
                                if (tgData.ok) {
                                    success++;
                                } else {
                                    failed++;
                                    console.log(`Failed for chat_id ${chatId}:`, tgData.description);
                                }
                            } catch (err) {
                                failed++;
                            }
                        }
                    }
                    console.log(`✅ Broadcast Finished. Success: ${success}, Failed: ${failed}`);
                }

                // মেসেজটি সফলভাবে প্রসেস হওয়ার পর ফায়ারবেসে sentToTelegram: true মার্ক করে দেওয়া, যাতে আর বারবার না যায়
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
