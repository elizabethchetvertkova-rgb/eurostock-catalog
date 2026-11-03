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

// Категории вещей: что ищем в тексте → как называем в дайджесте (во множественном числе). Порядок = приоритет.
const CATEGORIES = [
  [/адвент/i, 'адвент-календари'], [/пуховик/i, 'пуховики'], [/парк[аи]\b|парку\b/i, 'парки'], [/пальто/i, 'пальто'], [/тренч/i, 'тренчи'], [/плащ/i, 'плащи'],
  [/дублён|дублен/i, 'дублёнки'], [/шуб/i, 'шубы'], [/куртк/i, 'куртки'], [/бомбер/i, 'бомберы'], [/жилет/i, 'жилеты'], [/пиджак|жакет|блейзер/i, 'жакеты'],
  [/кардиган/i, 'кардиганы'], [/свитер|свитр/i, 'свитера'], [/джемпер|пуловер/i, 'джемперы'], [/водолазк/i, 'водолазки'], [/худи/i, 'худи'], [/свитшот/i, 'свитшоты'], [/толстовк/i, 'толстовки'],
  [/лонгслив/i, 'лонгсливы'], [/футболк/i, 'футболки'], [/поло\b/i, 'поло'], [/рубашк|сорочк/i, 'рубашки'], [/блуз/i, 'блузы'], [/топ[ыа]?\b/i, 'топы'],
  [/плать|сарафан/i, 'платья'], [/юбк/i, 'юбки'], [/джинс/i, 'джинсы'], [/брюк|штан/i, 'брюки'], [/шорт/i, 'шорты'], [/комбинезон/i, 'комбинезоны'], [/костюм/i, 'костюмы'],
  [/кроссовк|кроссы/i, 'кроссовки'], [/кед[ыао]/i, 'кеды'], [/угг|\bugg/i, 'угги'], [/moon ?boot|мунбут/i, 'зимние сапожки'], [/сапог|сапож/i, 'сапоги'], [/ботин|ботильон|челси/i, 'ботинки'],
  [/лофер/i, 'лоферы'], [/туфл/i, 'туфли'], [/балетк/i, 'балетки'], [/босоножк|сандал/i, 'босоножки'], [/шлёпанц|шлепанц|сланц|тапк|тапочк|слайд/i, 'тапки'], [/обув/i, 'обувь'],
  [/сумк|сумоч|шоппер|шопер|клатч/i, 'сумки'], [/рюкзак/i, 'рюкзаки'], [/кошел|картхолдер/i, 'кошельки'], [/ремн|ремень|пояс/i, 'ремни'],
  [/шапк|бини/i, 'шапки'], [/кепк|бейсболк/i, 'кепки'], [/панам/i, 'панамы'], [/шарф|снуд|палантин/i, 'шарфы'], [/перчатк|варежк/i, 'перчатки'], [/носк/i, 'носки'], [/колготк/i, 'колготки'],
  [/очк/i, 'очки'], [/час[ыов]\b|часы/i, 'часы'], [/серьг|серёж|кольц|браслет|цепочк|подвеск|украшен|бижутер/i, 'украшения'],
  [/парфюм|аромат|\bдухи|туалетн\w* вод/i, 'ароматы'], [/помад|тушь|тени|палетк|румян|хайлайтер|косметик|макияж/i, 'косметика'], [/крем|сыворотк|маск[аи]\b|уход/i, 'уход'],
  [/свеч/i, 'свечи'], [/набор/i, 'наборы'], [/пижам/i, 'пижамы'], [/бель[её]/i, 'бельё'], [/купальник/i, 'купальники'], [/халат/i, 'халаты'],
  [/игрушк|lego|лего/i, 'игрушки'], [/фен|стайлер|выпрямител/i, 'приборы для волос'], [/кашемир/i, 'кашемир'], [/коллекци/i, 'коллекция'],
];
const categoriesIn = text => { const out = []; for (const [re, label] of CATEGORIES) if (re.test(text) && !out.includes(label)) out.push(label); return out; };

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
  if (!brand) { // последний шанс: латинское слово с большой буквы в начале текста (Burker, Zimmermann)
    const head = text.split('\n').slice(0, 2).join(' ').replace(/https?:\/\/\S+/g, '');
    const w = [...head.matchAll(/(?:^|[^A-Za-z@#])([A-Z][A-Za-z&'.-]{2,}(?:\s[A-Z][A-Za-z&'.-]{2,})?)(?![A-Za-z])/g)].map(m => m[1]).find(x => !/^(New|The|Sale|Outlet|Limited|Size|Black|Friday|Moscow|Europe|Russia|Instagram|Telegram)$/i.test(x));
    if (w) { brand = w.toUpperCase(); brandTag = null; }
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
  // что именно: категории вещей по словарю (без хвоста «Заказать: …» и ссылок) — обрывки фраз в дайджест не попадают
  const body = text.replace(/https?:\/\/\S+/g, '').replace(/заказать:?[\s\S]*$/i, '');
  const descriptors = categoriesIn(body).slice(0, 3);
  return { brand, brandTag, kind, price: prices[0] || null, flags, descriptors, isOutlet: /аутлет|outlet/i.test(body), hasHashtagBrand: !!tags.find(t => !SERVICE_TAGS.has(t.toLowerCase())) };
}

// Собирает текст дайджеста из записей ленты. items: [{ id, url, text, date, photos: [file_id] }]
function composeDigest(items, opts = {}) {
  const groups = new Map();
  for (const it of items) {
    const p = parseFeedPost(it.text);
    if (!p.price && !p.hasHashtagBrand) continue; // видео без подписи, анонсы «завтра едем в аутлет», «только посмотрите» и т.п.
    if (!it.hashtagBrand && p.brandTag && !new RegExp('#' + p.brandTag + '(?![A-Za-z0-9_])', 'i').test(it.text || '')) p.brandTag = null; // бренд найден по тексту, хештега в канале нет
    const key = p.brand || 'И ЕЩЁ';
    if (!groups.has(key)) groups.set(key, { brand: key, tag: p.brandTag, items: [], kinds: new Set(), flags: new Set(), prices: [], descriptors: new Set() });
    const g = groups.get(key);
    g.items.push({ ...it, ...p });
    if (p.kind) g.kinds.add(p.kind);
    p.descriptors.forEach(x => g.descriptors.add(x));
    p.flags.forEach(f => g.flags.add(f));
    if (p.price) g.prices.push(p.price);
  }
  const list = [...groups.values()].sort((a, b) => (b.brand === 'И ЕЩЁ' ? -1 : 0) - (a.brand === 'И ЕЩЁ' ? -1 : 0) || b.items.length - a.items.length || Math.max(...b.prices, 0) - Math.max(...a.prices, 0));
  // Строка бренда в интонации «мы для вас выбрали»: без цен, количеств и хештегов.
  // «MASSIMO DUTTI — пуховики и джерси по аутлетным ценам», «LONGCHAMP — сумки, скоро будут в Москве»
  const joinRu = arr => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' и ' + arr[arr.length - 1];
  const lines = list.map(g => {
    const first = g.items[0];
    const n = g.items.length;
    const kinds = [...g.kinds];
    const dsc = [...g.descriptors].slice(0, 3);
    const isOutlet = kinds.some(k => /аутлет|outlet/.test(k)) || g.items.some(x => x.isOutlet);
    const isAdvent = kinds.some(k => /адвент/.test(k));
    const isFitting = kinds.some(k => /примеря/.test(k));
    let what;
    const onlyCollection = dsc.length === 1 && dsc[0] === 'коллекция';
    if (dsc.length && !onlyCollection) { what = joinRu(dsc.filter(x => x !== 'коллекция')) + (isOutlet && !g.flags.has('в пути') ? ' по аутлетным ценам' : ''); if (isAdvent && !/адвент/.test(what)) what += ' и адвент-календари'; }
    else if (onlyCollection) what = isOutlet ? 'новая коллекция из аутлета' : 'новая коллекция';
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
    let phrase = what;
    for (const t of tails.slice(0, 2)) phrase += (/^со скидкой/.test(t) ? ' ' : ', ') + t;
    return `${opts.bullet || '🤍'} ${name} — ${esc(phrase)}`;
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
