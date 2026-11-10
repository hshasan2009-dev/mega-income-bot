// শুধু Telegram-এর প্রিভিউ বট (TelegramBot) এই ফাইল দেখবে।
// সাধারণ ইউজার সরাসরি index.html-ই পাবে, তাই অ্যাপে কোনো পরিবর্তন হয় না।
module.exports = (req, res) => {
  const BASE = 'https://mega-income-pro1.vercel.app';
  const raw = String((req.query && req.query.ref) || '');
  const ref = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const url = ref ? BASE + '/?ref=' + ref : BASE + '/';

  const title = 'প্রতিদিন সহজ টাস্ক কমপ্লিট করে আয় করুন';
  const desc = 'দ্রুত আয় দ্রুত পেমেন্ট\nএবং বন্ধুদের রেফার করে ২৫% কমিশন + পুরস্কার পান🎉';
  const img = BASE + '/og-image.jpg';

  const html = `<!DOCTYPE html>
<html lang="bn"><head>
<meta charset="UTF-8">
<title>Mega Income Pro</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Mega Income Pro">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${img}">
<meta property="og:image:secure_url" content="${img}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
<link rel="canonical" href="${url}">
</head><body></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
};
