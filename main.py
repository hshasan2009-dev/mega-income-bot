import os
import threading
from flask import Flask, jsonify, request
from flask_cors import CORS
import telebot
from telebot import types

TOKEN = "8644824917:AAFShJhs-Agv2XdAfW117tvMa1aaKaKOdEg"
bot = telebot.TeleBot(TOKEN)
app = Flask(__name__)
CORS(app)

# ইউজার ডেটা সংরক্ষণের জন্য ডিকশনারি
user_sync_data = {}

@app.route('/get-status/<user_id>', methods=['GET'])
def get_status(user_id):
    statuses = user_sync_data.get(str(user_id), {})
    return jsonify(statuses)

@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    data_parts = call.data.split('_')
    if len(data_parts) < 3:
        return
    
    action = data_parts[0]
    wd_id = data_parts[1]
    target_user_id = data_parts[2]

    if str(target_user_id) not in user_sync_data:
        user_sync_data[str(target_user_id)] = {}

    if action == 'acc':
        bot.answer_callback_query(call.id, "✅ উইথড্র সফলভাবে অ্যাপ্রুভ করা হয়েছে!")
        new_text = call.message.text + "\n\n✨ **স্ট্যাটাস:** Approved ✅"
        try:
            bot.edit_message_text(new_text, call.message.chat.id, call.message.message_id, parse_mode="Markdown")
        except Exception:
            pass
        user_sync_data[str(target_user_id)][wd_id] = "Approved"

    elif action == 'rej':
        bot.answer_callback_query(call.id, "❌ উইথড্র রিজেক্ট করা হয়েছে!")
        new_text = call.message.text + "\n\n✨ **স্ট্যাটাস:** Rejected ❌"
        try:
            bot.edit_message_text(new_text, call.message.chat.id, call.message.message_id, parse_mode="Markdown")
        except Exception:
            pass
        user_sync_data[str(target_user_id)][wd_id] = "Rejected"

@app.route('/send-withdrawal', methods=['POST'])
def send_withdrawal():
    req_data = request.json
    if not req_data:
        return jsonify({"status": "error", "message": "No data provided"}), 400

    user_id = str(req_data.get('user_id'))
    user_name = req_data.get('user_name')
    wd_id = req_data.get('wd_id')
    date = req_data.get('date')
    method = req_data.get('method')
    account = req_data.get('account')
    net_amount = req_data.get('net_amount')
    
    admin_chat_id = "8049465500"

    msg_text = (
        f"🔔 *নতুন উইথড্র রিকোয়েস্ট!*\n\n"
        f"👤 ইউজার: {user_name} (`{user_id}`)\n"
        f"📅 তারিখ: {date}\n"
        f"💳 মেথড: {method}\n"
        f"📱 নম্বর: `{account}`\n"
        f"💰 পরিমাণ: ৳{net_amount}"
    )

    markup = types.InlineKeyboardMarkup()
    btn_acc = types.InlineKeyboardButton("✅ Accept", callback_data=f"acc_{wd_id}_{user_id}")
    btn_rej = types.InlineKeyboardButton("❌ Reject", callback_data=f"rej_{wd_id}_{user_id}")
    markup.add(btn_acc, btn_rej)

    try:
        bot.send_message(admin_chat_id, msg_text, parse_mode="Markdown", reply_markup=markup)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

# টেলিগ্রাম বট ব্যাকগ্রাউন্ড থ্রেডে চালানোর জন্য ফাংশন
def run_bot():
    print("Telegram bot is running...")
    bot.infinity_polling(skip_pending=True)

if __name__ == '__main__':
    # বটকে আলাদা থ্রেডে চালু করা হলো যাতে ফ্লাস্কের সাথে কোনো কনফ্লিক্ট না হয়
    bot_thread = threading.Thread(target=run_bot)
    bot_thread.daemon = True
    bot_thread.start()

    # ফ্লাস্ক সার্ভার চালু করা
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
