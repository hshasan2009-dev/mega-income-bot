// Mega Income — নোটিফিকেশন সার্ভার (Vercel)
// কোনো বাইরের প্যাকেজ লাগে না। index.js / broadcast.js ছোঁয় না।
//
// Vercel Environment Variables:
//   FIREBASE_SERVICE_ACCOUNT = Firebase থেকে নামানো private key JSON ফাইলের পুরো লেখা
//   NOTIFY_SECRET            = নিজের বানানো একটা লম্বা গোপন শব্দ (GitHub Secret-এও একই বসবে)

const crypto = require('crypto');

const DB_URL = (process.env.FIREBASE_DB_URL || 'https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com').replace(/\/$/, '');
const ADMIN_KEY = String(process.env.ADMIN_KEY || '01337176976').toLowerCase().trim();
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

// কোন ধরনের রিকোয়েস্ট কোন পথে সেভ হয়
const TYPES = {
  wd:  { path: 'withdrawals',      user: 'userId', amt: 'requestedAmount' },
  gm:  { path: 'gmail_submits',    user: 'userId', amt: 'amount' },
  fb:  { path: 'facebook_submits', user: 'userId', amt: 'amount' },
  pin: { path: 'pin_submits',      user: 'userId', amt: 'reward' },
  dep: { path: 'sp_deposits',      user: 'uid',    amt: 'amount' },
  act: { path: 'ac_requests',      user: 'uid',    amt: 'amount' }
};

function taka(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  return '৳' + (Math.round(n * 100) / 100);
}

// kind: req = ইউজার রিকোয়েস্ট দিয়েছে (এডমিনকে), ok / no = এডমিন অ্যাকসেপ্ট / রিজেক্ট করেছে (ইউজারকে)
function message(type, kind, r) {
  const who = r.userName || r.name || r.userId || r.uid || 'ইউজার';
  const amt = taka(r[TYPES[type].amt]);
  const M = {
    wd: {
      req: ['নতুন উইথড্র রিকোয়েস্ট', who + ' — ' + amt + (r.method ? ' (' + r.method + ')' : '')],
      ok:  ['উইথড্র সফল হয়েছে', 'আপনার ' + amt + ' উইথড্র রিকোয়েস্ট অ্যাকসেপ্ট হয়েছে।'],
      no:  ['উইথড্র রিজেক্ট হয়েছে', 'আপনার ' + amt + ' উইথড্র রিকোয়েস্ট রিজেক্ট হয়েছে, টাকা ব্যালেন্সে ফেরত দেওয়া হয়েছে।']
    },
    gm: {
      req: ['নতুন জিমেইল টাস্ক জমা', who + ' একটি জিমেইল সাবমিট করেছে।'],
      ok:  ['জিমেইল টাস্ক অ্যাকসেপ্ট', 'আপনার জিমেইল টাস্ক অ্যাকসেপ্ট হয়েছে' + (amt ? ', ' + amt + ' যোগ হয়েছে।' : '।')],
      no:  ['জিমেইল টাস্ক রিজেক্ট', 'আপনার জিমেইল টাস্ক রিজেক্ট করা হয়েছে।']
    },
    fb: {
      req: ['নতুন ফেসবুক সেল রিকোয়েস্ট', who + ' একটি ফেসবুক আইডি সাবমিট করেছে।'],
      ok:  ['ফেসবুক সেল অ্যাকসেপ্ট', 'আপনার ফেসবুক সেল রিকোয়েস্ট অ্যাকসেপ্ট হয়েছে' + (amt ? ', ' + amt + ' যোগ হয়েছে।' : '।')],
      no:  ['ফেসবুক সেল রিজেক্ট', 'আপনার ফেসবুক সেল রিকোয়েস্ট রিজেক্ট করা হয়েছে।']
    },
    pin: {
      req: ['নতুন পিন সাবমিট প্রুফ', who + ' — ' + (r.operatorTitle || 'পিন অফার')],
      ok:  ['পিন সাবমিট অ্যাকসেপ্ট', 'আপনার পিন সাবমিট টাস্ক অ্যাকসেপ্ট হয়েছে' + (amt ? ', ' + amt + ' যোগ হয়েছে।' : '।')],
      no:  ['পিন সাবমিট রিজেক্ট', 'আপনার পিন সাবমিট প্রুফ রিজেক্ট করা হয়েছে।']
    },
    dep: {
      req: ['নতুন ডিপোজিট রিকোয়েস্ট', who + ' — ' + amt + (r.method ? ' (' + r.method + ')' : '')],
      ok:  ['ডিপোজিট অ্যাকসেপ্ট', 'আপনার ' + amt + ' ডিপোজিট অ্যাকসেপ্ট হয়েছে, ওয়ালেটে যোগ হয়েছে।'],
      no:  ['ডিপোজিট রিজেক্ট', 'আপনার ' + amt + ' ডিপোজিট রিকোয়েস্ট রিজেক্ট করা হয়েছে।']
    },
    act: {
      req: ['নতুন একাউন্ট এক্টিভ রিকোয়েস্ট', who + (amt ? ' — ' + amt : '') + (r.method ? ' (' + r.method + ')' : '')],
      ok:  ['একাউন্ট এক্টিভ হয়েছে', 'আপনার একাউন্ট এক্টিভ হয়েছে, এখন কাজ শুরু করতে পারেন।'],
      no:  ['একাউন্ট এক্টিভ রিকোয়েস্ট রিজেক্ট', 'আপনার একাউন্ট এক্টিভ রিকোয়েস্ট রিজেক্ট করা হয়েছে।']
    }
  };
  return M[type][kind];
}

function normStatus(s) {
  s = String(s || '').toLowerCase();
  if (s === 'pending') return 'req';
  if (s === 'success' || s === 'approved') return 'ok';
  if (s === 'rejected') return 'no';
  return null;
}

/* ---------- Google অথেন্টিকেশন (সার্ভিস অ্যাকাউন্ট) ---------- */
let SA = null;
function sa() {
  if (SA) return SA;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT সেট করা নেই');
  const j = JSON.parse(raw);
  j.private_key = String(j.private_key || '').replace(/\\n/g, '\n');
  SA = j;
  return SA;
}

let cache = { tok: '', exp: 0 };
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cache.tok && cache.exp - 60 > now) return cache.tok;
  const k = sa();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: k.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(k.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('টোকেন পাওয়া যায়নি: ' + (j.error_description || j.error || r.status));
  cache = { tok: j.access_token, exp: now + (j.expires_in || 3600) };
  return cache.tok;
}

/* ---------- Realtime Database (REST) ---------- */
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');

async function dbGet(path) {
  const tok = await accessToken();
  const r = await fetch(DB_URL + '/' + enc(path) + '.json', { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('ডাটাবেস পড়া যায়নি (' + r.status + ')');
  return r.json();
}

// জায়গাটা খালি থাকলেই লেখে। আগে থেকে থাকলে false (মানে আগেই পাঠানো হয়েছে)
async function dbClaim(path) {
  const tok = await accessToken();
  const r = await fetch(DB_URL + '/' + enc(path) + '.json', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + tok, 'if-match': 'null_etag', 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: Date.now() })
  });
  if (r.status === 412) return false;
  if (!r.ok) throw new Error('ডাটাবেসে লেখা যায়নি (' + r.status + ')');
  return true;
}

async function dbDelete(path) {
  try {
    const tok = await accessToken();
    await fetch(DB_URL + '/' + enc(path) + '.json', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } });
  } catch (e) { /* বাদ */ }
}

/* ---------- FCM ---------- */
async function fcmSend(target, title, body) {
  const tok = await accessToken();
  const k = sa();
  const msg = { data: { title: String(title), body: String(body) }, android: { priority: 'HIGH' } };
  if (target.token) msg.token = target.token; else msg.topic = target.topic;
  const r = await fetch('https://fcm.googleapis.com/v1/projects/' + k.project_id + '/messages:send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg })
  });
  if (r.ok) return { ok: true };
  let j = {};
  try { j = await r.json(); } catch (e) { /* বাদ */ }
  const text = JSON.stringify(j);
  return { ok: false, unregistered: r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text), status: r.status };
}

async function sendToUser(userKey, title, body) {
  const t = await dbGet('fcm_tokens/' + userKey + '/t');
  if (!t || typeof t !== 'string') return { ok: false, reason: 'no_token' };
  const res = await fcmSend({ token: t }, title, body);
  if (!res.ok && res.unregistered) await dbDelete('fcm_tokens/' + userKey);
  return res;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/* ---------- রিকোয়েস্ট হ্যান্ডলার ---------- */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'notify', configured: !!process.env.FIREBASE_SERVICE_ACCOUNT, secret: !!process.env.NOTIFY_SECRET });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const type = String(b.type || '');

    // অ্যাপের নতুন ভার্সন বানানো শেষে GitHub এটা ডাকে — সবাইকে যাবে
    if (type === 'update') {
      if (!safeEqual(b.secret, process.env.NOTIFY_SECRET)) return res.status(401).json({ ok: false, error: 'secret' });
      const v = String(b.version || '').slice(0, 20);
      const r = await fcmSend({ topic: 'all' }, 'নতুন আপডেট এসেছে', 'Mega Income অ্যাপের নতুন ভার্সন' + (v ? ' ' + v : '') + ' এসেছে। অ্যাপ খুলে আপডেট করে নিন।');
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
    }

    // পরীক্ষার জন্য: একজন ইউজারকে টেস্ট নোটিফিকেশন
    if (type === 'test') {
      if (!safeEqual(b.secret, process.env.NOTIFY_SECRET)) return res.status(401).json({ ok: false, error: 'secret' });
      const u = String(b.user || ADMIN_KEY).toLowerCase().trim();
      const r = await sendToUser(u, 'টেস্ট নোটিফিকেশন', 'নোটিফিকেশন ঠিকমতো কাজ করছে ✅');
      return res.status(200).json({ ok: !!r.ok, reason: r.reason || null });
    }

    // সাধারণ ইভেন্ট: সার্ভার নিজে ডাটাবেস দেখে নিশ্চিত হয়, তারপর পাঠায়
    const t = TYPES[type];
    const id = String(b.id || '');
    if (!t || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: 'bad_request' });

    const rec = await dbGet(t.path + '/' + id);
    if (!rec || typeof rec !== 'object') return res.status(404).json({ ok: false, error: 'not_found' });

    const kind = normStatus(rec.status);
    if (!kind) return res.status(200).json({ ok: true, skipped: 'status' });

    // একই ঘটনার জন্য দুইবার নয়
    const first = await dbClaim('notif_log/' + type + '_' + id + '_' + kind);
    if (!first) return res.status(200).json({ ok: true, skipped: 'duplicate' });

    const target = kind === 'req' ? ADMIN_KEY : String(rec[t.user] || '').toLowerCase().trim();
    if (!target) return res.status(200).json({ ok: true, skipped: 'no_target' });

    const m = message(type, kind, rec);
    const r = await sendToUser(target, m[0], m[1]);
    if (!r.ok && r.reason !== 'no_token' && !r.unregistered) {
      await dbDelete('notif_log/' + type + '_' + id + '_' + kind); // আবার চেষ্টার সুযোগ রাখা
      return res.status(502).json({ ok: false, error: 'fcm' });
    }
    return res.status(200).json({ ok: true, sent: !!r.ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 200) });
  }
};
