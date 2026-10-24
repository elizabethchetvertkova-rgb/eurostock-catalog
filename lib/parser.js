// Парсер постов канала @eurostockmoscowshop → карточки товаров.
// Один и тот же модуль используется для разового импорта истории и для бота (новые посты).

const BRAND_MAP = {
  massimodutti: 'Massimo Dutti', zara: 'Zara', cos: 'COS', adidas: 'Adidas',
  oysho: 'Oysho', arket: 'Arket', uniqlo: 'Uniqlo', longchamp: 'Longchamp', chanel: 'Chanel',
  poloralphlauren: 'Polo Ralph Lauren', converse: 'Converse', puma: 'Puma', ulanka: 'Ulanka',
  miumiu: 'Miu Miu', jacquemus: 'Jacquemus', burker: 'Burker', otherstories: '& Other Stories',
  saintlaurent: 'Saint Laurent', rituals: 'Rituals', charlottetilbury: 'Charlotte Tilbury',
  lego: 'LEGO', celine: 'Celine', hm: 'H&M', mango: 'Mango', bershka: 'Bershka', pullandbear: 'Pull&Bear',
  stradivarius: 'Stradivarius', nike: 'Nike', newbalance: 'New Balance', sandro: 'Sandro', dior: 'Dior', coach: 'Coach',
  valentino: 'Valentino', louisvuitton: 'Louis Vuitton', dkny: 'DKNY', ralphlauren: 'Ralph Lauren', justcavalli: 'Just Cavalli', maje: 'Maje',
};
const SERVICE_TAGS = new Set(['спортивнаяодежда', 'мужскаяодежда', 'мужское', 'женское', 'унисекс']);

// Посты, которые не являются карточкой товара
const SKIP_RE = /на других площадках|в другом магазине|парный .*образ|вы это видели/i;

const CATEGORIES = [
  ['Верхняя одежда', /пуховик|куртк|пальто|тренч|парк[аи](?![а-яё])|бомбер|ветровк|шуб|жилет|кимоно|плащ|дублен/i],
  ['Жакеты и костюмы', /жакет|пиджак|костюм/i],
  ['Трикотаж', /свитер|кардиган|кофт|джерси|лонгслив|поло|джемпер|водолазк|худи|свитшот/i],
  ['Платья и юбки', /плать|сарафан|юбк/i],
  ['Рубашки и блузы', /рубашк|блуз/i],
  ['Футболки и топы', /футболк|топ|майк|рашгард/i],
  ['Брюки и джинсы', /брюки|джинс|шорт|леггинс|штаны|комбинезон/i],
  ['Обувь', /вьетнамк|мюли|кеды|кроссовк|таби|балетк|казаки|ботин|сапог|туфл|лофер|сандал|шлепк|шлёпк|босонож|слипон/i],
  ['Аксессуары', /сумк|сумочк|шоппер|очки|часы|шарф|шапк|панам|кепк|ремень|перчатк|кошел|платок|браслет|серьг|колье|блокнот/i],
  ['Красота и подарки', /набор|блеск|крем|парфюм|аромат|свеч/i],
];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{23F0}-\u{23FF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}]/gu;
const STRIP_PHRASES = [
  /в мужском отделе eurostock/i, /шок цена!?/i, /как же это красиво/i, /появились!?/i, /из новой коллекции/i, /в москве$/i, /всего один/i, /идеальн(ая|ый)/i, /лимитированная коллекция style not com/i, /позицию очень сложно поймать во многих размерах/i, /из лимитированной и неуловимой коллекции/i,
  /выкупили для вас столько супер-позиций на распродаже/i, /супер-позиций на распродаже/i, /готовимся к зиме!?/i,
  /для всех любителей лео/i, /к нам приехала самая новая коллекция/i, /лучший момент купить летние позиции/i,
  /-?\s*сейчас!/i, /по сниженной цене!?/i, /очень популярный/i, /трендовые/i, /осталась последняя/i, /тёплый и уютный/i,
  /вау!?/i, /доступен один свободный/i, /в москве у нас еще остались/i, /со скидкой/i, /у нас вы можете приобрет(сти|и)/i,
  /в полной комплектации за/i, /(^|\s)снова(?=\s|$)/i, /уже в наличии!?/i, /не нужно ждать доставку из европы!?/i,
  /в наличии остались последние единицы!?/i, /(^|\s)последний!?/i, /(^|\s)от\s*$/i,
];
const CONTACT_LINE = /девочки|@tatianamoseuro|\+7 ?963|записаться|купить|забронировать|для заказа|мы в max|^тг\b|^max\b|примерк|запись в/i;
const SIZE_TOKEN = /^(XS|S|M|L|XL|XXL|XXXL|\d{2}([,.]5)?)$/i;

function clean(s) {
  return s.replace(EMOJI_RE, '').replace(/#\S+/g, '').replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}
function stripMarketing(s) {
  let t = s;
  for (const re of STRIP_PHRASES) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').replace(/^[\s\-–—:,.!]+|[\s\-–—:,.!]+$/g, '').trim();
  return t;
}
function cyrToLat(tok) {
  return tok.replace(/[МM]/g, 'M').replace(/[ХX]/g, 'X').replace(/[СS]/g, 'S').replace(/[ЛL]/g, 'L');
}
function normalizeText(raw) {
  let t = raw.replace(/ /g, ' ').replace(/#Massimo\s+Dutti/gi, '#MassimoDutti');
  if (!t.includes('\n')) {
    // пост пришёл одной строкой — восстанавливаем переносы перед служебными блоками
    t = t.replace(/\s+(?=(Размер|Размеры|Состав|Наполнение|Записаться|Купить|Забронировать|Для заказа|Запись в|ТГ -|MAX -|Мы в MAX|▪️|◾️|🏷|🌟|Уже в наличии|Остался|Единый размер))/g, '\n').replace(/\s+(?=[А-ЯЁ][а-яё]+ \d+\s*%)/g, '\n');
  }
  return t;
}

function categoryFor(title, { brand, isSport, context = '' }) {
  let category = null;
  if (isSport && !/очки|сумк|кеды|кроссовк/i.test(title)) category = 'Спорт';
  if (!category) for (const [name, re] of CATEGORIES) { if (re.test(title)) { category = name; break; } }
  if (!category) for (const [name, re] of CATEGORIES) { if (re.test(context)) { category = name; break; } }
  if (brand === 'LEGO' || /фотоаппарат/i.test(title)) category = 'Другое';
  if (brand === 'Rituals' || brand === 'Charlotte Tilbury') category = 'Красота и подарки';
  return category || 'Другое';
}

function parsePost(post) {
  const text = normalizeText(post.text || '');
  if (!/₽/.test(text) || SKIP_RE.test(text)) return null;
  // убираем ведущие эмодзи-маркеры строк (⏺, ▪️, 🆕 …), чтобы «⏺Размер: S» читался как «Размер: S»
  const lines = text.split('\n').map(l => l.replace(/^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{23F0}-\u{23FF}\u{25A0}-\u{25FF}]|\s)+/u, '').trim());
  const nonEmpty = lines.filter(Boolean);

  // ---- бренд
  const tags = [...text.matchAll(/#([A-Za-zА-Яа-яёЁ][\wА-Яа-яёЁ]*)/g)].map(m => m[1]).filter(t => !SERVICE_TAGS.has(t.toLowerCase()));
  let brand = null;
  if (tags.length) {
    const key = tags[0].toLowerCase();
    brand = BRAND_MAP[key] || tags[0].replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  if (!brand) for (const [k, v] of Object.entries(BRAND_MAP)) { if (new RegExp(`\\b${v.replace(/[&]/g, '\\&')}\\b`, 'i').test(text)) { brand = v; break; } }

  // ---- цены
  const priceLines = [];
  let oldPrice = null;
  nonEmpty.forEach((l, idx) => {
    const inst = l.match(/вместо\s+(\d[\d .]*)\s*₽/i);
    if (inst) oldPrice = parseInt(inst[1].replace(/[ .]/g, ''), 10);
    const rest = l.replace(/вместо\s+\d[\d .]*\s*₽/i, '');
    for (const m of rest.matchAll(/(\d[\d .]*)\s*₽/g)) {
      const p = parseInt(m[1].replace(/[ .]/g, ''), 10);
      if (p < 300) continue;
      let label = clean(rest.replace(/(\d[\d .]*)\s*₽/g, '').replace(/стоимость:?/i, '')).replace(/^[-–—:]\s*|\s*[-–—:]$/g, '').trim();
      if (!label && idx > 0) { const pm = nonEmpty[idx - 1].match(/^([а-яё\- ]+?)\s*[-–—:]\s*(.+)$/i); if (pm && !/^размер|^состав|^цвет|^наполнение/i.test(pm[1])) label = clean(pm[1]); }
      if (!label) for (let k = idx - 1; k >= Math.max(0, idx - 2); k--) { const cand = nonEmpty[k]; if (/₽|^размер|^состав|^цвет|^наполнение|\d+\s*%/i.test(cand) || CONTACT_LINE.test(cand)) continue; const c = stripMarketing(clean(cand)); if (c.length >= 3 && c.length <= 40) { label = c; break; } }
      priceLines.push({ price: p, label, idx });
    }
  });
  if (!priceLines.length) return null;
  // «18.500₽» и на следующей строке «14.000₽» — первая была зачёркнута
  if (!oldPrice && priceLines.length === 2 && priceLines[1].idx === priceLines[0].idx + 1 && priceLines[0].price > priceLines[1].price && !priceLines[0].label && !priceLines[1].label) {
    oldPrice = priceLines.shift().price;
  }
  const price = priceLines[0].price;
  const variants = priceLines.length > 1 ? priceLines.map(p => ({ label: p.label || 'Основная позиция', price: p.price })) : [];

  // ---- название
  const candidates = [];
  const tagLine = nonEmpty.find(l => /#[A-Za-z]/.test(l));
  if (tagLine) candidates.push(tagLine);
  for (const l of nonEmpty) {
    if (l === tagLine || CONTACT_LINE.test(l) || /₽/.test(l) || /^размер|^состав|^наполнение|^в наличии|^цвет|^остал|единый размер/i.test(l) || /\d+\s*%/.test(l) && !/^[А-ЯЁ][а-яё]+ из \d+% /i.test(l)) continue;
    if (/^[А-ЯЁA-Z]/.test(l) || /^[а-яё]/i.test(l)) candidates.push(l);
  }
  let title = '';
  let titleLine = null;
  for (const c of candidates) {
    const t = stripMarketing(clean(c));
    if (t.length >= 3 && !/^(xs|s|m|l|xl)\b/i.test(t)) { title = t; titleLine = c; break; }
  }
  if (!title) {
    const lbl = priceLines.find(p => p.label && /^[а-яё]+$/i.test(p.label));
    if (lbl) title = lbl.label;
  }
  let needsReview = false;
  if (!title) { if (!brand) return null; title = oldPrice ? 'Позиция из распродажи' : `Товар ${brand}`; needsReview = true; }
  if (brand === 'Burker' && !/часы/i.test(title)) title = `Часы ${title}`;
  title = title.replace(/\s+из в\s+/, ' в ').replace(/\s{2,}/g, ' ').trim();
  title = title[0].toUpperCase() + title.slice(1);
  if (title.length > 80) { title = title.slice(0, 77).replace(/\s\S*$/, '') + '…'; needsReview = true; }

  // ---- категория
  const isSport = /#спортивнаяодежда/i.test(text) || brand === 'Adidas' || (brand === 'Oysho' && /спортив|леггинс|рашгард|комбинезон|форма|костюм|топ/i.test(text));
  const category = categoryFor(title, { brand, isSport, context: nonEmpty.slice(0, 4).join(' ') });

  // ---- размеры
  const sizes = [];
  const sizeLines = [];
  for (const l of nonEmpty) {
    let m = l.match(/^размер[ыа]?:?\s*(.+)$/i) || l.match(/^остал(ся|ись)\s+(?:только\s+)?(?:последние\s+)?размер[ыа]?:?\s*(.+)$/i);
    if (m) { sizeLines.push(m[m.length - 1]); continue; }
    if (/^единый размер/i.test(l)) { sizeLines.push('Единый размер'); continue; }
    if (/^\d{2}([,.]\d)?(\s*;\s*\d{2}([,.]\d)?)+$/.test(l)) { sizeLines.push(l); continue; }
    m = l.match(/^([а-яё\- ]+?)\s*[-–—:]\s*(.+)$/i);
    if (m && !/₽/.test(l) && !/^размер|^состав|^цвет|^наполнение/i.test(l)) {
      const toks = m[2].replace(/\(.*?\)/g, '').split(/[,/]/).map(s => s.trim());
      if (toks.length && toks.every(t => SIZE_TOKEN.test(cyrToLat(t)))) sizeLines.push(m[2]);
      continue;
    }
    m = l.match(/^в наличии\s+([\d, ]+)$/i);
    if (m) { sizeLines.push(m[1]); continue; }
    m = clean(l).match(/^([а-яё]+)\s+(.+)$/i);
    if (m && !/₽/.test(l)) { const toks = m[2].split(/,/).map(s => s.trim()); if (toks.length && toks.every(t => SIZE_TOKEN.test(cyrToLat(t)))) sizeLines.push(m[2]); }
  }
  for (const sl of sizeLines) {
    if (/(^|\s|\d)см(\s|$)|x\s*\d{3}|х\d{2,3}/i.test(sl)) continue; // габариты (шарфы), а не размер
    if (/единый размер/i.test(sl)) { if (!sizes.includes('ONE')) sizes.push('ONE'); continue; }
    const norm = sl.replace(/маломерят|большемерит|р-р/gi, ' ').replace(/\([^)]*\//g, '(').replace(/(\d),(\d)/g, '$1.$2');
    for (const part of norm.split(/[,;](?![^(]*\))|\s-\s|(?<=[A-ZА-Я])-(?=[A-ZА-Я])/)) {
      const lat = cyrToLat(part.trim());
      const letter = lat.match(/(?:^|[\s(])(XXXL|XXL|XL|XS|S|M|L)(?=$|[\s)])/);
      const num = lat.replace(/\(.*?\)/g, '').match(/\b\d{2}(\.5)?\b/);
      const s = letter ? letter[1] : (num ? num[0].replace('.5', ',5') : null);
      if (s && !sizes.includes(s)) sizes.push(s);
    }
  }
  // ---- проданные размеры: в посте их зачёркивают (strikethrough). Из веб-версии приходят как post.struck,
  //      из Bot API — как entities типа strikethrough; и там и там получаем список зачёркнутых фрагментов.
  const soldSizes = [];
  for (const frag of (post.struck || [])) {
    if (/₽/.test(frag) || /^\d[\d .]*$/.test(frag.trim()) && parseInt(frag.replace(/[ .]/g, ''), 10) > 300) continue; // зачёркнутая старая цена
    for (const part of frag.replace(/\([^)]*\//g, '(').split(/[,;]/)) {
      const lat = cyrToLat(part.trim());
      const letter = lat.match(/(?:^|[\s(])(XXXL|XXL|XL|XS|S|M|L)(?=$|[\s)])/);
      const num = lat.replace(/\(.*?\)/g, '').match(/\b\d{2}(\.5)?\b/);
      const s = letter ? letter[1] : (num ? num[0].replace('.5', ',5') : null);
      if (s && sizes.includes(s) && !soldSizes.includes(s)) soldSizes.push(s);
    }
  }
  for (const s of soldSizes) sizes.splice(sizes.indexOf(s), 1);
  const soldOut = /продано|sold out|sold/i.test(text) && !/распродаж/i.test(text) || (soldSizes.length > 0 && sizes.length === 0);
  const sizeLabel = sizeLines.length ? clean(sizeLines.map(s => cyrToLat(s)).join('; ')) : null;
  const ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
  sizes.sort((a, b) => { const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b); if (ia >= 0 && ib >= 0) return ia - ib; if (ia >= 0) return -1; if (ib >= 0) return 1; return parseFloat(a.replace(',', '.')) - parseFloat(b.replace(',', '.')); });
  const sizeNoteMatch = text.match(/маломерят|большемерит/i);
  const sizeNote = sizeNoteMatch ? (sizeNoteMatch[0].toLowerCase() === 'маломерят' ? 'Маломерит' : 'Большемерит') : null;

  // ---- состав / описание
  let composition = null;
  for (const l of nonEmpty) {
    if (l === titleLine || /#/.test(l) || /₽/.test(l)) continue;
    if (/\d+\s*%/.test(l) || /^наполнение/i.test(l) || /^(натуральная|козья)\s+кожа/i.test(l) || /^кашемир 100/i.test(l)) {
      composition = clean(l.replace(/^состав:\s*/i, '')).replace(/седа/i, 'шёлк');
      composition = composition[0].toUpperCase() + composition.slice(1);
      break;
    }
  }
  const colorLine = nonEmpty.find(l => /^цвет:?\s/i.test(l) || /^(в\s+)?[а-яё\-]+(ый|ая|ое|ые|ий|ом)\s+цвет(е)?!?\s*$/i.test(clean(l)));
  const description = nonEmpty.filter(l => l !== titleLine && !CONTACT_LINE.test(l) && !/₽/.test(l) && !/^размер|^состав|^наполнение|^цвет|^в наличии/i.test(l)
    && !sizeLines.some(s => l.endsWith(s)) && clean(l).length > 12 && !(composition && clean(l).includes(composition.slice(0, 12))))
    .map(l => stripMarketing(clean(l))).filter(l => l.length > 12).join(' ') || null;

  const textKey = clean(text).toLowerCase().replace(/[^a-zа-яё0-9₽%]+/g, ' ').trim();
  const hasPhotos = !!((post.photos && post.photos.length) || (post.media && post.media.some(m => m.type === 'photo')));
  const images = (post.photos && post.photos.length) ? post.photos : (post.media ? post.media.filter(m => m.type === 'photo').map(m => m.key) : (post.thumbs || []));
  return {
    id: post.id,
    postUrl: `https://t.me/eurostockmoscowshop/${post.id}`,
    date: post.date || null,
    brand: brand || 'Без бренда',
    title,
    category,
    isSport,
    price,
    oldPrice,
    variants,
    sizes,
    soldSizes,
    status: soldOut ? 'sold' : 'available',
    sizeLabel,
    sizeNote,
    color: colorLine ? clean(colorLine).replace(/^цвет:?\s*/i, '').replace(/^в\s+/i, '').replace(/\s*цвете?$/i, '').replace(/^(\S+)ом$/, '$1ый') : null,
    composition,
    description,
    gender: /унисекс/i.test(text) ? 'unisex' : (/#мужск|мужск(ая|ой|ие|ое)/i.test(text) ? 'male' : 'female'),
    isNew: /🆕/.test(text) || /новая коллекция/i.test(text),
    isLast: /последн/i.test(text),
    images,
    hasPhotos,
    textKey,
    video: (post.video || [])[0] || null,
    needsReview,
  };
}

function dedupe(items, keepSeparate = new Set()) {
  // репосты с тем же товаром → оставляем пост с фото (не видео), при равенстве — последний
  const byKey = new Map();
  for (const it of items) {
    // склеиваем только буквальные перепубликации (тот же текст поста), а не похожие товары
    const key = keepSeparate.has(it.id) ? `id:${it.id}` : it.textKey;
    const prev = byKey.get(key);
    const score = x => (x.hasPhotos ? 100 : 0) + Math.min(x.images.length, 3);
    if (!prev || score(it) >= score(prev)) byKey.set(key, it);
  }
  return [...byKey.values()];
}

// Зачёркнутые фрагменты из entities Bot API (type: 'strikethrough'); offset/length — в UTF-16, как и строки JS
function struckFromEntities(text, entities) {
  return (entities || []).filter(e => e.type === 'strikethrough').map(e => text.substr(e.offset, e.length).trim()).filter(Boolean);
}

module.exports = { parsePost, dedupe, categoryFor, CATEGORIES, struckFromEntities };

if (require.main === module) {
  const fs = require('fs');
  const [, , input, output] = process.argv;
  const posts = JSON.parse(fs.readFileSync(input, 'utf8'));
  const skipped = [];
  let items = [];
  for (const p of posts) {
    const it = parsePost(p);
    if (!it) { skipped.push(p.id); continue; }
    items.push(it);
  }
  items = dedupe(items).sort((a, b) => b.id - a.id);
  fs.writeFileSync(output, JSON.stringify(items, null, 1));
  console.log(`items: ${items.length}, skipped: ${skipped.join(',')}`);
  const byCat = {}; const byBrand = {};
  for (const it of items) { byCat[it.category] = (byCat[it.category] || 0) + 1; byBrand[it.brand] = (byBrand[it.brand] || 0) + 1; }
  console.log(byCat); console.log(byBrand);
  for (const it of items) console.log(it.id, '|', it.brand, '|', it.title, '|', it.category, '|', it.price, it.oldPrice ? `(было ${it.oldPrice})` : '', '|', it.sizes.join(','), '|', it.composition || '', it.needsReview ? '| REVIEW' : '', it.variants.length ? '| ' + it.variants.map(v => `${v.label} ${v.price}`).join('; ') : '', it.description ? '| D: ' + it.description.slice(0, 60) : '');
}
