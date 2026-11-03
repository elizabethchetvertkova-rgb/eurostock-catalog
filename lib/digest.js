'use strict';
// Ежедневный дайджест для канала байер-сервиса (@eurostockmoscow):
// бот собирает всё, что выложили за сутки, группирует по брендам и публикует подборку.

const SERVICE_TAGS = new Set(['впути', 'outlet', 'аутлет', 'срочно', 'sale', 'распродажа', 'скидка', 'скидки', 'новинка', 'новинки', 'new',
  'вналичии', 'подзаказ', 'заказ', 'акция', 'хит', 'топ', 'мужское', 'женское', 'детское', 'обувь', 'сумки', 'одежда', 'аксессуары',
  'eurostockmoscow', 'eurostockmoscowshop', 'мужскаяодежда', 'адвент', 'адвенткалендарь', 'adventcalendar', 'лимитка', 'последний']);
const KNOWN_BRANDS = ['Dyson', 'Rituals', 'Charlotte Tilbury', 'Cult Beauty', 'Selfridges', 'Harrods', 'Lookfantastic', 'ASOS', 'Sephora', 'Zara', 'Massimo Dutti',
  'Max Mara', 'Maxmara', 'Hugo Boss', 'Boss', 'Sandro', 'Maje', 'Timberland', 'Ralph Lauren', 'Tommy Hilfiger', 'Uniqlo', 'Mango', 'COS', 'Arket', 'H&M',
  'Calvin Klein', 'Guess', 'Michael Kors', 'Coach', 'Furla', 'Pandora', 'Swarovski', 'Nike', 'Adidas', 'New Balance', 'Puma', 'Lacoste', 'Levi\'s', 'Stradivarius',
  'Bershka', 'Pull&Bear', 'Oysho', 'Reserved', 'Marks & Spencer', 'Next', 'Primark', 'Lush', 'The Body Shop', 'Kiehl\'s', 'La Roche-Posay', 'Vichy', 'Bioderma',
  'Clarins', 'Lancome', 'Lancôme', 'Dior', 'Chanel', 'YSL', 'Guerlain', 'Estee Lauder', 'Estée Lauder', 'MAC', 'NARS', 'Benefit', 'Urban Decay', 'Fenty', 'Jo Malone',
  'Diptyque', 'Byredo', 'Le Labo', 'Molton Brown', 'Weekend Max Mara', 'Marella', 'Pinko', 'Liu Jo', 'Twinset', 'Patrizia Pepe', 'Elisabetta Franchi', 'Armani',
  'Emporio Armani', 'Versace', 'Moschino', 'Love Moschino', 'Karl Lagerfeld', 'DKNY', 'Tory Burch', 'Kate Spade', 'Longchamp', 'Polo Ralph Lauren', 'Gant',
  'Barbour', 'Ted Baker', 'Reiss', 'Whistles', 'Hobbs', 'Jigsaw', 'Clarks', 'Dr. Martens', 'UGG', 'Birkenstock', 'Crocs', 'Geox', 'Ecco', 'Skechers',
  'The North Face', 'Columbia', 'Patagonia', 'Moncler', 'Canada Goose', 'Woolrich', 'Parajumpers', 'Napapijri', 'Superdry', 'Jack Wolfskin'];

const num = s => Number(String(s).replace(/[^\d]/g, ''));
const fmt = n => n.toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';
// битые половинки эмодзи (одиночные суррогаты) Telegram не принимает: «Text must be encoded in UTF-8»
const fixUtf = s => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '').replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
const esc = s => fixUtf(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; };

// #CharlotteTilbury → CHARLOTTE TILBURY, #Maxmara → MAXMARA
function brandDisplay(tag) {
  const known = KNOWN_BRANDS.find(b => b.replace(/[^a-zа-яё0-9]/gi, '').toLowerCase() === tag.replace(/[^a-zа-яё0-9]/gi, '').toLowerCase());
  if (known) return known.toUpperCase();
  return tag.replace(/_/g, ' ').replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2').toUpperCase();
}

// Разбор одного поста канала → { brand, brandTag, kind, price, flags }
function parseFeedPost(text) {
  text = text || '';
  const tags = [...text.matchAll(/#([A-Za-zА-Яа-яёЁ0-9_]+)/g)].map(m => m[1]);
  let brandTag = tags.find(t => !SERVICE_TAGS.has(t.toLowerCase()) && /[A-Za-z]/.test(t)) || tags.find(t => !SERVICE_TAGS.has(t.toLowerCase()) && !/^[а-яё]/.test(t));
  let brand = brandTag ? brandDisplay(brandTag) : null;
  if (!brand) { // бренд без хештега — ищем известное имя в тексте
    const found = KNOWN_BRANDS.filter(b => new RegExp('(^|[^A-Za-z])' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i').test(text)).sort((a, b) => b.length - a.length)[0];
    if (found) { brand = found.toUpperCase(); brandTag = found.replace(/[^A-Za-z0-9]/g, ''); }
  }
  const firstLine = text.split('\n')[0] || '';
  let kind = firstLine.replace(/#\S+/g, '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D!:]/gu, '').trim().toLowerCase();
  if (kind.length > 28) kind = /адвент/i.test(text) ? 'адвент-календарь' : '';
  if (/адвент/i.test(text) && !/адвент/.test(kind)) kind = kind ? kind + ', адвент-календарь' : 'адвент-календарь';
  const prices = [...text.matchAll(/(\d[\d\s  ]{2,})\s*₽/g)].map(m => num(m[1])).filter(n => n >= 100);
  const flags = [];
  if (/срочно/i.test(text)) flags.push('срочно!');
  if (/#впути|в пути/i.test(text)) flags.push('в пути');
  const disc = text.match(/[-−–]\s?(\d{1,2})\s?%/); if (disc) flags.push(`−${disc[1]}%`);
  else if (/скидк|sale|распродаж/i.test(text)) flags.push('скидка');
  if (/все размеры/i.test(text)) flags.push('все размеры');
  if (/последн(ий|яя|ее|ие)/i.test(text)) flags.push('последний');
  // что именно: слова после цены в строке с ценой («▪️11700₽ кашемир», «▪️4200₽ мужские шапки»)
  const descriptors = [];
  for (const line of text.split('\n')) {
    const m = line.match(/₽\s*(.+)$/); if (!m) continue;
    let dsc = m[1].replace(/#\S+/g, '').replace(/[-−–]\s?\d{1,2}\s?%/g, '').replace(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|\d{2,3}(?:[\/-]\d{2,3})?)\b/g, '')
      .replace(/срочно|все размеры|в пути|с доставкой( в россию)?|доставка[^,.;]*|заказать:?/gi, '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D!]/gu, '').replace(/\s{2,}/g, ' ').replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '').trim().toLowerCase();
    if (dsc && dsc.length <= 32) descriptors.push(dsc);
  }
  return { brand, brandTag, kind, price: prices[0] || null, flags, descriptors };
}

// Собирает текст дайджеста из записей ленты. items: [{ id, url, text, date, photos: [file_id] }]
function composeDigest(items, opts = {}) {
  const groups = new Map();
  for (const it of items) {
    const p = parseFeedPost(it.text);
    if (!p.brand && !p.price) continue; // видео без подписи, «только посмотрите» и т.п.
    if (!it.hashtagBrand && p.brandTag && !new RegExp('#' + p.brandTag + '(?![A-Za-z0-9_])', 'i').test(it.text || '')) p.brandTag = null; // бренд найден по тексту, хештега в канале нет
    const key = p.brand || 'ЕЩЁ';
    if (!groups.has(key)) groups.set(key, { brand: key, tag: p.brandTag, items: [], kinds: new Set(), flags: new Set(), prices: [], descriptors: new Set() });
    const g = groups.get(key);
    g.items.push({ ...it, ...p });
    if (p.kind) g.kinds.add(p.kind);
    p.descriptors.forEach(x => g.descriptors.add(x));
    p.flags.forEach(f => g.flags.add(f));
    if (p.price) g.prices.push(p.price);
  }
  const list = [...groups.values()].sort((a, b) => (b.brand === 'ЕЩЁ' ? -1 : 0) - (a.brand === 'ЕЩЁ' ? -1 : 0) || b.items.length - a.items.length || Math.max(...b.prices, 0) - Math.max(...a.prices, 0));
  // Строка бренда в интонации «мы для вас выбрали»: без цен, количеств и хештегов.
  // «MASSIMO DUTTI — пуховики и джерси по аутлетным ценам», «LONGCHAMP — сумки, скоро будут в Москве»
  const joinRu = arr => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' и ' + arr[arr.length - 1];
  const lines = list.map(g => {
    const first = g.items[0];
    const n = g.items.length;
    const kinds = [...g.kinds];
    const dsc = [...g.descriptors].slice(0, 3);
    const isOutlet = kinds.some(k => /аутлет|outlet/.test(k));
    const isAdvent = kinds.some(k => /адвент/.test(k));
    const isFitting = kinds.some(k => /примеря/.test(k));
    let what;
    if (dsc.length) { what = joinRu(dsc) + (isOutlet && !g.flags.has('в пути') ? ' по аутлетным ценам' : ''); if (isAdvent && !/адвент/.test(what)) what += ' и адвент-календари'; }
    else if (isAdvent) what = n > 1 ? 'адвент-календари к праздникам' : 'адвент-календарь к праздникам';
    else if (isOutlet) what = 'новые позиции из аутлета';
    else if (kinds.length && !isFitting) what = kinds[0];
    else what = isFitting ? 'примеряем для клиента' : 'новые позиции';
    if (isFitting && !/примеря/.test(what)) what += ', примеряем для клиента';
    const tails = [];
    const fl = g.flags;
    if (fl.has('в пути')) tails.push('скоро будут в Москве');
    const disc = [...fl].find(f => /^−\d+%$/.test(f));
    if (disc) tails.push(`со скидкой ${disc}`); else if (fl.has('скидка') && !/скидк|распродаж|sale/i.test(what)) tails.push('со скидкой');
    if (fl.has('срочно!')) tails.push('успевайте');
    if (fl.has('последний')) tails.push('последние размеры');
    const name = `<a href="${first.url}"><b>${esc(g.brand)}</b></a>`;
    return `${opts.bullet || '🤍'} ${name} — ${esc([what, ...tails.slice(0, 2)].join(', '))}`;
  });
  const total = list.reduce((n, g) => n + g.items.length, 0);
  const parts = [];
  if (opts.greeting !== '') parts.push(opts.greeting || 'Доброе утро! ☕️ Собрали для вас самое интересное за сутки:');
  if (opts.header) parts.push(opts.header);
  parts.push(lines.join('\n'));
  if (opts.footer !== '') parts.push(opts.footer || 'Любую позицию можно заказать @tatianamoseuro и @tunesheva 💌\nПосмотреть товары в наличии в Москве — в @eurostockmoscowshop');
  const html = fixUtf(parts.join('\n\n'));
  // медиа для обложки: сначала по одному от каждого бренда, потом вторые фото — пока не наберём maxMedia (до 10)
  const maxMedia = Math.max(0, Math.min(10, opts.maxMedia != null ? opts.maxMedia : 4));
  const pool = list.map(g => g.items.flatMap(x => [
    ...(x.photos || []).map(f => ({ type: 'photo', media: f })),
    ...(opts.includeVideo ? (x.videos || []).map(f => ({ type: 'video', media: f })) : []),
  ]));
  const media = []; const seen = new Set();
  for (let round = 0; media.length < maxMedia && pool.some(p => p.length > round); round++) {
    for (const p of pool) { const m = p[round]; if (m && !seen.has(m.media) && media.length < maxMedia) { seen.add(m.media); media.push(m); } }
  }
  const photos = media.filter(m => m.type === 'photo').map(m => m.media);
  return { html, visibleLength: html.replace(/<[^>]+>/g, '').length, media, photos, brands: list.length, total, coverUrl: (list[0] && list[0].items[0].url) || null };
}

module.exports = { parseFeedPost, composeDigest, brandDisplay };
