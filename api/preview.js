// Telegram / WhatsApp / Facebook এর বট এই ফাংশন থেকে প্রিভিউ পায়।
// সাধারণ ইউজাররা এটা দেখে না, তারা সরাসরি index.html পায়।
const BASE = 'https://mega-income-pro1.vercel.app';
const IMAGE = BASE + '/og-image.jpg';
const SITE = 'Mega Income Pro';
const TITLE = 'প্রতিদিন সহজ টাস্ক কমপ্লিট করে আয় করুন';
const DESC = 'দ্রুত আয় দ্রুত পেমেন্ট\nএবং বন্ধুদের রেফার করে ২৫% কমিশন + পুরস্কার পান🎉';

module.exports = (req, res) => {
  let ref = '';
  try {
    ref = new URL(req.url, BASE).searchParams.get('ref') || '';
  } catch (e) {}
  // শুধু নিরাপদ অক্ষর রাখা হলো
  ref = /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : '';
  const fullUrl = ref ? BASE + '/?ref=' + ref : BASE + '/';

  const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<title>${SITE}</title>
<meta name="description" content="${DESC}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:image" content="${IMAGE}">
<meta property="og:image:secure_url" content="${IMAGE}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${fullUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESC}">
<meta name="twitter:image" content="${IMAGE}">
</head>
<body><a href="${fullUrl}">${SITE}</a></body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  res.status(200).send(html);
};
