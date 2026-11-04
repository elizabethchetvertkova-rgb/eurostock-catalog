#!/usr/bin/env node
'use strict';
// Рилс «Новинки недели»: вертикальный ролик 1080×1920 из вещей, добавленных в каталог за последние 7 дней.
// Запускается отдельной задачей GitHub Actions (.github/workflows/reel.yml) по воскресеньям в 09:00 МСК
// или по команде боту: /reel preview (прислать администратору), /reel now (опубликовать в канал).
//
// Режимы (переменная REEL_MODE): auto — по расписанию: опубликовать в канал + прислать файл администраторам;
//                               preview — только прислать администраторам; publish — опубликовать сейчас (+ файл администраторам).
// Нужны: ffmpeg (есть на ubuntu-latest), chromium для Playwright (ставится в workflow), шрифты из npm (@fontsource).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const CURATION_FILE = path.join(ROOT, 'curation.json');
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = (process.env.CHANNEL || '@eurostockmoscowshop').toLowerCase();
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number);
const MODE = process.env.REEL_MODE || 'auto';
const WORK = process.env.REEL_WORKDIR || path.join(ROOT, '.reel');
const DAYS = Number(process.env.REEL_DAYS || 7);
const MAX_ITEMS = Number(process.env.REEL_MAX || 8);
const MIN_ITEMS = Number(process.env.REEL_MIN || 3);

const cur = fs.existsSync(CURATION_FILE) ? JSON.parse(fs.readFileSync(CURATION_FILE, 'utf8')) : {};
const reelCfg = cur.reel || {};
const defaultCatalogUrl = () => { const r = process.env.GITHUB_REPOSITORY; if (!r) return null; const [o, n] = r.split('/'); return `https://${o.toLowerCase()}.github.io/${n}/`; };

if (!TOKEN) { console.error('BOT_TOKEN не задан'); process.exit(1); }
if (MODE === 'auto' && reelCfg.enabled === false) { console.log('рилс выключен (/reel on — включить)'); process.exit(0); }

const api = async (method, params) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const j = await r.json(); if (!j.ok) throw new Error(`${method}: ${j.description}`); return j.result;
};
const sendVideo = async (chatId, file, caption, markup) => {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), 'eurostock-reel.mp4');
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  fd.append('supports_streaming', 'true'); fd.append('width', '1080'); fd.append('height', '1920');
  if (markup) fd.append('reply_markup', JSON.stringify(markup));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVideo`, { method: 'POST', body: fd });
  const j = await r.json(); if (!j.ok) throw new Error(`sendVideo: ${j.description}`); return j.result;
};
const notify = async text => { for (const a of ADMIN_IDS) { try { await api('sendMessage', { chat_id: a, text }); } catch (e) {} } };
const replyChat = process.env.REEL_CHAT ? [Number(process.env.REEL_CHAT)] : ADMIN_IDS;
const say = async text => { for (const a of replyChat) { try { await api('sendMessage', { chat_id: a, text }); } catch (e) {} } };

// ---------- выбор вещей: добавлены за DAYS дней, в наличии, с фото
function pickItems() {
  const products = JSON.parse(fs.readFileSync(path.join(DOCS, 'products.json'), 'utf8'));
  const since = Date.now() - DAYS * 86400e3;
  const fresh = products
    .filter(p => p.status !== 'sold' && p.status !== 'hidden' && p.images && p.images.length && p.price)
    .filter(p => p.date && Date.parse(p.date) >= since - 3 * 3600e3)
    .filter(p => fs.existsSync(path.join(DOCS, p.images[0])))
    .sort((a, b) => b.id - a.id);
  // не больше трёх вещей одного бренда подряд, чтобы ролик не был «восемь пуховиков»
  const out = []; const perBrand = {};
  for (const p of fresh) { perBrand[p.brand] = (perBrand[p.brand] || 0) + 1; if (perBrand[p.brand] > 4) continue; out.push(p); if (out.length >= MAX_ITEMS) break; }
  return out;
}

// ---------- шрифты (из npm @fontsource, ставятся в workflow)
function fontsDir() {
  for (const d of [path.join(ROOT, 'node_modules', '@fontsource'), path.join(WORK, 'node_modules', '@fontsource')]) if (fs.existsSync(d)) return d;
  return null;
}

// ---------- слои текста (Playwright → PNG 1080×1920)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = n => n.toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽';
function css(F) {
  const face = (fam, file, weight, style = 'normal') => fs.existsSync(file) ? `@font-face{font-family:'${fam}';src:url('file://${file}') format('woff2');font-weight:${weight};font-style:${style};}` : '';
  const fonts = F ? [
    ...['latin', 'cyrillic'].flatMap(sub => [400, 500, 600].map(w => face('Playfair Display', `${F}/playfair-display/files/playfair-display-${sub}-${w}-normal.woff2`, w))),
    ...['latin', 'cyrillic'].map(sub => face('Playfair Display', `${F}/playfair-display/files/playfair-display-${sub}-400-italic.woff2`, 400, 'italic')),
    ...['latin', 'cyrillic'].flatMap(sub => [400, 500, 600].map(w => face('Golos Text', `${F}/golos-text/files/golos-text-${sub}-${w}-normal.woff2`, w))),
  ].join('\n') : '';
  return `${fonts}
:root{--wine:#66011F;--pink:#F3CED9;--cream:#FBF4F0}
html,body{margin:0;width:1080px;height:1920px;overflow:hidden}
body{font-family:'Golos Text',-apple-system,Arial,sans-serif;color:#fff}
.serif{font-family:'Playfair Display',Georgia,serif}
.eyebrow{font-size:30px;letter-spacing:.32em;text-transform:uppercase;font-weight:500}`;
}
const page = (style, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`;
const logo = `<div style="width:56px;height:56px;border-radius:50%;background:var(--wine);border:2px solid rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;letter-spacing:.06em;line-height:1.05;text-align:center">EURO<br>STOCK</div>`;
function itemHtml(style, p, i, n) {
  const size = p.sizes && p.sizes.length ? `размер ${p.sizes.join(' / ')}` : '';
  const brand = p.brand && p.brand !== 'Без бренда' ? p.brand : 'Шоурум EUROSTOCK';
  return page(style, `
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.28) 0%,rgba(0,0,0,0) 22%,rgba(0,0,0,0) 48%,rgba(26,2,10,.86) 100%)"></div>
  <div style="position:absolute;left:64px;top:92px;display:flex;align-items:center;gap:18px">${logo}<div class="eyebrow" style="font-size:24px;opacity:.95">Шоурум · Москва</div></div>
  <div style="position:absolute;right:64px;top:98px;padding:12px 24px;border-radius:999px;background:rgba(255,255,255,.18);font-size:26px;font-weight:500;letter-spacing:.04em">${i + 1} / ${n}</div>
  <div style="position:absolute;left:64px;right:64px;bottom:150px">
    <div class="eyebrow" style="color:var(--pink);margin-bottom:22px">${esc(brand)}</div>
    <div class="serif" style="font-size:${p.title.length > 26 ? 68 : 88}px;line-height:1.02;font-weight:500;letter-spacing:-.01em;max-width:920px">${esc(p.title)}</div>
    <div style="display:flex;align-items:center;gap:26px;margin-top:38px;flex-wrap:wrap">
      <div style="font-size:62px;font-weight:600;letter-spacing:-.01em">${fmt(p.price)}</div>
      ${size ? `<div style="font-size:30px;font-weight:500;padding:14px 26px;border:2px solid rgba(255,255,255,.55);border-radius:999px">${esc(size)}</div>` : ''}
    </div>
    <div style="margin-top:34px;font-size:30px;opacity:.85;display:flex;align-items:center;gap:14px"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#7ED957"></span>в наличии в Москве</div>
  </div>`);
}
const coverHtml = (style, title, sub) => page(style, `
  <div style="position:absolute;inset:0;background:var(--wine)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(900px 700px at 20% 15%,rgba(243,206,217,.28),transparent 60%),radial-gradient(700px 700px at 90% 95%,rgba(243,206,217,.18),transparent 60%)"></div>
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 90px">
    <div class="eyebrow" style="color:var(--pink);font-size:32px">Шоурум · Москва</div>
    <div class="serif" style="font-size:150px;line-height:.95;font-weight:500;margin-top:44px;letter-spacing:-.01em">EURO<br>STOCK</div>
    <div style="width:140px;height:2px;background:var(--pink);margin:70px 0 60px;opacity:.9"></div>
    <div class="serif" style="font-size:76px;font-style:italic;font-weight:400;color:var(--cream)">${esc(title)}</div>
    <div style="margin-top:36px;font-size:32px;opacity:.85;line-height:1.45">${sub}</div>
  </div>`);
const outroHtml = style => page(style, `
  <div style="position:absolute;inset:0;background:var(--wine)"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(800px 800px at 80% 10%,rgba(243,206,217,.25),transparent 60%)"></div>
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 90px">
    <div class="serif" style="font-size:92px;line-height:1.05;font-weight:500">Приходите<br>на примерку</div>
    <div style="width:140px;height:2px;background:var(--pink);margin:64px 0 56px"></div>
    <div style="font-size:36px;line-height:1.5;opacity:.95">Старокалужское шоссе, 62 стр. 1<br><span style="opacity:.75">м. Воронцовская / Калужская</span></div>
    <div style="margin-top:70px;padding:30px 54px;border-radius:999px;background:var(--pink);color:var(--wine);font-size:36px;font-weight:600;letter-spacing:.02em">Каталог и запись — @eurostockmoscowshop</div>
    <div style="margin-top:34px;font-size:30px;opacity:.8">Татьяна · @tatianamoseuro</div>
  </div>`);

async function renderOverlays(items) {
  const { chromium } = require('playwright');
  const style = css(fontsDir());
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  const ov = path.join(WORK, 'ov'); fs.mkdirSync(ov, { recursive: true });
  const shot = async (html, file, transparent) => {
    await pg.setContent(html, { waitUntil: 'load' });
    await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(100);
    await pg.screenshot({ path: path.join(ov, file), omitBackground: transparent });
  };
  await shot(coverHtml(style, reelCfg.title || 'Новинки недели', reelCfg.subtitle || 'Европейские бренды<br>уже в Москве — можно примерить'), 'cover.png', false);
  for (let i = 0; i < items.length; i++) await shot(itemHtml(style, items[i], i, items.length), `item_${items[i].id}.png`, true);
  await shot(outroHtml(style), 'outro.png', false);
  await b.close();
  return ov;
}

// ---------- сцены ffmpeg
const ENC = ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', '30'];
const FADE = '0x66011F';
function ff(args) { execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); }
function renderScenes(items, ov) {
  const sc = path.join(WORK, 'scenes'); fs.mkdirSync(sc, { recursive: true });
  const per = Number(reelCfg.seconds || 2.3); const frames = Math.round(per * 30);
  const out = [];
  const scene = (name, args, dur) => { const tmp = path.join(sc, `tmp_${name}.mp4`); const fin = path.join(sc, `${name}.mp4`); ff([...args, ...ENC, '-t', String(dur), tmp]); fs.renameSync(tmp, fin); out.push(fin); };
  scene('00_cover', ['-i', path.join(ov, 'cover.png'), '-filter_complex', `[0:v]scale=2160:3840,zoompan=z='min(1+0.0006*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=72:s=1080x1920:fps=30,format=yuv420p,fade=t=in:st=0:d=0.4:color=${FADE},fade=t=out:st=2.15:d=0.25:color=${FADE}[v]`, '-map', '[v]'], 2.4);
  items.forEach((p, i) => {
    const z = i % 2 === 0 ? "min(1+0.0012*on,1.085)" : "max(1.085-0.0012*on,1)";
    scene(`${String(i + 1).padStart(2, '0')}_${p.id}`, ['-i', path.join(DOCS, p.images[0]), '-i', path.join(ov, `item_${p.id}.png`), '-filter_complex',
      `[0:v]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30[bg];[bg][1:v]overlay=0:0,format=yuv420p,fade=t=in:st=0:d=0.25:color=${FADE},fade=t=out:st=${(per - 0.25).toFixed(2)}:d=0.25:color=${FADE}[v]`, '-map', '[v]'], per);
  });
  scene('99_outro', ['-i', path.join(ov, 'outro.png'), '-filter_complex', `[0:v]scale=2160:3840,zoompan=z='min(1+0.0005*on,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=90:s=1080x1920:fps=30,format=yuv420p,fade=t=in:st=0:d=0.25:color=${FADE},fade=t=out:st=2.5:d=0.5:color=black[v]`, '-map', '[v]'], 3);
  const list = path.join(WORK, 'list.txt'); fs.writeFileSync(list, out.map(f => `file '${f}'`).join('\n'));
  const joined = path.join(WORK, 'joined.mp4'); ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const final = path.join(WORK, 'eurostock-reel.mp4');
  ff(['-i', joined, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', final]);
  return final;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const items = pickItems();
  console.log(`новинок за ${DAYS} дн.: ${items.length}`, items.map(p => p.id).join(', '));
  if (items.length < MIN_ITEMS) {
    const msg = `Рилс не собран: за ${DAYS} дней только ${items.length} ${items.length === 1 ? 'новинка' : 'новинки'} в наличии (нужно минимум ${MIN_ITEMS}).`;
    console.log(msg); if (MODE !== 'auto') await say(msg); return;
  }
  const ov = await renderOverlays(items);
  const file = renderScenes(items, ov);
  console.log('готово:', file, Math.round(fs.statSync(file).size / 1024), 'KB');
  const url = cur.catalogUrl || defaultCatalogUrl();
  const markup = url ? { inline_keyboard: [[{ text: cur.buttonText || '🛍 Открыть каталог', url }]] } : undefined;
  const caption = reelCfg.caption || 'Новинки недели в шоуруме 🤍\nВсё в наличии в Москве — приходите мерить. Каталог 👇';
  const list = items.map(p => `• ${p.brand && p.brand !== 'Без бренда' ? p.brand + ' — ' : ''}${p.title}, ${fmt(p.price)}`).join('\n');
  if (MODE === 'preview') {
    for (const a of replyChat) { await sendVideo(a, file, `${caption}\n\n<i>Предпросмотр: так будет выглядеть пост в канале. В ролике:</i>\n${esc(list)}\n\nОпубликовать сейчас: /reel now`, markup); }
    return;
  }
  // auto | publish
  await sendVideo(CHANNEL, file, caption, markup);
  console.log('опубликовано в', CHANNEL);
  for (const a of new Set([...ADMIN_IDS, ...replyChat])) { try { await sendVideo(a, file, `Опубликовано в ${CHANNEL}. Файл для Instagram / Stories — сохраните и выложите с музыкой из библиотеки.\n\nВ ролике:\n${esc(list)}`); } catch (e) {} }
})().catch(async e => { console.error(e.message); await say(`⚠️ Рилс не получился: ${e.message}`); process.exit(1); });
