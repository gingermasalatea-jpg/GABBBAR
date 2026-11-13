/**
 * Lightweight lexical retrieval over the knowledge base (no vector DB needed for one
 * company's FAQs). BM25-style scoring with title boosting, Hinglish → English synonym
 * folding, and Devanagari support. Pure functions — unit tested.
 */

const STOP = new Set(
  `a an the is are was were be been am i me my we our you your he she it they them this that these those to of in on at for from with and or but if then so do does did can could would should will shall may might must have has had not no yes please pls plz hi hello hey thanks thank ok okay sir madam ji
   mera meri mere tera teri apna aapka aapki batao bataiye chahiye bhai bhaiya please hai hain ho hoga hogi kya ki ka ke ko se me mein mai main mujhe hum aap tum yeh ye woh wo bhi to na nahi haan ha kar karo karna kuch koi tha thi the hona raha rahi rahe sakta sakte sakti
   है हैं क्या की का के को से में मैं मुझे मेरा मेरी हम आप यह वह भी तो ना नहीं हाँ कर करो कुछ कोई था थी थे लेते लेती देते चाहिए`.split(/\s+/),
);

// Hinglish / Hindi words folded to an English concept so they match English knowledge.
const SYNONYMS = {
  kab: 'when', kitna: 'price', kitne: 'price', kitni: 'price', daam: 'price', dam: 'price', rate: 'price', cost: 'price', paisa: 'payment', paise: 'payment', price: 'price', charges: 'price', charge: 'price',
  bhejo: 'send', bhej: 'send', bhejna: 'send', aayega: 'delivery', ayega: 'delivery', aaega: 'delivery', pahunchega: 'delivery', delivered: 'delivery', deliver: 'delivery', shipping: 'delivery', shipped: 'delivery', dispatch: 'delivery', courier: 'delivery',
  wapas: 'return', wapasi: 'return', vapas: 'return', returns: 'return', refund: 'return', exchange: 'return', replace: 'return', replacement: 'return',
  order: 'order', orders: 'order', ordered: 'order', track: 'track', tracking: 'track', status: 'track',
  timing: 'hours', time: 'hours', khula: 'hours', open: 'hours', band: 'closed', closed: 'closed', hours: 'hours',
  upi: 'payment', gpay: 'payment', paytm: 'payment', phonepe: 'payment', cod: 'payment', card: 'payment', payment: 'payment', pay: 'payment',
  bulk: 'bulk', wholesale: 'bulk', thok: 'bulk', quantity: 'bulk', moq: 'bulk', corporate: 'bulk',
  logo: 'logo', print: 'logo', printing: 'logo', branding: 'logo', embroidery: 'logo',
  address: 'location', kahan: 'location', kaha: 'location', location: 'location', shop: 'location', factory: 'location', visit: 'location', office: 'location',
  bag: 'bag', bags: 'bag', backpack: 'bag', backpacks: 'bag', thaila: 'bag', jhola: 'bag',
  'कब': 'when', 'कितना': 'price', 'कीमत': 'price', 'दाम': 'price', 'भेजो': 'send', 'डिलीवरी': 'delivery', 'आएगा': 'delivery', 'पहुंचेगा': 'delivery', 'भेजेंगे': 'send', 'वापस': 'return', 'ऑर्डर': 'order', 'पता': 'location', 'बैग': 'bag', 'पेमेंट': 'payment',
};

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && t.length > 1)
    .map((t) => SYNONYMS[t] || (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/**
 * Rank knowledge items for a query.
 * @param {string} queryText
 * @param {Array<{id:string,title:string,content:string,type:string}>} items
 * @returns {Array<{item:object, score:number, coverage:number}>} sorted; score normalised to 0..1; coverage = share of query terms matched
 */
export function rankKnowledge(queryText, items, { limit = 4 } = {}) {
  const q = [...new Set(tokenize(queryText))];
  if (!q.length || !items.length) return [];
  const docs = items.map((it) => {
    const title = tokenize(it.title);
    const body = tokenize(it.content);
    return { it, terms: [...title, ...title, ...body], titleSet: new Set(title) };
  });
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.terms.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;

  const scored = docs.map((d) => {
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    let matched = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.terms.length) / avgLen));
      if (d.titleSet.has(t)) score += 0.3;
    }
    // Coverage of the question's terms matters more than raw BM25 for short WhatsApp questions.
    const coverage = matched / q.length;
    return { item: d.it, raw: score, coverage };
  });

  const maxRaw = Math.max(...scored.map((s) => s.raw), 1e-9);
  return scored
    .filter((s) => s.raw > 0)
    .map((s) => ({ item: s.item, coverage: Number(s.coverage.toFixed(3)), score: Number((0.5 * (s.raw / maxRaw) * Math.min(1, s.coverage * 2) + 0.5 * s.coverage).toFixed(3)) }))
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}
