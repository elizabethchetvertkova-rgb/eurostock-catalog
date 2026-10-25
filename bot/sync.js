#!/usr/bin/env node
// Синхронизация канала → каталог.
// Запускается по расписанию (GitHub Actions) или вручную: node bot/sync.js
// Переменные окружения: BOT_TOKEN (обязательно), ADMIN_IDS (id через запятую), CHANNEL (@username или id канала)
 
const fs = require('fs');
const path = require('path');
const { parsePost, struckFromEntities } = require('../lib/parser');
const { buildProducts, buildSite } = require('../lib/build');
 
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const CURATION_FILE = path.join(ROOT, 'curation.json');
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = (process.env.CHANNEL || '@eurostockmoscowshop').toLowerCase();
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number);
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // лимит Bot API на скачивание
 
const BUILD_ONLY = process.argv.includes('--build');
if (!TOKEN && !BUILD_ONLY) { console.error('BOT_TOKEN не задан'); process.exit(1); }
 
const api = async (method, params = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
};
const download = async (fileId, dest) => {
  const f = await api('getFile', { file_id: fileId });
  if (f.file_size && f.file_size > MAX_VIDEO_BYTES) return false;
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return true;
};
const load = (f, d) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
const isOurChannel = chat => chat && (String(chat.username || '').toLowerCase() === CHANNEL.replace('@', '') || String(chat.id) === CHANNEL);
 
// ---------- состояние
const state = load(STATE_FILE, { offset: 0, posts: {}, groups: {} });
const cur = load(CURATION_FILE, {});
const log = [];
let changed = false;
 
function postFromMessage(msg) {
  // channel_post → запись о посте (текст, зачёркнутое, медиа). Альбомы собираются по media_group_id.
  const text = msg.caption || msg.text || '';
  const entities = msg.caption_entities || msg.entities || [];
  const media = [];
  if (msg.photo && msg.photo.length) media.push({ type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id, msg_id: msg.message_id });
  if (msg.video) media.push({ type: 'video', file_id: msg.video.file_id, thumb: msg.video.thumbnail ? msg.video.thumbnail.file_id : null, size: msg.video.file_size, msg_id: msg.message_id });
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) media.push({ type: 'photo', file_id: msg.document.file_id, msg_id: msg.message_id });
  return { text, struck: struckFromEntities(text, entities), media, date: new Date(msg.date * 1000).toISOString().slice(0, 10) };
}
 
function upsertFromMessage(msg, edited) {
  const part = postFromMessage(msg);
  let id = msg.message_id;
  if (msg.media_group_id) {
    const g = state.groups[msg.media_group_id] || { ids: [], text: '', struck: [], media: [], date: part.date };
    if (!g.ids.includes(msg.message_id)) g.ids.push(msg.message_id);
    if (part.text) { g.text = part.text; g.struck = part.struck; g.caption_id = msg.message_id; }
    for (const m of part.media) if (!g.media.some(x => x.msg_id === m.msg_id)) g.media.push(m);
    g.media.sort((a, b) => a.msg_id - b.msg_id);
    state.groups[msg.media_group_id] = g;
    id = Math.min(...g.ids);
    // если раньше пост был записан под другим id этой группы — переносим
    for (const other of g.ids) if (other !== id && state.posts[other]) delete state.posts[other];
    state.posts[id] = { id, date: g.date, text: g.text, struck: g.struck, media: g.media.map((m, i) => ({ ...m, key: `${id}_${i}` })), group: msg.media_group_id, caption_id: g.caption_id || id };
  } else {
    const prev = state.posts[id] || {};
    state.posts[id] = { ...prev, id, date: prev.date || part.date, text: part.text, struck: part.struck, media: part.media.length ? part.media.map((m, i) => ({ ...m, key: `${id}_${i}` })) : (prev.media || []) };
  }
  if (edited) {
    // правка может прийти по любому сообщению альбома
    const target = Object.values(state.posts).find(p => p.id === id || (p.group && p.group === msg.media_group_id));
    if (target && part.text) { target.text = part.text; target.struck = part.struck; }
  }
  changed = true;
  log.push(`${edited ? 'правка' : 'пост'} #${id}: ${part.text.split('\n')[0].slice(0, 50)}`);
  return id;
}
 
async function fetchMedia() {
  // скачиваем недостающие файлы (оригинальное качество из Telegram)
  for (const p of Object.values(state.posts)) {
    for (const m of p.media || []) {
      if (!m.file_id) continue; // исторические посты без file_id — файлы уже лежат в docs/img
      if (m.type === 'photo') {
        const dest = path.join(DOCS, 'img', `${m.key}.jpg`);
        if (!fs.existsSync(dest)) { try { await download(m.file_id, dest); changed = true; } catch (e) { log.push(`не скачалось фото ${m.key}: ${e.message}`); } }
      } else if (m.type === 'video') {
        const dest = path.join(DOCS, 'video', `${m.key}.mp4`);
        if (!fs.existsSync(dest) && !m.skipped) {
          try { const ok = await download(m.file_id, dest); if (!ok) m.skipped = true; changed = true; } catch (e) { log.push(`не скачалось видео ${m.key}: ${e.message}`); }
        }
        if (m.thumb) { const t = path.join(DOCS, 'img', `${m.key}_thumb.jpg`); if (!fs.existsSync(t)) { try { await download(m.thumb, t); } catch (e) {} } }
      }
    }
  }
}
 
// ---------- удалённые посты
// Bot API не сообщает об удалении постов, поэтому проверяем сами через публичную веб-версию канала:
// у удалённого поста страница t.me/<канал>/<id>?embed=1 содержит «Post not found». За один запуск — до 40 постов,
// сначала давно не проверявшиеся; полный круг по каталогу занимает около часа.
async function checkDeleted() {
  const channelName = CHANNEL.replace('@', '');
  if (!/^[a-z0-9_]+$/i.test(channelName)) return; // канал задан числовым id — публичной страницы нет
  const hidden = new Set((cur.hidden || []).map(Number));
  const candidates = Object.values(state.posts).filter(p => /₽/.test(p.text || '')).sort((a, b) => ((a.checkedAt || 0) - (b.checkedAt || 0)) || (b.id - a.id)).slice(0, 40);
  for (const p of candidates) {
    try {
      const r = await fetch(`https://t.me/${channelName}/${p.id}?embed=1&mode=tme`, { headers: { 'user-agent': 'Mozilla/5.0 (catalog-sync)' } });
      const html = await r.text();
      if (!r.ok || !/tgme_widget_message/.test(html)) continue; // страница не отдана — не делаем выводов
      const gone = /tgme_widget_message_error/.test(html) && /Post not found/i.test(html);
      p.checkedAt = Date.now();
      if (gone && !p.deleted) { p.deleted = true; hidden.add(p.id); log.push(`пост #${p.id} удалён из канала — снят с витрины`); changed = true; }
      if (!gone && p.deleted) { p.deleted = false; hidden.delete(p.id); log.push(`пост #${p.id} снова в канале — возвращён`); changed = true; }
    } catch (e) { /* сеть недоступна — проверим в следующий раз */ }
  }
  cur.hidden = [...hidden];
}
 
// ---------- команды администратора (личные сообщения боту)
function productOf(id) {
  const p = state.posts[id] || Object.values(state.posts).find(x => (x.media || []).some(m => m.msg_id === id) || x.caption_id === id);
  return p || null;
}
function setSold(id, sizes) {
  cur.sold = cur.sold || {};
  if (!sizes || !sizes.length) cur.sold[id] = 'all';
  else { const prev = Array.isArray(cur.sold[id]) ? cur.sold[id] : []; cur.sold[id] = [...new Set([...prev, ...sizes])]; }
  changed = true;
}
function setAvailable(id, sizes) {
  cur.sold = cur.sold || {};
  if (!sizes || !sizes.length) delete cur.sold[id];
  else if (Array.isArray(cur.sold[id])) { cur.sold[id] = cur.sold[id].filter(s => !sizes.includes(s)); if (!cur.sold[id].length) delete cur.sold[id]; }
  else delete cur.sold[id];
  cur.hidden = (cur.hidden || []).filter(x => Number(x) !== Number(id));
  changed = true;
}
const normSize = s => s.toUpperCase().replace(/М/g, 'M').replace(/Х/g, 'X').replace(/С/g, 'S').replace(/Л/g, 'L');
const parseSizes = str => str.split(/[\s,;/]+/).map(normSize).filter(s => /^(XS|S|M|L|XL|XXL|XXXL|\d{2}(,5)?)$/.test(s));
 
async function handleAdminMessage(msg) {
  const from = msg.from && msg.from.id;
  const reply = text => api('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML' });
  if (!ADMIN_IDS.includes(from)) {
    await reply(`Это служебный бот каталога. Ваш id: <code>${from}</code>. Чтобы управлять каталогом, добавьте его в ADMIN_IDS.`);
    return;
  }
  const text = (msg.text || msg.caption || '').trim();
  // пересланный пост из канала: «продано», «продано M», «в наличии», «в наличии M»
  const fwd = msg.forward_origin && msg.forward_origin.type === 'channel' ? msg.forward_origin : null;
  if (fwd && isOurChannel(fwd.chat)) {
    const id = fwd.message_id; const p = productOf(id);
    if (!p) { await reply(`Пост #${id} в каталоге не найден.`); return; }
    const low = text.toLowerCase();
    if (!text || /продан/.test(low)) { const sizes = parseSizes(text.replace(/продан[оа]?/i, '')); setSold(p.id, sizes); await reply(`#${p.id}: ${sizes.length ? 'размер ' + sizes.join(', ') + ' продан' : 'снят с витрины (продано)'}.`); }
    else if (/налич/.test(low)) { const sizes = parseSizes(text.replace(/в наличии/i, '')); setAvailable(p.id, sizes); await reply(`#${p.id}: ${sizes.length ? 'размер ' + sizes.join(', ') + ' снова в наличии' : 'снова на витрине'}.`); }
    else if (/^муж/.test(low)) { cur.gender = cur.gender || {}; cur.gender[p.id] = 'male'; changed = true; await reply(`#${p.id}: перенесён в «Мужское».`); }
    else if (/^фото\s*\d/.test(low)) { cur.mainImage = cur.mainImage || {}; cur.mainImage[p.id] = parseInt(low.replace(/\D/g, ''), 10) - 1; changed = true; await reply(`#${p.id}: главное фото — №${parseInt(low.replace(/\D/g, ''), 10)}.`); }
    else { cur.title = cur.title || {}; cur.title[p.id] = text; changed = true; await reply(`#${p.id}: название → «${text}».`); }
    return;
  }
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) { await reply('Перешлите пост из канала с подписью «продано», «продано M», «в наличии», «мужское», «фото 2» или новым названием. Команды: /help'); return; }
  const [, cmd, argRaw] = m; const arg = argRaw.trim();
  const idm = arg.match(/^(\d+)\s*(.*)$/s); const id = idm ? Number(idm[1]) : null; const rest = idm ? idm[2].trim() : '';
  switch (cmd) {
    case 'start': case 'help':
      await reply(['Команды каталога:', '/sold 8326 — продано полностью', '/sold 8326 M L — проданы размеры', '/unsold 8326 M — размер снова в наличии', '/hide 8326 и /show 8326 — скрыть/показать', '/title 8326 Новое название', '/men 8326 — в «Мужское»', '/photo 8326 2 — главное фото №2', '/status 8326 — что сейчас в каталоге', '', 'Или просто перешлите пост из канала с подписью «продано» / «продано M» / «в наличии».'].join('\n'));
      break;
    case 'sold': if (!id) return reply('Укажите номер поста: /sold 8326 [размеры]'); setSold(id, parseSizes(rest)); await reply(`#${id}: ${rest ? 'проданы размеры ' + parseSizes(rest).join(', ') : 'снят с витрины'}.`); break;
    case 'unsold': case 'show': if (!id) return reply('Укажите номер поста'); setAvailable(id, parseSizes(rest)); await reply(`#${id}: снова в наличии${rest ? ' (' + parseSizes(rest).join(', ') + ')' : ''}.`); break;
    case 'hide': if (!id) return reply('Укажите номер поста'); cur.hidden = [...new Set([...(cur.hidden || []), id])]; changed = true; await reply(`#${id}: скрыт.`); break;
    case 'title': if (!id || !rest) return reply('/title 8326 Новое название'); cur.title = cur.title || {}; cur.title[id] = rest; changed = true; await reply(`#${id}: название → «${rest}».`); break;
    case 'men': if (!id) return reply('Укажите номер поста'); cur.gender = cur.gender || {}; cur.gender[id] = 'male'; changed = true; await reply(`#${id}: в «Мужское».`); break;
    case 'women': if (!id) return reply('Укажите номер поста'); cur.gender = cur.gender || {}; delete cur.gender[id]; changed = true; await reply(`#${id}: в женском каталоге.`); break;
    case 'photo': if (!id || !rest) return reply('/photo 8326 2'); cur.mainImage = cur.mainImage || {}; cur.mainImage[id] = parseInt(rest, 10) - 1; changed = true; await reply(`#${id}: главное фото №${rest}.`); break;
    case 'status': {
      if (!id) return reply('Укажите номер поста');
      const p = productOf(id); if (!p) return reply(`#${id} не найден`);
      const it = parsePost(p); const sold = cur.sold && cur.sold[p.id];
      await reply(`#${p.id} ${it ? it.brand + ' — ' + it.title + ', ' + it.price + '₽' : 'не товар'}\nРазмеры: ${it ? it.sizes.join(', ') || '—' : ''}${it && it.soldSizes.length ? ' | проданы (зачёркнуты): ' + it.soldSizes.join(', ') : ''}${sold ? ' | команда: ' + (sold === 'all' ? 'продано' : sold.join(', ')) : ''}\nФото: ${(p.media || []).length}`);
      break;
    }
    default: await reply('Неизвестная команда. /help');
  }
}
 
// ---------- основной цикл
(async () => {
  let updates = [];
  const pull = offset => api('getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['channel_post', 'edited_channel_post', 'message'] });
  if (!BUILD_ONLY) try {
    try {
      updates = await pull(state.offset);
    } catch (e) {
      if (!/webhook is active/i.test(e.message)) throw e;
      // на боте включён webhook (остался от другого сервиса) — getUpdates с ним несовместим; снимаем и повторяем
      await api('deleteWebhook', { drop_pending_updates: false });
      log.push('снят webhook, который мешал getUpdates');
      updates = await pull(state.offset);
    }
    // забираем всё, что накопилось (по 100 за раз)
    while (updates.length === 100) {
      const more = await pull(updates[updates.length - 1].update_id + 1);
      if (!more.length) break; updates = updates.concat(more);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
 
  for (const u of updates) {
    try {
      if (u.channel_post && isOurChannel(u.channel_post.chat)) upsertFromMessage(u.channel_post, false);
      else if (u.edited_channel_post && isOurChannel(u.edited_channel_post.chat)) upsertFromMessage(u.edited_channel_post, true);
      else if (u.message && u.message.chat && u.message.chat.type === 'private') await handleAdminMessage(u.message);
    } catch (e) { log.push(`ошибка на update ${u.update_id}: ${e.message}`); }
    state.offset = u.update_id + 1;
  }
 
  if (!BUILD_ONLY) { await fetchMedia(); await checkDeleted(); }
 
  // пересборка витрины (всегда — чтобы ручные правки curation.json тоже применялись)
  const posts = Object.values(state.posts).sort((a, b) => a.id - b.id);
  const items = buildProducts(posts, cur, DOCS);
  const visible = buildSite(items, DOCS, path.join(ROOT, 'lib', 'index.template.html'));
  save(STATE_FILE, state); save(CURATION_FILE, cur);
  console.log(`updates: ${updates.length}, posts: ${posts.length}, products on site: ${visible.length}${log.length ? '\n' + log.join('\n') : ''}`);
})();
