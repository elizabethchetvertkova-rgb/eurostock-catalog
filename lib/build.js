// Сборка витрины: state (посты) → parser → curation → products.json + docs/index.html
const fs = require('fs');
const path = require('path');
const { parsePost, dedupe, categoryFor } = require('./parser');

function buildProducts(posts, cur, docsDir) {
  const excl = new Set((cur.exclude || []).map(Number));
  const exclImg = new Set(cur.excludeImages || []);
  let items = posts.map(parsePost).filter(Boolean).filter(i => !excl.has(i.id));
  items = dedupe(items, new Set((cur.keepSeparate || []).map(Number))).sort((a, b) => b.id - a.id);
  const byId = Object.fromEntries(posts.map(p => [p.id, p]));
  for (const it of items) {
    const id = String(it.id);
    const post = byId[it.id];
    if (cur.title && cur.title[id]) { it.title = cur.title[id]; it.needsReview = false; it.category = categoryFor(it.title, { brand: it.brand, isSport: it.isSport }); }
    if (cur.gender && cur.gender[id]) it.gender = cur.gender[id];
    if (cur.brand && cur.brand[id]) it.brand = cur.brand[id];
    if (cur.category && cur.category[id]) it.category = cur.category[id];
    // ручные пометки «продано» (команды боту): all | [размеры]
    const sold = cur.sold && cur.sold[id];
    if (sold === 'all') it.status = 'sold';
    else if (Array.isArray(sold)) { for (const s of sold) { if (it.sizes.includes(s)) { it.sizes.splice(it.sizes.indexOf(s), 1); if (!it.soldSizes.includes(s)) it.soldSizes.push(s); } } if (it.soldSizes.length && !it.sizes.length) it.status = 'sold'; }
    if ((cur.hidden || []).map(Number).includes(it.id)) it.status = 'hidden';
    // фото: локальные файлы поста (post.media) — главное по curation.mainImage
    let imgs = (post.media || []).filter(m => m.type === 'photo').map(m => m.key).filter(k => !exclImg.has(k) && fs.existsSync(path.join(docsDir, 'img', k + '.jpg')));
    if (!imgs.length) imgs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `${id}_${i}`).filter(k => !exclImg.has(k) && fs.existsSync(path.join(docsDir, 'img', k + '.jpg')));
    const mainIdx = cur.mainImage && cur.mainImage[id];
    const main = mainIdx != null ? `${id}_${mainIdx}` : null;
    if (main && imgs.includes(main)) imgs = [main, ...imgs.filter(k => k !== main)];
    it.images = imgs.map(k => `img/${k}.jpg`);
    it.videos = (post.media || []).filter(m => m.type === 'video' && fs.existsSync(path.join(docsDir, 'video', m.key + '.mp4')))
      .map(m => ({ src: `video/${m.key}.mp4`, poster: fs.existsSync(path.join(docsDir, 'img', m.key + '_thumb.jpg')) ? `img/${m.key}_thumb.jpg` : null }));
    delete it.video; delete it.hasPhotos; delete it.textKey;
  }
  return items;
}

function buildSite(items, docsDir, templatePath) {
  const tpl = fs.readFileSync(templatePath, 'utf8');
  const visible = items.filter(i => i.status !== 'hidden');
  fs.writeFileSync(path.join(docsDir, 'products.json'), JSON.stringify(visible));
  const head = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#66011f">\n';
  fs.writeFileSync(path.join(docsDir, 'index.html'), head + tpl.replace('__PRODUCTS__', JSON.stringify(visible).replace(/<\//g, '<\\/')) + '\n</html>\n');
  return visible;
}

module.exports = { buildProducts, buildSite };
