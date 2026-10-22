const fetch = require('node-fetch');

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";
const TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg";

console.log("📢 Single-Instance Broadcast Service is running...");

// ডাবল সেন্ড রোধ করার জন্য লোকাল মেমোরি লক
let isBroadcasting = false;

setInterval(async () => {
    if (isBroadcasting) return; // যদি অলরেডি ব্রডকাস্ট চলতে থাকে, তবে স্কিপ করবে

    try {
        const res = await fetch(`${FIREBASE_DB_URL}/broadcast_messages.json`);
        const broadcasts = await res.json();
        
        if (!broadcasts) return;

        for (let key in broadcasts) {
            let data = broadcasts[key];
            
            // যদি মেসেজটি ইতিমধ্যে পাঠানো হয়ে থাকে (sentToTelegram: true), তবে এটি সম্পূর্ণ এড়িয়ে যাবে
            if (data && data.message && !data.sentToTelegram) {
                isBroadcasting = true;
                let messageText = data.message;
                console.log(`🚀 Processing broadcast ID [${key}]: "${messageText}"`);

                // ১. সবার আগে ফায়ারবেসে মেসেজটিকে 'sentToTelegram: true' করে দেওয়া, যাতে অন্য কোনো লুপ এটি আর ধরতে না পারে
                await fetch(`${FIREBASE_DB_URL}/broadcast_messages/${key}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sentToTelegram: true })
                });

                // ২. ফায়ারবেস থেকে সকল ইউজারের ডাটা আনা
                const userRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
                const users = await userRes.json();

                if (users) {
                    let success = 0;
                    let failed = 0;
                    
                    // ডুপ্লিকেট চ্যাট আইডি পাঠানো রোধ করার জন্য সেট
                    let sentChatIds = new Set();

                    for (let userKey in users) {
                        let user = users[userKey];
                        
                        // ইউজারের টেলিগ্রাম আইডি খুঁজে বের করার সকল সম্ভাব্য পথ
                        let chatId = user.telegramId || user.chatId || userKey;

                        if (chatId && !sentChatIds.has(String(chatId))) {
                            sentChatIds.add(String(chatId));

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
                            
                            // ফ্লাড রেট এড়াতে প্রতিটি মেসেজের মাঝে সামান্য বিরতি
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    }
                    console.log(`✅ Broadcast Completed. Success: ${success}, Failed: ${failed}`);
                }

                isBroadcasting = false;
                break; // একবারে একটি নতুন মেসেজ প্রসেস করবে
            }
        }
    } catch (err) {
        isBroadcasting = false;
        console.error('Broadcast loop error:', err.message);
    }
}, 10000);
