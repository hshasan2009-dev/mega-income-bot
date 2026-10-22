const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// আপনার Firebase সার্ভিস অ্যাকাউন্ট ফাইলের পাথ দিন (বা আপনার প্রজেক্টের ফায়ারবেস কনফিগারেশন অনুযায়ী ইনিশিয়ালাইজ করুন)
// যদি মূল ফাইলে ফায়ারবেস অলরেডি ইনিশিয়ালাইজ করা থাকে, তবে প্রজেক্ট অনুযায়ী এটি কনফিগার করে নেবেন।
const serviceAccount = require('./firebase-service-account.json'); // আপনার ফায়ারবেস কনফিগ ফাইল অনুযায়ী পরিবর্তন করতে পারেন

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com" // আপনার রিয়েলটাইম ডাটাবেস URL
    });
}

// প্রদত্ত টেলিগ্রাম বট টোকেন দিয়ে বট ইনিশিয়ালাইজ করা হলো
const TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg";
const bot = new TelegramBot(TOKEN, { polling: true });

const db = admin.database();

console.log("📢 Broadcast Bot Server is running and listening for new messages...");

// Firebase Realtime Database-এ ব্রডکাস্ট মেসেজ নতুন যোগ হলেই তা সব ইউজারের কাছে পাঠাবে
db.ref('broadcast_messages').on('child_added', async (snapshot) => {
    const data = snapshot.val();
    if (!data || !data.message) return;

    const messageText = data.message;
    console.log(`🚀 New broadcast message found: "${messageText}". Sending to users...`);

    try {
        const usersSnap = await db.ref('users').once('value');
        const users = usersSnap.val();

        if (users) {
            let successCount = 0;
            let failCount = 0;

            for (const userKey of Object.keys(users)) {
                const user = users[userKey];
                // ইউজারের টেলিগ্রাম ID বা চ্যাট আইডি নিশ্চিত করা
                const chatId = user.telegramId || userKey; 

                if (chatId) {
                    try {
                        await bot.sendMessage(chatId, messageText);
                        successCount++;
                    } catch (err) {
                        failCount++;
                        console.log(`Failed to send message to ${chatId}:`, err.message);
                    }
                }
            }
            console.log(`✅ Broadcast completed! Success: ${successCount}, Failed: ${failCount}`);
        } else {
            console.log("⚠️ No users found in database to broadcast.");
        }
    } catch (error) {
        console.error("❌ Error fetching users for broadcast:", error);
    }
});
