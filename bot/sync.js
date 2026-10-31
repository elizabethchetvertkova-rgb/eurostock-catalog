#!/usr/bin/env node
// Синхронизация канала → каталог.
// Запускается по расписанию (GitHub Actions) или вручную: node bot/sync.js
// Переменные окружения: BOT_TOKEN (обязательно), ADMIN_IDS (id через запятую), CHANNEL (@username или id канала)

const fs = require('fs');
const path = require('path');
const { parsePost, struckFromEntities } = require('../lib/parser');
const { buildProducts, buildSite } = require('../lib/build');
const { composeDigest } = require('../lib/digest');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const CURATION_FILE = path.join(ROOT, 'curation.json');
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = (process.env.CHANNEL || '@eurostockmoscowshop').toLowerCase();
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number);
const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // лимит Bot API на скачивание
// адрес каталога для кнопок: curation.catalogUrl (команда /url), иначе адрес GitHub Pages этого репозитория
const defaultCatalogUrl = () => { const r = process.env.GITHUB_REPOSITORY; if (!r) return null; const [o, n] = r.split('/'); return `https://${o.toLowerCase()}.github.io/${n}/`; };

const BUILD_ONLY = process.argv.includes('--build');
if (!TOKEN && !BUILD_ONLY) { console.error('BOT_TOKEN не задан'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiWith = token => {
  const call = async (method, params = {}, attempt = 0) => {
    let j;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
      j = await r.json();
    } catch (e) { // сеть моргнула — пробуем ещё до 3 раз
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); return call(method, params, attempt + 1); }
      throw new Error(`${method}: ${e.message}`);
    }
    if (!j.ok) {
      // 409 Conflict: предыдущий запуск ещё держит getUpdates (например, ручной запуск сразу после планового) — подождать и повторить
      const retryable = j.error_code === 409 && !/webhook is active/i.test(j.description || '') || j.error_code === 429 || j.error_code >= 500;
      if (retryable && attempt < 4) { const wait = (j.parameters && j.parameters.retry_after ? j.parameters.retry_after * 1000 : 5000 * (attempt + 1)); await sleep(wait); return call(method, params, attempt + 1); }
      throw new Error(`${method}: ${j.description}`);
    }
    return j.result;
  };
  return call;
};
const api = apiWith(TOKEN);
// Отдельный бот для дайджеста в канале байер-сервиса (secret DIGEST_BOT_TOKEN). Если не задан — дайджестом занимается основной бот.
const DIGEST_TOKEN = process.env.DIGEST_BOT_TOKEN || '';
const dapi = DIGEST_TOKEN ? apiWith(DIGEST_TOKEN) : api;
const SEPARATE_DIGEST_BOT = !!DIGEST_TOKEN;
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
// Канал для ежедневного дайджеста (байер-сервис): задаётся командой /digest channel @eurostockmoscow
const digestCfg = () => (cur.digest = cur.digest || {});
const isDigestChannel = chat => { const c = (digestCfg().channel || '').toLowerCase(); return !!(c && chat && (String(chat.username || '').toLowerCase() === c.replace('@', '') || String(chat.id) === c)); };

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
    // Старый пост-альбом, загруженный из истории канала: бот его сообщений не видел, поэтому группа ему неизвестна.
    // Находим такой пост по номеру сообщения (альбом = подряд идущие номера начиная с id поста)
    // и только обновляем текст, не трогая список фото.
    if (!state.groups[msg.media_group_id]) {
      const h = Object.values(state.posts)
        .filter(x => x.id <= msg.message_id && msg.message_id - x.id < 10 && (x.source === 'web-import' || (x.media || []).length > msg.message_id - x.id) && (!x.group || x.group === msg.media_group_id))
        .sort((a, b) => b.id - a.id)[0]; // ближайший пост снизу по номеру
      if (h) state.groups[msg.media_group_id] = { ids: [h.id], historical: h.id, date: h.date };
    }
    const g0 = state.groups[msg.media_group_id];
    if (g0 && g0.historical) {
      const h = state.posts[g0.historical];
      if (h) {
        if (!g0.ids.includes(msg.message_id)) g0.ids.push(msg.message_id);
        h.group = msg.media_group_id;
        if (part.text) { h.text = part.text; h.struck = part.struck; h.caption_id = msg.message_id; }
        // видео из истории не загружалось — если правка пришла по сообщению с видео, добавим его
        for (const m of part.media) if (m.type === 'video' && !(h.media || []).some(x => x.msg_id === m.msg_id)) { h.media = h.media || []; h.media.push({ ...m, key: `${h.id}_${msg.message_id - h.id}` }); }
        changed = true;
        log.push(`${edited ? 'правка' : 'пост'} #${h.id}: ${(part.text || h.text || '').split('\n')[0].slice(0, 50)}`);
        return h.id;
      }
    }
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
  id = Number(id);
  let p = state.posts[id] || Object.values(state.posts).find(x => (x.media || []).some(m => m.msg_id === id) || x.caption_id === id);
  if (!p) { // сообщение из альбома исторического поста: номера идут подряд, альбом не длиннее 10 сообщений
    const cand = Object.values(state.posts).filter(x => x.id < id && id - x.id < 10 && (x.media || []).length >= id - x.id).sort((a, b) => b.id - a.id)[0];
    if (cand) p = cand;
  }
  return p || null;
}
const handledGroups = new Set();
// ---------- лента канала байер-сервиса для дайджеста
function upsertFeed(msg, edited) {
  state.feed = state.feed || { items: {}, groups: {} };
  const f = state.feed;
  const text = msg.caption || msg.text || '';
  const photo = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
  const video = msg.video ? msg.video.file_id : null;
  const chatName = msg.chat.username ? msg.chat.username : null;
  const url = chatName ? `https://t.me/${chatName}/${msg.message_id}` : null;
  let id = msg.message_id;
  if (msg.media_group_id) {
    if (f.groups[msg.media_group_id]) id = f.groups[msg.media_group_id]; else f.groups[msg.media_group_id] = id;
  } else if (!text && video && !edited) {
    // видеообзор без подписи, выложенный следом за постом товара — привязываем к этому посту
    const prev = Object.values(f.items).filter(x => x.id < msg.message_id && msg.message_id - x.id <= 12 && msg.date - x.date <= 15 * 60).sort((a, b) => b.id - a.id)[0];
    if (prev) { prev.videos = prev.videos || []; if (!prev.videos.includes(video)) prev.videos.push(video); changed = true; return; }
  }
  const it = f.items[id] || { id, url, date: msg.date, text: '', photos: [], videos: [], hashtagBrand: false };
  if (msg.message_id < it.id) { it.id = msg.message_id; it.url = url; }
  if (text && (!it.text || edited || msg.message_id <= (it.textId || Infinity))) { it.text = text; it.textId = msg.message_id; it.hashtagBrand = /#[A-Za-z]/.test(text); }
  if (photo && !it.photos.includes(photo)) it.photos.push(photo);
  it.videos = it.videos || []; if (video && !it.videos.includes(video)) it.videos.push(video);
  f.items[id] = it; changed = true;
  // старше 14 дней — убираем
  const cutoff = Date.now() / 1000 - 14 * 86400;
  for (const k of Object.keys(f.items)) if (f.items[k].date < cutoff) delete f.items[k];
  for (const k of Object.keys(f.groups)) if (!f.items[f.groups[k]]) delete f.groups[k];
}
const mskNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
const mskDateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Окно дайджеста — вчерашний календарный день по Москве (UTC+3, без перехода на летнее время):
// с конца прошлого выпуска (или с 00:00 вчера) до 00:00 сегодня. Посты, вышедшие сегодня до публикации, уйдут в завтрашний выпуск.
function digestWindow() {
  const cfg = digestCfg(); const m = mskNow();
  const todayStart = Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) / 1000 - 3 * 3600;
  let from = cfg.coveredUntil ? Date.parse(cfg.coveredUntil) / 1000 : todayStart - 86400;
  if (from < todayStart - 7 * 86400) from = todayStart - 7 * 86400; // после долгого простоя не вываливать неделю
  return { from, to: todayStart };
}
const fmtDay = sec => new Date(sec * 1000).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
function digestItemsSince(sinceSec, untilSec = Infinity) {
  const f = state.feed || { items: {} };
  return Object.values(f.items).filter(it => it.date >= sinceSec && it.date < untilSec && it.text).sort((a, b) => a.id - b.id);
}
function buildDigest(items) {
  const cfg = digestCfg();
  const h = mskNow().getHours();
  const greeting = cfg.greeting != null ? cfg.greeting : (h < 12 ? 'Доброе утро! ☕️' : h < 18 ? 'Добрый день! ✨' : 'Добрый вечер! 🌙') + ' Собрали для вас самое интересное за сутки:';
  return composeDigest(items, { greeting, footer: cfg.footer, bullet: cfg.bullet, maxMedia: cfg.photos != null ? cfg.photos : 4, includeVideo: !!cfg.video });
}
// Отправка дайджеста: альбом до 3 фото с подписью, если текст помещается в подпись (1024), иначе — текст с большой картинкой-превью
async function sendDigest(chatId, d) {
  if (d.media.length && d.visibleLength <= 1000) {
    const media = d.media.map((m, i) => i ? m : { ...m, caption: d.html, parse_mode: 'HTML' });
    if (media.length === 1) return dapi(media[0].type === 'video' ? 'sendVideo' : 'sendPhoto', { chat_id: chatId, [media[0].type]: media[0].media, caption: d.html, parse_mode: 'HTML' });
    return dapi('sendMediaGroup', { chat_id: chatId, media });
  }
  return dapi('sendMessage', { chat_id: chatId, text: d.html, parse_mode: 'HTML', link_preview_options: d.coverUrl ? { url: d.coverUrl, prefer_large_media: true, show_above_text: true } : { is_disabled: true } });
}
async function postDigest(force, reply) {
  const cfg = digestCfg();
  if (!cfg.channel) { if (reply) await reply('Сначала укажите канал: /digest channel @eurostockmoscow'); return false; }
  const w = digestWindow();
  const items = digestItemsSince(w.from, w.to);
  if (!items.length) { if (reply) await reply(`За ${fmtDay(w.to - 1)} бот не видел постов в ${cfg.channel} — публиковать нечего. Бот должен быть администратором канала и получать посты с момента добавления.`); return false; }
  const d = buildDigest(items);
  if (!d.brands) { if (reply) await reply('Посты есть, но ни в одном не распознан бренд или цена.'); return false; }
  await sendDigest(cfg.channel, d);
  cfg.lastAt = new Date().toISOString(); cfg.lastDate = mskDateKey(mskNow()); cfg.coveredUntil = new Date(w.to * 1000).toISOString(); changed = true;
  log.push(`дайджест: ${d.total} позиций, ${d.brands} брендов → ${cfg.channel}`);
  if (reply) await reply(`Опубликовано в ${cfg.channel}: ${d.total} позиций, ${d.brands} брендов.`);
  return true;
}
async function maybePostDigest() {
  const cfg = digestCfg();
  if (!cfg.enabled || !cfg.channel) return;
  const now = mskNow(); const today = mskDateKey(now);
  if (cfg.lastDate === today) return;
  const [hh, mm] = (cfg.time || '09:00').split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
  try {
    const ok = await postDigest(false, null);
    if (!ok) { cfg.lastDate = today; cfg.coveredUntil = new Date(digestWindow().to * 1000).toISOString(); changed = true; log.push('дайджест: нечего публиковать'); }
  } catch (e) {
    log.push('дайджест: ' + e.message);
    await notifyAdmins(`⚠️ Дайджест не опубликован: ${e.message}\nПроверьте, что ${SEPARATE_DIGEST_BOT ? 'бот дайджеста' : 'бот'} — администратор ${cfg.channel} с правом «Публикация сообщений».`, dapi);
    cfg.lastDate = today; changed = true; // не повторять каждые 10 минут; завтра попробует снова
  }
}

// ---------- удаление проданных постов из канала
// Альбом в Telegram — это несколько сообщений подряд; публичная страница поста перечисляет их все (ссылки «…/N?single»)
async function albumMessageIds(id) {
  id = Number(id);
  const ids = new Set([id]);
  const p = state.posts[id];
  if (p && p.group && state.groups[p.group]) for (const x of state.groups[p.group].ids || []) ids.add(Number(x));
  const name = CHANNEL.replace('@', '');
  if (/^[a-z0-9_]+$/i.test(name)) try {
    const r = await fetch(`https://t.me/${name}/${id}?embed=1&mode=tme`, { headers: { 'user-agent': 'Mozilla/5.0 (catalog-sync)' } });
    const html = await r.text();
    const re = new RegExp(`t\\.me/${name}/(\\d+)\\?single`, 'gi'); let m;
    while ((m = re.exec(html))) { const n = Number(m[1]); if (n >= id && n - id < 12) ids.add(n); }
  } catch (e) {}
  return [...ids].sort((a, b) => a - b);
}
async function deleteChannelPost(id) {
  id = Number(id);
  const ids = await albumMessageIds(id);
  let ok = 0, err = null;
  for (const mid of ids) {
    try { await api('deleteMessage', { chat_id: CHANNEL, message_id: mid }); ok++; }
    catch (e) { if (!/not found/i.test(e.message)) err = e.message.replace(/^deleteMessage: /, ''); }
  }
  if (ok) { if (state.posts[id]) state.posts[id].deleted = true; cur.hidden = [...new Set([...(cur.hidden || []).map(Number), id])]; changed = true; }
  return { ok, total: ids.length, err };
}
async function notifyAdmins(text, client = api) {
  for (const a of ADMIN_IDS) { try { await client('sendMessage', { chat_id: a, text }); } catch (e) { log.push('уведомление: ' + e.message); } }
}
const itemLabel = it => `#${it.id} ${it.brand ? it.brand + ' — ' : ''}${it.title}${it.price ? ', ' + it.price + '₽' : ''}`;
async function deleteAndReport(id, reply) {
  const r = await deleteChannelPost(id);
  state.soldHandled = state.soldHandled || {}; state.soldHandled[id] = r.ok ? 'deleted' : 'failed'; changed = true;
  if (r.ok) await reply(`🗑 Пост #${id} удалён из канала (${r.ok} из ${r.total} сообщ.) и снят с витрины.`);
  else await reply(`⚠️ Пост #${id} удалить не удалось: ${r.err || 'сообщения не найдены'}.\nПроверьте, что у бота есть право «Удаление сообщений» (канал → Администраторы → бот). Повторить: /delete ${id}`);
}
// Товар стал проданным (надпись «ПРОДАН», все размеры зачёркнуты или команда /sold) → снимаем с витрины
// и либо удаляем пост из канала сами (/autodelete on), либо спрашиваем администратора.
async function handleSoldPosts(items) {
  const soldNow = items.filter(it => it.status === 'sold' && state.posts[it.id] && !state.posts[it.id].deleted);
  if (!state.soldHandled) { // первый запуск после обновления: всё, что уже продано, не трогаем
    state.soldHandled = {}; for (const it of soldNow) state.soldHandled[it.id] = 'skip'; changed = true; return;
  }
  for (const it of soldNow) {
    if (state.soldHandled[it.id]) continue;
    if (cur.autoDelete) {
      const r = await deleteChannelPost(it.id);
      state.soldHandled[it.id] = r.ok ? 'deleted' : 'failed';
      await notifyAdmins(r.ok ? `🗑 ${itemLabel(it)}: продано — снят с витрины и удалён из канала (${r.ok} из ${r.total} сообщ.).`
        : `⚠️ ${itemLabel(it)}: продано и снят с витрины, но удалить пост из канала не удалось: ${r.err || 'сообщения не найдены'}.\nПроверьте право «Удаление сообщений» у бота. Повторить: /delete ${it.id}`);
    } else {
      state.soldHandled[it.id] = 'asked';
      await notifyAdmins(`${itemLabel(it)}: продано — снят с витрины.\nУдалить пост из канала? Ответьте: удалить ${it.id}\n(чтобы бот удалял проданное сам, без вопроса: /autodelete on)`);
    }
    changed = true;
  }
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
  if (state.soldHandled) delete state.soldHandled[id];
  changed = true;
}
const normSize = s => s.toUpperCase().replace(/М/g, 'M').replace(/Х/g, 'X').replace(/С/g, 'S').replace(/Л/g, 'L');
const parseSizes = str => str.split(/[\s,;/]+/).map(normSize).filter(s => /^(XS|S|M|L|XL|XXL|XXXL|\d{2}(,5)?)$/.test(s));

const draftMarkup = url => ({ inline_keyboard: [[{ text: cur.buttonText || '🛍 Открыть каталог', url }]] });
function sendDraft(chatId, draft) {
  return draft.photo
    ? api('sendPhoto', { chat_id: chatId, photo: draft.photo, caption: draft.text, reply_markup: draftMarkup(draft.url) })
    : api('sendMessage', { chat_id: chatId, text: draft.text, reply_markup: draftMarkup(draft.url), disable_web_page_preview: true });
}
async function publishDraft(draft, reply) {
  try {
    const sent = await sendDraft(CHANNEL, draft);
    await reply(`Опубликовано в канале (пост #${sent.message_id}). Чтобы пост был всегда сверху — закрепите его: долгое нажатие на пост → Закрепить.`);
    return true;
  } catch (e) { await reply(`Не удалось опубликовать: ${e.message}. Проверьте, что у бота есть право «Публикация сообщений» в канале.`); return false; }
}
// нажатие кнопок «Опубликовать / Отменить» под предпросмотром
async function handleCallback(q) {
  const from = q.from && q.from.id; const chatId = q.message && q.message.chat && q.message.chat.id; const mid = q.message && q.message.message_id;
  try { await api('answerCallbackQuery', { callback_query_id: q.id }); } catch (e) { /* запрос мог устареть — не страшно */ }
  if (!ADMIN_IDS.includes(from) || !chatId) return;
  const m = String(q.data || '').match(/^(pub|drop):(\w+)$/); if (!m) return;
  const draft = state.drafts && state.drafts[m[2]];
  const edit = text => api('editMessageText', { chat_id: chatId, message_id: mid, text }).catch(() => api('sendMessage', { chat_id: chatId, text }));
  if (!draft) { await edit('Этот черновик уже обработан или устарел. Отправьте /post заново.'); return; }
  if (m[1] === 'drop') { delete state.drafts[m[2]]; changed = true; await edit('❌ Отменено, пост не опубликован.'); return; }
  const ok = await publishDraft(draft, edit);
  if (ok) { delete state.drafts[m[2]]; changed = true; }
}
// текстовый вариант подтверждения на случай, если нажатие кнопки до бота не дошло
async function publishLatestDraft(chatId, reply, cancel) {
  const ids = Object.keys(state.drafts || {}).sort();
  if (!ids.length) return reply('Черновиков нет. Отправьте /post Текст.');
  const id = ids[ids.length - 1]; const draft = state.drafts[id];
  if (cancel) { delete state.drafts[id]; changed = true; return reply('❌ Черновик отменён.'); }
  const ok = await publishDraft(draft, reply);
  if (ok) { for (const k of ids) delete state.drafts[k]; changed = true; }
}

async function handleAdminMessage(msg) {
  const from = msg.from && msg.from.id;
  const reply = text => api('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML' });
  if (!ADMIN_IDS.includes(from)) {
    await reply(`Это служебный бот каталога. Ваш id: <code>${from}</code>. Чтобы управлять каталогом, добавьте его в ADMIN_IDS.`);
    return;
  }
  const text = (msg.text || msg.caption || '').trim();
  // пересланный пост из канала: «продано», «продано M», «в наличии», «в наличии M»
  // Пересланный пост из канала: сам пост приходит со своим исходным текстом (это не подпись админа),
  // поэтому запоминаем товар и ждём следующим сообщением, что с ним сделать.
  const fwd = msg.forward_origin && msg.forward_origin.type === 'channel' ? msg.forward_origin : null;
  if (fwd && isOurChannel(fwd.chat)) {
    const p = productOf(fwd.message_id);
    if (msg.media_group_id) { if (handledGroups.has(msg.media_group_id)) return; handledGroups.add(msg.media_group_id); }
    if (!p) { await reply(`Пост #${fwd.message_id} в каталоге не найден (возможно, это не товар или он уже скрыт).`); return; }
    state.lastForward = { chat: msg.chat.id, id: p.id, at: Date.now() }; changed = true;
    const it = parsePost(p);
    await reply(`Пост #${p.id}: ${it ? it.brand + ' — ' + it.title + ', ' + it.price + '₽' : ''}\nЧто сделать? Ответьте одним сообщением:\n• продано — снять с витрины\n• продано M L — проданы размеры\n• в наличии / в наличии M — вернуть\n• мужское — в раздел «Мужское»\n• фото 2 — сделать обложкой второе фото\n• удалить — удалить пост из канала\n• любой другой текст — новое название`);
    return;
  }
  // Ответ на недавно пересланный пост (в течение часа)
  const lf = state.lastForward;
  if (lf && lf.chat === msg.chat.id && Date.now() - lf.at < 60 * 60 * 1000 && text && !text.startsWith('/') && !/^(да|нет|опубликовать|публикуй|отмена|отменить)$/i.test(text)) {
    const p = productOf(lf.id); const low = text.toLowerCase();
    delete state.lastForward; changed = true;
    if (!p) { await reply(`Пост #${lf.id} больше не найден.`); return; }
    if (/продан/.test(low)) { const sizes = parseSizes(text.replace(/продан[оа]?/i, '')); setSold(p.id, sizes); await reply(`#${p.id}: ${sizes.length ? 'размер ' + sizes.join(', ') + ' продан' : 'снят с витрины (продано)'}.${sizes.length ? '' : `\nУдалить пост из канала? Ответьте: удалить ${p.id}`}`); if (!sizes.length) { state.soldHandled = state.soldHandled || {}; state.soldHandled[p.id] = 'asked'; } }
    else if (/налич/.test(low)) { const sizes = parseSizes(text.replace(/в наличии/i, '')); setAvailable(p.id, sizes); await reply(`#${p.id}: ${sizes.length ? 'размер ' + sizes.join(', ') + ' снова в наличии' : 'снова на витрине'}.`); }
    else if (/^муж/.test(low)) { cur.gender = cur.gender || {}; cur.gender[p.id] = 'male'; changed = true; await reply(`#${p.id}: перенесён в «Мужское».`); }
    else if (/^жен/.test(low)) { cur.gender = cur.gender || {}; delete cur.gender[p.id]; changed = true; await reply(`#${p.id}: в женском каталоге.`); }
    else if (/^фото\s*\d/.test(low)) { cur.mainImage = cur.mainImage || {}; cur.mainImage[p.id] = parseInt(low.replace(/\D/g, ''), 10) - 1; changed = true; await reply(`#${p.id}: главное фото — №${parseInt(low.replace(/\D/g, ''), 10)}.`); }
    else if (/^удал/.test(low)) { await deleteAndReport(p.id, reply); }
    else if (/^(скрыть|убрать)$/.test(low)) { cur.hidden = [...new Set([...(cur.hidden || []), p.id])]; changed = true; await reply(`#${p.id}: скрыт.`); }
    else { cur.title = cur.title || {}; cur.title[p.id] = text.slice(0, 80); changed = true; await reply(`#${p.id}: название → «${text.slice(0, 80)}».`); }
    return;
  }
  const dm = text.match(/^удал(?:ить|и)\s+#?(\d+)$/i);
  if (dm) { await deleteAndReport(Number(dm[1]), reply); return; }
  if (/^(да|опубликовать|публикуй)$/i.test(text)) { await publishLatestDraft(msg.chat.id, reply, false); return; }
  if (/^(нет|отмена|отменить)$/i.test(text)) { await publishLatestDraft(msg.chat.id, reply, true); return; }
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) { await reply('Перешлите пост из канала, а следующим сообщением — что сделать: «продано», «продано M», «в наличии», «мужское», «фото 2» или новое название. Команды: /help'); return; }
  const [, cmd, argRaw] = m; const arg = argRaw.trim();
  const idm = arg.match(/^(\d+)\s*(.*)$/s); const id = idm ? Number(idm[1]) : null; const rest = idm ? idm[2].trim() : '';
  switch (cmd) {
    case 'start': case 'help':
      await reply(['Команды каталога:', '/post Текст — показать предпросмотр поста с кнопкой «Открыть каталог», затем кнопка «Опубликовать» (можно с фото: отправьте фото с подписью /post Текст)', '/postnow Текст — опубликовать сразу, без предпросмотра', '/publish или «да» — опубликовать последний предпросмотр, /cancel или «нет» — отменить', '/url https://… — адрес каталога для кнопки', '/button Каталог — текст кнопки под постом', '/sold 8326 — продано полностью', '/sold 8326 M L — проданы размеры', '/unsold 8326 M — размер снова в наличии', '/hide 8326 и /show 8326 — скрыть/показать', '/delete 8326 — удалить пост из канала (и снять с витрины)', '/autodelete on|off — удалять проданные посты из канала автоматически', '/metrika 12345678 — подключить счётчик Яндекс Метрики (статистика нажатий)', '/journal АДРЕС — журнал заявок в Google-таблице', '/digest — ежедневный дайджест брендов для канала байер-сервиса (если задан отдельный бот — команда отправляется ему)', '/title 8326 Новое название', '/men 8326 — в «Мужское»', '/photo 8326 2 — главное фото №2', '/status 8326 — что сейчас в каталоге', '', 'Или перешлите пост из канала, а следующим сообщением напишите: продано / продано M / в наличии / мужское / фото 2 / удалить / новое название.'].join('\n'));
      break;
    case 'button': {
      if (!arg) return reply(`Сейчас текст кнопки: «${cur.buttonText || '🛍 Открыть каталог'}». Чтобы изменить: /button Каталог (можно с эмодзи: /button 🛍 Каталог)`);
      if (arg.length > 40) return reply('Слишком длинно, Telegram обрежет. До 40 символов.');
      cur.buttonText = arg; changed = true; await reply(`Текст кнопки для новых постов: «${arg}». Уже опубликованные посты не меняются — при необходимости опубликуйте заново через /post.`); break;
    }
    case 'publish': case 'yes': await publishLatestDraft(msg.chat.id, reply, false); break;
    case 'cancel': await publishLatestDraft(msg.chat.id, reply, true); break;
    case 'url': {
      if (!/^https:\/\//.test(arg)) return reply('Укажите адрес, начинающийся с https://');
      cur.catalogUrl = arg; changed = true; await reply(`Адрес каталога для кнопок: ${arg}`); break;
    }
    case 'post': case 'postnow': {
      const url = cur.catalogUrl || defaultCatalogUrl();
      if (!url) return reply('Сначала задайте адрес каталога: /url https://…');
      const draft = { text: arg || 'Все товары в наличии — в нашем каталоге 👇', photo: msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null, url };
      if (cmd === 'postnow') { await publishDraft(draft, reply); break; }
      // предпросмотр: бот присылает пост в точности как он будет выглядеть, и кнопки «Опубликовать / Отменить»
      state.drafts = state.drafts || {};
      const draftId = String(Date.now()).slice(-8);
      state.drafts[draftId] = draft; changed = true;
      await sendDraft(msg.chat.id, draft);
      await api('sendMessage', { chat_id: msg.chat.id, text: '☝️ Так будет выглядеть пост в канале. Опубликовать? Можно нажать кнопку или просто ответить «да» / «нет».', reply_markup: { inline_keyboard: [[{ text: '✅ Опубликовать в канал', callback_data: `pub:${draftId}` }, { text: '❌ Отменить', callback_data: `drop:${draftId}` }]] } });
      break;
    }
    case 'sold': if (!id) return reply('Укажите номер поста: /sold 8326 [размеры]'); setSold(id, parseSizes(rest)); if (!rest) { state.soldHandled = state.soldHandled || {}; state.soldHandled[id] = 'asked'; } await reply(`#${id}: ${rest ? 'проданы размеры ' + parseSizes(rest).join(', ') : `снят с витрины.\nУдалить пост из канала? Ответьте: удалить ${id}`}`); break;
    case 'unsold': case 'show': if (!id) return reply('Укажите номер поста'); setAvailable(id, parseSizes(rest)); await reply(`#${id}: снова в наличии${rest ? ' (' + parseSizes(rest).join(', ') + ')' : ''}.`); break;
    case 'digest': {
      if (SEPARATE_DIGEST_BOT) { let name = ''; try { name = '@' + (await digestBotUsername()); } catch (e) {} return reply(`Дайджестом занимается отдельный бот${name ? ' ' + name : ''} — напишите эту команду ему.`); }
      return digestCommand(arg, reply, msg.chat.id);
    }
    case 'journal': {
      if (!arg) return reply(cur.journalUrl ? `Журнал заявок подключён: ${cur.journalUrl}\nСменить: /journal АДРЕС, отключить: /journal off` : 'Журнал не подключён. Создайте Google-таблицу со скриптом (инструкция у вас есть) и пришлите адрес веб-приложения: /journal https://script.google.com/macros/s/…/exec');
      if (/^(off|выкл)$/i.test(arg)) { delete cur.journalUrl; changed = true; return reply('Журнал заявок отключён.'); }
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(arg)) return reply('Нужен адрес веб-приложения Apps Script — он выглядит так: https://script.google.com/macros/s/AKfy…/exec (копируется на шаге «Развернуть»).');
      try { const r = await fetch(arg, { redirect: 'follow' }); const txt = await r.text(); if (!/journal ok/i.test(txt)) return reply('По этому адресу отвечает не наш скрипт (ожидал «journal ok»). Проверьте, что при развёртывании выбрано «У кого есть доступ: Все» и адрес скопирован целиком.'); }
      catch (e) { return reply('Не удалось открыть адрес: ' + e.message); }
      cur.journalUrl = arg; changed = true; await reply('Журнал заявок подключён — заработает после ближайшей пересборки витрины (до 10 минут). Проверка: нажмите «На примерку» в каталоге, строка появится в таблице.'); break;
    }
    case 'metrika': {
      if (!arg) return reply(cur.metrikaId ? `Счётчик Яндекс Метрики: ${cur.metrikaId}. Сменить: /metrika НОМЕР, отключить: /metrika off` : 'Счётчик не задан. Создайте счётчик на metrika.yandex.ru и пришлите его номер: /metrika 12345678');
      if (/^(off|выкл)$/i.test(arg)) { delete cur.metrikaId; changed = true; return reply('Статистика отключена.'); }
      if (!/^\d{5,12}$/.test(arg)) return reply('Номер счётчика — это 8–9 цифр, например /metrika 12345678');
      cur.metrikaId = Number(arg); changed = true; await reply(`Счётчик ${arg} подключён — заработает после ближайшей пересборки витрины (до 10 минут). Цели в Метрике: book, buy, post, view, fav_book, fav_buy, about_book.`); break;
    }
    case 'delete': case 'del': if (!id) return reply('Укажите номер поста: /delete 8326 — удалить пост из канала и снять с витрины'); await deleteAndReport(id, reply); break;
    case 'autodelete': {
      if (/^(on|вкл|да)$/i.test(arg)) { cur.autoDelete = true; changed = true; return reply('Включено: как только товар становится проданным (надпись «ПРОДАН», все размеры зачёркнуты или /sold), бот снимает его с витрины и сам удаляет пост из канала. Выключить: /autodelete off'); }
      if (/^(off|выкл|нет)$/i.test(arg)) { cur.autoDelete = false; changed = true; return reply('Выключено: бот снимает проданное с витрины и спрашивает, удалять ли пост.'); }
      return reply(`Автоудаление проданных постов сейчас ${cur.autoDelete ? 'включено' : 'выключено'}. /autodelete on — включить, /autodelete off — выключить.`);
    }
    case 'hide': if (!id) return reply('Укажите номер поста'); cur.hidden = [...new Set([...(cur.hidden || []), id])]; changed = true; await reply(`#${id}: скрыт.`); break;
    case 'title': {
      if (!id) return reply('/title 8326 Новое название (без текста — вернуть название из поста)');
      cur.title = cur.title || {};
      if (!rest) { delete cur.title[id]; changed = true; const p = productOf(id); const it = p && parsePost(p); return reply(`#${id}: название из поста${it ? ' — «' + it.title + '»' : ''}.`); }
      cur.title[id] = rest; changed = true; await reply(`#${id}: название → «${rest}».`); break;
    }
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

async function digestCommand(arg, reply, chatId) {
      const cfg = digestCfg();
      const [sub, ...restArr] = arg.split(/\s+/); const val = restArr.join(' ').trim();
      const status = () => `Дайджест: ${cfg.enabled ? 'включён' : 'выключен'}\nКанал: ${cfg.channel || 'не задан'}\nВремя публикации: ${cfg.time || '09:00'} МСК, каждый день — подборка за вчерашний день\nПоследний выпуск: ${cfg.lastAt ? new Date(cfg.lastAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'ещё не было'}\nПостов за вчера: ${digestItemsSince(digestWindow().from, digestWindow().to).length}, сегодня: ${digestItemsSince(digestWindow().to).length}\n\nКоманды:\n/digest preview — показать мне, что получится\n/digest now — опубликовать сейчас\n/digest on | off — включить/выключить\n/digest time 09:00 — время публикации\n/digest photos 5 — сколько медиа в альбоме (0–10)\n/digest video on | off — добавлять ли видеообзоры\n/digest channel @eurostockmoscow — канал\n/digest greeting Текст — приветствие (или «-» чтобы убрать)\n/digest footer Текст — подпись внизу (или «-»)`;
      if (!sub) return reply(status());
      if (/^(on|вкл)$/i.test(sub)) { cfg.enabled = true; changed = true; return reply('Дайджест включён.\n' + status()); }
      if (/^(off|выкл)$/i.test(sub)) { cfg.enabled = false; changed = true; return reply('Дайджест выключен.'); }
      if (/^time$/i.test(sub)) { if (!/^\d{1,2}:\d{2}$/.test(val)) return reply('Формат: /digest time 09:00'); cfg.time = val.padStart(5, '0'); changed = true; return reply(`Время публикации: ${cfg.time} МСК.`); }
      if (/^channel$/i.test(sub)) { if (!/^@?[a-z0-9_]{5,}$/i.test(val) && !/^-?\d+$/.test(val)) return reply('Формат: /digest channel @eurostockmoscow'); cfg.channel = /^-?\d+$/.test(val) ? val : '@' + val.replace('@', '').toLowerCase(); changed = true; return reply(`Канал дайджеста: ${cfg.channel}. Добавьте ${SEPARATE_DIGEST_BOT ? 'бота дайджеста' : 'бота'} администратором этого канала с правом «Публикация сообщений» — с этого момента он начнёт собирать посты.`); }
      if (/^photos?$/i.test(sub)) { const n = parseInt(val, 10); if (!(n >= 0 && n <= 10)) return reply('Сколько медиа в альбоме дайджеста, от 0 до 10: /digest photos 5'); cfg.photos = n; changed = true; return reply(n ? `В альбоме дайджеста будет до ${n} медиа.` : 'Дайджест без фото — только текст с превью.'); }
      if (/^video$/i.test(sub)) { if (/^(on|вкл)$/i.test(val)) { cfg.video = true; changed = true; return reply('Видеообзоры будут попадать в альбом дайджеста вместе с фото.'); } if (/^(off|выкл)$/i.test(val)) { cfg.video = false; changed = true; return reply('В альбоме дайджеста только фото.'); } return reply(`Видео в альбоме: ${cfg.video ? 'да' : 'нет'}. /digest video on | off`); }
      if (/^greeting$/i.test(sub)) { cfg.greeting = val === '-' ? '' : (val || null); changed = true; return reply(val === '-' ? 'Приветствие убрано.' : val ? 'Приветствие: ' + val : 'Приветствие по умолчанию (зависит от времени суток).'); }
      if (/^footer$/i.test(sub)) { cfg.footer = val === '-' ? '' : (val || null); changed = true; return reply(val === '-' ? 'Подпись убрана.' : val ? 'Подпись: ' + val : 'Подпись по умолчанию.'); }
      if (/^preview$/i.test(sub)) {
        const w = digestWindow();
        const items = digestItemsSince(w.from, w.to);
        const todayItems = digestItemsSince(w.to);
        if (!items.length) return reply(`За ${fmtDay(w.to - 1)} постов для подборки нет${todayItems.length ? ` (сегодня уже ${todayItems.length} — они войдут в завтрашний выпуск)` : ''}. ${SEPARATE_DIGEST_BOT ? 'Бот дайджеста' : 'Бот'} собирает посты с момента, когда стал администратором ${cfg.channel || 'канала'}.`);
        const d = buildDigest(items);
        if (!d.brands) return reply('Посты есть, но ни в одном не распознан бренд или цена.');
        await sendDigest(chatId, d);
        return reply(`☝️ Так будет выглядеть дайджест за ${fmtDay(w.to - 1)} (${d.total} позиций, ${d.brands} брендов). Опубликовать сейчас: /digest now`);
      }
      if (/^now$/i.test(sub)) { await postDigest(true, reply); return; }
      return reply(status());
}

async function digestBotUsername() {
  if (state.digestBotUsername) return state.digestBotUsername;
  const me = await dapi('getMe'); state.digestBotUsername = me.username; changed = true; return me.username;
}
// Личные сообщения боту дайджеста: те же команды /digest …, плюс /start и /help
async function handleDigestBotMessage(msg) {
  const from = msg.from && msg.from.id;
  const text = (msg.text || '').trim();
  const reply = t => dapi('sendMessage', { chat_id: msg.chat.id, text: t, parse_mode: 'HTML' });
  if (!ADMIN_IDS.includes(from)) { await reply(`Это служебный бот дайджеста EUROSTOCK. Ваш id: ${from}`); return; }
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) { await reply('Команды: /digest — настройки, /digest preview — показать выпуск, /digest now — опубликовать, /digest on|off, /digest time 09:00, /digest photos 5, /digest video on|off, /digest greeting …, /digest footer …, /digest channel @канал'); return; }
  const [, cmd, argRaw] = m; const arg = argRaw.trim();
  if (cmd === 'digest') return digestCommand(arg, reply, msg.chat.id);
  if (cmd === 'start' || cmd === 'help') return digestCommand('', reply, msg.chat.id);
  await reply('Этот бот умеет только /digest … (все подкоманды — в ответ на /digest).');
}
// Приём обновлений бота дайджеста: посты канала байер-сервиса и команды администратора
async function pollDigestBot() {
  if (!SEPARATE_DIGEST_BOT) return;
  const pull = offset => dapi('getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['channel_post', 'edited_channel_post', 'message'] });
  let updates = [];
  try {
    try { updates = await pull(state.digestOffset || 0); }
    catch (e) { if (!/webhook is active/i.test(e.message)) throw e; await dapi('deleteWebhook', { drop_pending_updates: false }); updates = await pull(state.digestOffset || 0); }
    while (updates.length === 100) { const more = await pull(updates[updates.length - 1].update_id + 1); if (!more.length) break; updates = updates.concat(more); }
  } catch (e) { log.push(`бот дайджеста недоступен: ${e.message}`); return; }
  for (const u of updates) {
    try {
      if (u.channel_post && isDigestChannel(u.channel_post.chat)) upsertFeed(u.channel_post, false);
      else if (u.edited_channel_post && isDigestChannel(u.edited_channel_post.chat)) upsertFeed(u.edited_channel_post, true);
      else if (u.message && u.message.chat && u.message.chat.type === 'private') await handleDigestBotMessage(u.message);
    } catch (e) { log.push(`бот дайджеста, update ${u.update_id}: ${e.message}`); }
    state.digestOffset = u.update_id + 1; changed = true;
  }
  if (!state.digestCommandsSet) { try { await dapi('setMyCommands', { commands: [{ command: 'digest', description: 'Настройки дайджеста' }] }); state.digestCommandsSet = true; changed = true; } catch (e) {} }
  if (updates.length) log.push(`бот дайджеста: ${updates.length} обновл.`);
}

// ---------- основной цикл
(async () => {
  let updates = [];
  const pull = offset => api('getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['channel_post', 'edited_channel_post', 'message', 'callback_query'] });
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
  } catch (e) {
    // Telegram недоступен даже после повторов (сетевой сбой на стороне GitHub) — не роняем запуск,
    // просто пропускаем приём обновлений: offset не сдвигается, всё заберём в следующий раз
    console.error(`Telegram недоступен, пропускаем приём обновлений: ${e.message}`);
    log.push(`Telegram недоступен: ${e.message}`);
    updates = [];
  }

  for (const u of updates) {
    try {
      if (u.channel_post && isOurChannel(u.channel_post.chat)) upsertFromMessage(u.channel_post, false);
      else if (u.edited_channel_post && isOurChannel(u.edited_channel_post.chat)) upsertFromMessage(u.edited_channel_post, true);
      else if (!SEPARATE_DIGEST_BOT && u.channel_post && isDigestChannel(u.channel_post.chat)) upsertFeed(u.channel_post, false);
      else if (!SEPARATE_DIGEST_BOT && u.edited_channel_post && isDigestChannel(u.edited_channel_post.chat)) upsertFeed(u.edited_channel_post, true);
      else if (u.message && u.message.chat && u.message.chat.type === 'private') await handleAdminMessage(u.message);
      else if (u.callback_query) await handleCallback(u.callback_query);
    } catch (e) {
      log.push(`ошибка на update ${u.update_id}: ${e.message}`);
      const chatId = (u.message && u.message.chat && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat.id);
      if (chatId && ADMIN_IDS.includes((u.message && u.message.from && u.message.from.id) || (u.callback_query && u.callback_query.from.id))) { try { await api('sendMessage', { chat_id: chatId, text: `⚠️ Не получилось обработать: ${e.message}` }); } catch (e2) {} }
    }
    state.offset = u.update_id + 1;
  }

  if (!BUILD_ONLY) {
    await fetchMedia(); await checkDeleted();
    await pollDigestBot();
    await maybePostDigest();
    if (state.commandsSet !== 5) { try { await api('setMyCommands', { commands: [
      { command: 'post', description: 'Пост в канал с кнопкой «Открыть каталог» (с предпросмотром)' },
      { command: 'sold', description: 'Продано: /sold 8326 или /sold 8326 M' },
      { command: 'unsold', description: 'Снова в наличии: /unsold 8326 M' },
      { command: 'hide', description: 'Скрыть товар: /hide 8326' },
      { command: 'show', description: 'Вернуть товар: /show 8326' },
      { command: 'delete', description: 'Удалить пост из канала: /delete 8326' },
      { command: 'autodelete', description: 'Удалять проданное из канала автоматически: on / off' },
      { command: 'metrika', description: 'Счётчик Яндекс Метрики: /metrika 12345678' },
      { command: 'journal', description: 'Журнал заявок в Google-таблице: /journal АДРЕС' },
      { command: 'digest', description: 'Ежедневный дайджест: /digest preview, now, on/off, time' },
      { command: 'title', description: 'Название: /title 8326 Жакет из замши' },
      { command: 'men', description: 'В раздел «Мужское»: /men 8326' },
      { command: 'photo', description: 'Главное фото: /photo 8326 2' },
      { command: 'status', description: 'Что в каталоге по посту: /status 8326' },
      { command: 'url', description: 'Адрес каталога для кнопки' },
      { command: 'button', description: 'Текст кнопки под постом: /button Каталог' },
      { command: 'help', description: 'Все команды' },
    ] }); state.commandsSet = 5; changed = true; } catch (e) { log.push('setMyCommands: ' + e.message); } }
  }

  // пересборка витрины (всегда — чтобы ручные правки curation.json тоже применялись)
  const posts = Object.values(state.posts).sort((a, b) => a.id - b.id);
  const items = buildProducts(posts, cur, DOCS);
  if (!BUILD_ONLY) { try { await handleSoldPosts(items); } catch (e) { log.push('проданные: ' + e.message); } }
  const visible = buildSite(items, DOCS, path.join(ROOT, 'lib', 'index.template.html'), { metrikaId: cur.metrikaId, journalUrl: cur.journalUrl });
  save(STATE_FILE, state); save(CURATION_FILE, cur);
  console.log(`updates: ${updates.length}, posts: ${posts.length}, products on site: ${visible.length}${log.length ? '\n' + log.join('\n') : ''}`);
})();
