import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Railway volume mounts at /data; fall back to ./data for local development.
const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cozytally.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id         TEXT PRIMARY KEY,
    room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '',
    config     TEXT NOT NULL DEFAULT '{}',
    state      TEXT NOT NULL DEFAULT '{}',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_room ON cards(room_code, sort);
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    room_code  TEXT NOT NULL,
    cid        TEXT,
    author     TEXT NOT NULL,
    avatar     TEXT,
    text       TEXT NOT NULL DEFAULT '',
    photo      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msgs_room ON messages(room_code, created_at);
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    room_code  TEXT NOT NULL,
    cid        TEXT,
    keys       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subs_room ON push_subs(room_code);
  CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    pass       TEXT NOT NULL,
    name       TEXT NOT NULL,
    avatar     TEXT NOT NULL DEFAULT '🐻',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_rooms (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_code)
  );
`);

// Notification language, added after the table shipped.
if (!db.prepare('PRAGMA table_info(push_subs)').all().some((c) => c.name === 'lang')) {
  db.exec("ALTER TABLE push_subs ADD COLUMN lang TEXT NOT NULL DEFAULT 'tr'");
}

/* ------------------------------------------------------------------
   Encryption at rest.

   Set CT_SECRET in the environment and everything people write — room
   names, card titles and contents, chat messages, uploaded photos — is
   stored as AES-256-GCM ciphertext instead of readable text. The key
   lives only in the environment, never on the volume, so a copy of the
   database or a leaked backup is useless on its own.

   It does NOT hide anything from someone who can read the environment
   as well as the disk, or run code on the server: the app must be able
   to decrypt to work at all. For that, content has to be encrypted in
   the browser instead.

   With no CT_SECRET set, everything behaves exactly as before, and rows
   written before a key was configured stay readable either way.
   ------------------------------------------------------------------ */
const CT_SECRET = process.env.CT_SECRET || '';
const CRYPT_KEY = CT_SECRET ? crypto.createHash('sha256').update(CT_SECRET).digest() : null;
const ENC_PREFIX = 'ct1:';
const FILE_MAGIC = Buffer.from('CTENC1\0\0');

function enc(value) {
  if (!CRYPT_KEY || typeof value !== 'string' || value === '') return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CRYPT_KEY, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function dec(value, fallback = '') {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value; // pre-key rows
  if (!CRYPT_KEY) return fallback;
  try {
    const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CRYPT_KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return fallback;
  }
}

function encFile(buf) {
  if (!CRYPT_KEY) return buf;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CRYPT_KEY, iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), body]);
}

function decFile(buf) {
  if (buf.length < FILE_MAGIC.length || !buf.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) return buf;
  if (!CRYPT_KEY) return null;
  try {
    const iv = buf.subarray(8, 20);
    const tag = buf.subarray(20, 36);
    const decipher = crypto.createDecipheriv('aes-256-gcm', CRYPT_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(36)), decipher.final()]);
  } catch {
    return null;
  }
}

const nf = (lang, v) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'tr-TR').format(v);

/** Notification copy. Kept tiny and mirrored per language. */
const PUSH_STR = {
  tr: {
    moneyIn: (n, c, amt, total, cur) =>
      `${n} kumbaraya +${nf('tr', amt)}${cur} attı 💰 · ${c}: ${nf('tr', total)}${cur}`,
    moneyOut: (n, c, amt, total, cur) =>
      `${n} kumbaradan −${nf('tr', amt)}${cur} çıkardı 🍃 · ${c}: ${nf('tr', total)}${cur}`,
    moneyGoal: (c, total, cur) => `Hedefe ulaştınız! ${c} · ${nf('tr', total)}${cur} 🎉💰`,
    cardAdd: (n, c) => `${n} yeni kart ekledi: ${c}`,
    cardDelete: (n, c) => `${n} bir kartı sildi: ${c} 🗑️`,
    tally: (n, c, v) => `${n}: ${c} → ${v} ✨`,
    money: (n, c, v) => `${n} 💰 ${v} · ${c}`,
    note: (n, t) => `${n} 💌 ${t}`,
    chat: (n, t) => `${n}: ${t}`,
    cheer: (n) => `${n} 💖✨`,
    timerStart: (n, c) => `${n} başlattı: ${c} ⏳`,
    timerPause: (n, c) => `${n} durdurdu: ${c} 🌙`,
    streakReset: (n, c) => `${n}: ${c} sıfırlandı 🌧️`,
    listAdd: (n, c, t) => `${n}: ${c} 📝 ${t}`,
    listTick: (n, c, d, tot) => `${n}: ${c} ${d}/${tot} ✅`,
    listDone: (c) => `${c} tamamlandı! 🎉`,
    checkinTick: (n, c) => `${n} ✅ ${c}`,
    checkinDone: (c, s) => `Gün tamam! ${c} · ${s} gün 🔥`,
    cover: (n, c) => `${n} bugünü senin için örttü 🧣 · ${c}`,
  },
  en: {
    moneyIn: (n, c, amt, total, cur) =>
      `${n} put +${nf('en', amt)}${cur} in 💰 · ${c}: ${nf('en', total)}${cur}`,
    moneyOut: (n, c, amt, total, cur) =>
      `${n} took −${nf('en', amt)}${cur} out 🍃 · ${c}: ${nf('en', total)}${cur}`,
    moneyGoal: (c, total, cur) => `Goal reached! ${c} · ${nf('en', total)}${cur} 🎉💰`,
    cardAdd: (n, c) => `${n} added a card: ${c}`,
    cardDelete: (n, c) => `${n} deleted a card: ${c} 🗑️`,
    tally: (n, c, v) => `${n}: ${c} → ${v} ✨`,
    money: (n, c, v) => `${n} 💰 ${v} · ${c}`,
    note: (n, t) => `${n} 💌 ${t}`,
    chat: (n, t) => `${n}: ${t}`,
    cheer: (n) => `${n} 💖✨`,
    timerStart: (n, c) => `${n} started: ${c} ⏳`,
    timerPause: (n, c) => `${n} paused: ${c} 🌙`,
    streakReset: (n, c) => `${n}: ${c} was reset 🌧️`,
    listAdd: (n, c, t) => `${n}: ${c} 📝 ${t}`,
    listTick: (n, c, d, tot) => `${n}: ${c} ${d}/${tot} ✅`,
    listDone: (c) => `${c} is done! 🎉`,
    checkinTick: (n, c) => `${n} ✅ ${c}`,
    checkinDone: (c, s) => `Day complete! ${c} · ${s} days 🔥`,
    cover: (n, c) => `${n} covered today for you 🧣 · ${c}`,
  },
};

// Web Push (VAPID) keys live on the data volume so they survive deploys.
const vapidPath = path.join(DATA_DIR, 'vapid.json');
let vapid = null;
try {
  vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} catch {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapid));
}
webpush.setVapidDetails('mailto:hello@cozytally.app', vapid.publicKey, vapid.privateKey);

// Uploaded chat photos also live on the volume.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const q = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE code = ?'),
  createRoom: db.prepare('INSERT INTO rooms (code, name, created_at, last_active) VALUES (?, ?, ?, ?)'),
  renameRoom: db.prepare('UPDATE rooms SET name = ?, last_active = ? WHERE code = ?'),
  touchRoom: db.prepare('UPDATE rooms SET last_active = ? WHERE code = ?'),
  roomCards: db.prepare('SELECT * FROM cards WHERE room_code = ? ORDER BY sort, created_at'),
  cardCount: db.prepare('SELECT COUNT(*) AS n FROM cards WHERE room_code = ?'),
  getCard: db.prepare('SELECT * FROM cards WHERE id = ? AND room_code = ?'),
  insertCard: db.prepare(
    'INSERT INTO cards (id, room_code, type, title, emoji, config, state, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  updateCardMeta: db.prepare('UPDATE cards SET title = ?, emoji = ?, config = ? WHERE id = ?'),
  updateCardState: db.prepare('UPDATE cards SET state = ? WHERE id = ?'),
  deleteCard: db.prepare('DELETE FROM cards WHERE id = ?'),
  maxSort: db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM cards WHERE room_code = ?'),
  insertMsg: db.prepare(
    'INSERT INTO messages (id, room_code, cid, author, avatar, text, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  recentMsgs: db.prepare('SELECT * FROM messages WHERE room_code = ? ORDER BY created_at DESC LIMIT ?'),
  oldMsgs: db.prepare(
    'SELECT id, photo FROM messages WHERE room_code = ? AND id NOT IN (SELECT id FROM messages WHERE room_code = ? ORDER BY created_at DESC LIMIT 500)'
  ),
  delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
  subsByRoom: db.prepare('SELECT * FROM push_subs WHERE room_code = ?'),
  upsertSub: db.prepare(
    `INSERT INTO push_subs (endpoint, room_code, cid, keys, lang, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET room_code = excluded.room_code, cid = excluded.cid,
       keys = excluded.keys, lang = excluded.lang`
  ),
  delSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),

  createUser: db.prepare(
    'INSERT INTO users (id, username, pass, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  updateUser: db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?'),
  createSession: db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'
  ),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  linkRoom: db.prepare(
    'INSERT INTO user_rooms (user_id, room_code, joined_at) VALUES (?, ?, ?) ON CONFLICT(user_id, room_code) DO UPDATE SET joined_at = excluded.joined_at'
  ),
  unlinkRoom: db.prepare('DELETE FROM user_rooms WHERE user_id = ? AND room_code = ?'),
  userRooms: db.prepare(
    `SELECT r.code, r.name, ur.joined_at FROM user_rooms ur
     JOIN rooms r ON r.code = ur.room_code
     WHERE ur.user_id = ? ORDER BY ur.joined_at DESC LIMIT 50`
  ),
};

// ---------------------------------------------------------------- auth
const SESSION_TTL = 400 * 24 * 60 * 60 * 1000; // ~13 months

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return candidate.length === known.length && crypto.timingSafeEqual(candidate, known);
}

function userFromToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const session = q.sessionByToken.get(token);
  if (!session) return null;
  const now = Date.now();
  if (now - session.created_at > SESSION_TTL) {
    q.delSession.run(token);
    return null;
  }
  if (now - session.last_seen > 60_000) q.touchSession.run(now, token);
  return q.userById.get(session.user_id) || null;
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar });

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* Every read below hands back plaintext and every write takes plaintext,
   so the rest of the server never has to think about encryption. */
const readRoom = (row) => (row ? { ...row, name: dec(row.name, '???') } : row);
const readCardRow = (row) =>
  row ? { ...row, title: dec(row.title, '???'), config: dec(row.config, '{}'), state: dec(row.state, '{}') } : row;
const readMsgRow = (row) => ({ ...row, author: dec(row.author, '???'), text: dec(row.text) });

const store = {
  getRoom: (code) => readRoom(q.getRoom.get(code)),
  roomExists: (code) => !!q.getRoom.get(code),
  createRoom: (code, name, a, b) => q.createRoom.run(code, enc(name), a, b),
  renameRoom: (name, at, code) => q.renameRoom.run(enc(name), at, code),

  getCard: (id, code) => readCardRow(q.getCard.get(id, code)),
  roomCards: (code) => q.roomCards.all(code).map(readCardRow),
  insertCard: (id, code, type, title, emoji, config, state, sort, at) =>
    q.insertCard.run(id, code, type, enc(title), emoji, enc(config), enc(state), sort, at),
  updateCardMeta: (title, emoji, config, id) => q.updateCardMeta.run(enc(title), emoji, enc(config), id),
  updateCardState: (state, id) => q.updateCardState.run(enc(state), id),

  insertMsg: (m, code) =>
    q.insertMsg.run(m.id, code, m.cid, enc(m.author), m.avatar, enc(m.text), m.photo, m.createdAt),
  recentMsgs: (code, n) => q.recentMsgs.all(code, n).map(readMsgRow),

  userRooms: (userId) => q.userRooms.all(userId).map((r) => ({ ...r, name: dec(r.name, '???') })),
};

// ---------------------------------------------------------------- room codes
const CODE_WORDS = [
  'luna', 'mocha', 'panda', 'koala', 'boba', 'nova', 'suki', 'momo',
  'kiwi', 'lila', 'pufu', 'toffee', 'yuki', 'coco', 'mini', 'dodo',
  'tofu', 'peri', 'mango', 'lolo', 'nana', 'pipo', 'zuzu', 'fifi',
];

function newRoomCode() {
  for (let i = 0; i < 50; i++) {
    const a = CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
    let b = CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
    while (b === a) b = CODE_WORDS[crypto.randomInt(CODE_WORDS.length)];
    const code = `${a}-${b}-${crypto.randomInt(10, 100)}`;
    if (!store.getRoom(code)) return code;
  }
  return crypto.randomUUID().slice(0, 8);
}

const CARD_TYPES = new Set(['tally', 'streak', 'timer', 'countdown', 'note', 'money', 'list', 'checkin']);
const MAX_LIST_ITEMS = 60;
const KEEP_DAYS = 90;
const COVER_TOKENS_PER_MONTH = 2;

const dayKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** Members send their own local day; accept anything within a day of UTC so
 *  timezones work without forcing a single clock on the room. */
function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) return null;
  const now = Date.now();
  for (let offset = -2; offset <= 2; offset++) {
    if (dayKey(new Date(now + offset * 86400000)) === day) return day;
  }
  return null;
}

function dayIsComplete(state, mode, day) {
  const rec = state.days?.[day];
  if (!rec) return false;
  const people = Object.keys(state.people || {});
  if (!people.length) return false;
  if (mode === 'any') return Object.keys(rec).length > 0;
  return people.every((k) => rec[k]);
}

function computeStreak(state, mode) {
  let n = 0;
  const now = Date.now();
  for (let i = 0; i < 400; i++) {
    const day = dayKey(new Date(now - i * 86400000));
    if (dayIsComplete(state, mode, day)) n++;
    else if (i === 0) continue; // today may still be in progress
    else break;
  }
  return n;
}
const MAX_CARDS_PER_ROOM = 60;

const clampStr = (v, max) => String(v ?? '').trim().slice(0, max);
const toInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

function sanitizeConfig(type, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (type === 'tally') out.goal = toInt(src.goal, 0, 100000, 0);
  if (type === 'countdown') out.targetAt = toInt(src.targetAt, 0, 4102444800000, 0);
  if (type === 'checkin') out.mode = src.mode === 'any' ? 'any' : 'all';
  if (type === 'money') {
    out.goal = toInt(src.goal, 0, 1000000000, 0);
    out.cur = clampStr(src.cur, 4) || '₺';
    if (typeof src.photo === 'string' && /^\/u\/[\w-]+\.(jpg|png|webp|gif)$/.test(src.photo))
      out.photo = src.photo;
  }
  return out;
}

function defaultState(type, now) {
  if (type === 'tally') return { count: 0 };
  if (type === 'streak') return { startAt: now, best: 0 };
  if (type === 'timer') return { running: false, startedAt: 0, accumulated: 0 };
  if (type === 'note') return { text: '', author: '', updatedAt: 0 };
  if (type === 'money') return { total: 0, log: [], by: {} };
  if (type === 'list') return { items: [] };
  if (type === 'checkin')
    return { people: {}, days: {}, best: 0, tokens: COVER_TOKENS_PER_MONTH, tokenMonth: '', covers: [] };
  return {};
}

function rowToCard(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    emoji: row.emoji,
    config: JSON.parse(row.config),
    state: JSON.parse(row.state),
    sort: row.sort,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------- http
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Light rate limit on room creation, per IP.
const createBuckets = new Map();
function allowCreate(ip) {
  const now = Date.now();
  let b = createBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 10 * 60 * 1000 };
    createBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= 20;
}

app.post('/api/rooms', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!allowCreate(ip)) return res.status(429).json({ error: 'rate-limited' });
  const name = clampStr(req.body?.name, 40) || 'CozyTally';
  const code = newRoomCode();
  const now = Date.now();
  store.createRoom(code, name, now, now);
  res.json({ code, name });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.getRoom(clampStr(req.params.code, 40).toLowerCase());
  if (!room) return res.status(404).json({ error: 'not-found' });
  res.json({ code: room.code, name: room.name });
});

app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------ auth api
const authBuckets = new Map();
function allowAuth(ip) {
  const now = Date.now();
  let b = authBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 15 * 60 * 1000 };
    authBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= 30;
}

const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';

app.post('/api/auth/register', (req, res) => {
  if (!allowAuth(clientIp(req))) return res.status(429).json({ error: 'rate-limited' });
  const username = clampStr(req.body?.username, 24).toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) return res.status(400).json({ error: 'bad-username' });
  if (password.length < 6) return res.status(400).json({ error: 'short-password' });
  if (q.userByName.get(username)) return res.status(409).json({ error: 'username-taken' });

  const now = Date.now();
  const user = {
    id: crypto.randomUUID(),
    username,
    name: clampStr(req.body?.name, 24) || username,
    avatar: clampStr(req.body?.avatar, 8) || '🐻',
  };
  q.createUser.run(user.id, username, hashPassword(password), user.name, user.avatar, now);
  const token = crypto.randomBytes(32).toString('hex');
  q.createSession.run(token, user.id, now, now);
  res.json({ token, user, rooms: [] });
});

app.post('/api/auth/login', (req, res) => {
  if (!allowAuth(clientIp(req))) return res.status(429).json({ error: 'rate-limited' });
  const username = clampStr(req.body?.username, 24).toLowerCase();
  const row = q.userByName.get(username);
  if (!row || !verifyPassword(String(req.body?.password ?? ''), row.pass))
    return res.status(401).json({ error: 'bad-credentials' });
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  q.createSession.run(token, row.id, now, now);
  res.json({ token, user: publicUser(row), rooms: store.userRooms(row.id) });
});

app.post('/api/auth/logout', (req, res) => {
  q.delSession.run(bearer(req));
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = userFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: publicUser(user), rooms: store.userRooms(user.id) });
});

app.post('/api/auth/profile', (req, res) => {
  const user = userFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const name = clampStr(req.body?.name, 24) || user.name;
  const avatar = clampStr(req.body?.avatar, 8) || user.avatar;
  q.updateUser.run(name, avatar, user.id);
  res.json({ user: { ...publicUser(user), name, avatar } });
});

app.post('/api/auth/forget-room', (req, res) => {
  const user = userFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  q.unlinkRoom.run(user.id, clampStr(req.body?.code, 40).toLowerCase());
  res.json({ rooms: store.userRooms(user.id) });
});

// ------------------------------------------------------------ push api
app.get('/api/push/key', (_req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/push/subscribe', (req, res) => {
  const { room, cid, sub } = req.body || {};
  const code = clampStr(room, 40).toLowerCase();
  if (!store.roomExists(code)) return res.status(404).json({ error: 'not-found' });
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || sub.endpoint.length > 1024)
    return res.status(400).json({ error: 'bad-subscription' });
  const lang = req.body?.lang === 'en' ? 'en' : 'tr';
  q.upsertSub.run(sub.endpoint, code, clampStr(cid, 64), JSON.stringify(sub.keys), lang, Date.now());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === 'string') q.delSub.run(endpoint);
  res.json({ ok: true });
});

/** room|key -> last send, so repeated taps don't machine-gun anyone's phone */
const pushThrottle = new Map();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, ts] of pushThrottle) if (ts < cutoff) pushThrottle.delete(k);
}, 10 * 60 * 1000).unref?.();

/**
 * Notify everyone subscribed to a room except the person who acted and
 * anyone currently looking at it. A connected-but-hidden tab still counts
 * as away — otherwise a backgrounded phone would go silent.
 */
function pushToRoom(code, strKey, args, exceptCid, { key, windowMs = 0 } = {}) {
  const room = store.getRoom(code);
  if (!room) return;

  if (key && windowMs) {
    const throttleKey = `${code}|${key}`;
    const last = pushThrottle.get(throttleKey) || 0;
    if (Date.now() - last < windowMs) return;
    pushThrottle.set(throttleKey, Date.now());
  }

  const watching = new Set(
    [...(roomSockets.get(code) || [])]
      .filter((s) => s.meta?.joined && !s.meta.hidden)
      .map((s) => s.meta.cid)
      .filter(Boolean)
  );

  for (const row of q.subsByRoom.all(code)) {
    if (row.cid && (row.cid === exceptCid || watching.has(row.cid))) continue;
    const write = (PUSH_STR[row.lang] || PUSH_STR.tr)[strKey] || PUSH_STR.tr[strKey];
    if (!write) continue;
    const payload = JSON.stringify({
      title: room.name,
      body: write(...args),
      tag: 'ct-' + code,
      url: '/r/' + encodeURIComponent(code),
    });
    const sub = { endpoint: row.endpoint, keys: JSON.parse(row.keys) };
    webpush.sendNotification(sub, payload, { TTL: 3600 }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) q.delSub.run(row.endpoint);
    });
  }
}

// ------------------------------------------------------------ photo uploads
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const uploadBuckets = new Map();
function allowUpload(ip) {
  const now = Date.now();
  let b = uploadBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 10 * 60 * 1000 };
    uploadBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= 60;
}

app.post(
  '/api/upload/:code',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '6mb' }),
  (req, res) => {
    const code = clampStr(req.params.code, 40).toLowerCase();
    if (!store.roomExists(code)) return res.status(404).json({ error: 'not-found' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
    if (!allowUpload(ip)) return res.status(429).json({ error: 'rate-limited' });
    const ext = EXT_BY_MIME[req.headers['content-type']];
    if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'bad-image' });
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), encFile(req.body));
    res.json({ url: '/u/' + name });
  }
);

// Photos are decrypted on the way out rather than served straight off disk.
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

app.get('/u/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[\w-]+\.(jpg|png|webp|gif)$/.test(name)) return res.status(404).end();
  let raw;
  try {
    raw = fs.readFileSync(path.join(UPLOAD_DIR, name));
  } catch {
    return res.status(404).end();
  }
  const body = decFile(raw);
  if (!body) return res.status(500).end();
  res.set('Content-Type', MIME_BY_EXT[name.split('.').pop()]);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(body);
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

/** code -> Set<ws> */
const roomSockets = new Map();

function membersOf(code) {
  const set = roomSockets.get(code);
  if (!set) return [];
  return [...set]
    .filter((s) => s.meta?.joined)
    .map((s) => ({ id: s.meta.id, name: s.meta.name, avatar: s.meta.avatar }));
}

function broadcast(code, msg, exceptWs = null) {
  const set = roomSockets.get(code);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const s of set) {
    if (s !== exceptWs && s.readyState === s.OPEN) s.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastCard(code, cardId, by, verb) {
  const row = store.getCard(cardId, code);
  if (!row) return;
  broadcast(code, { t: 'card:update', card: rowToCard(row), by, verb, now: Date.now() });
}

wss.on('connection', (ws) => {
  ws.meta = { joined: false, id: crypto.randomUUID(), room: null, name: '', avatar: '🐻', hidden: false };
  ws.isAlive = true;
  ws.budget = 20;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (buf) => {
    if (ws.budget <= 0) return;
    ws.budget--;
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('ws handler error:', err);
      sendTo(ws, { t: 'error', code: 'internal' });
    }
  });

  ws.on('close', () => {
    const { room, joined } = ws.meta;
    if (!room) return;
    const set = roomSockets.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) roomSockets.delete(room);
    }
    if (joined) {
      broadcast(room, { t: 'members', members: membersOf(room) });
      broadcast(room, { t: 'left', name: ws.meta.name });
    }
  });
});

// Refill message budgets + WS keepalive.
setInterval(() => {
  for (const ws of wss.clients) ws.budget = Math.min(20, ws.budget + 10);
}, 1000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function handleMessage(ws, msg) {
  const now = Date.now();

  if (msg.t === 'ping') return sendTo(ws, { t: 'pong', now });

  // A tab that is open but hidden is not "watching" — it should still get a push.
  if (msg.t === 'vis') {
    ws.meta.hidden = !!msg.hidden;
    return;
  }

  if (msg.t === 'join') {
    const code = clampStr(msg.room, 40).toLowerCase();
    const room = store.getRoom(code);
    if (!room) return sendTo(ws, { t: 'error', code: 'room-not-found' });

    // Leaving a previous room on the same socket is not supported; clients reconnect.
    // Signed-in members get their account identity and the room saved to
    // their account, so it follows them to every device.
    const account = userFromToken(msg.token);
    ws.meta.room = code;
    ws.meta.name = account?.name || clampStr(msg.name, 24) || 'misafir';
    ws.meta.avatar = account?.avatar || clampStr(msg.avatar, 8) || '🐻';
    ws.meta.cid = clampStr(msg.cid, 64);
    ws.meta.userId = account?.id || null;
    ws.meta.joined = true;
    if (account) q.linkRoom.run(account.id, code, now);

    let set = roomSockets.get(code);
    if (!set) roomSockets.set(code, (set = new Set()));
    set.add(ws);

    q.touchRoom.run(now, code);
    sendTo(ws, {
      t: 'room',
      room: { code: room.code, name: room.name },
      cards: store.roomCards(code).map(rowToCard),
      members: membersOf(code),
      you: ws.meta.id,
      chat: store
        .recentMsgs(code, 60)
        .reverse()
        .map((m) => ({
          id: m.id, cid: m.cid, author: m.author, avatar: m.avatar,
          text: m.text, photo: m.photo, createdAt: m.created_at,
        })),
      now,
    });
    broadcast(code, { t: 'members', members: membersOf(code) }, ws);
    broadcast(code, { t: 'joined', name: ws.meta.name }, ws);
    return;
  }

  if (!ws.meta.joined) return sendTo(ws, { t: 'error', code: 'not-joined' });
  const code = ws.meta.room;
  const by = { name: ws.meta.name, avatar: ws.meta.avatar, id: ws.meta.id };
  q.touchRoom.run(now, code);

  switch (msg.t) {
    case 'room:rename': {
      const name = clampStr(msg.name, 40);
      if (!name) return;
      store.renameRoom(name, now, code);
      broadcast(code, { t: 'room:update', room: { code, name }, by });
      return;
    }

    case 'card:add': {
      const c = msg.card || {};
      if (!CARD_TYPES.has(c.type)) return;
      if (q.cardCount.get(code).n >= MAX_CARDS_PER_ROOM)
        return sendTo(ws, { t: 'error', code: 'room-full' });
      const id = crypto.randomUUID();
      const title = clampStr(c.title, 60) || '...';
      const emoji = clampStr(c.emoji, 8);
      const config = sanitizeConfig(c.type, c.config);
      let state = defaultState(c.type, now);
      if (c.type === 'streak') {
        const startAt = toInt(c.config?.startAt, 0, now, now);
        state.startAt = startAt || now;
      }
      if (c.type === 'note') {
        state.text = clampStr(c.config?.text, 500);
        state.author = ws.meta.name;
        state.updatedAt = now;
      }
      if (c.type === 'list' && Array.isArray(c.config?.items)) {
        state.items = c.config.items
          .slice(0, MAX_LIST_ITEMS)
          .map((text) => clampStr(text, 120))
          .filter(Boolean)
          .map((text) => ({ id: crypto.randomUUID(), text, done: false, doneBy: '' }));
      }
      const sort = q.maxSort.get(code).m + 1;
      store.insertCard(id, code, c.type, title, emoji, JSON.stringify(config), JSON.stringify(state), sort, now);
      broadcastCard(code, id, by, 'card:add');
      pushToRoom(code, 'cardAdd', [ws.meta.name, `${emoji || ''} ${title}`.trim()], ws.meta.cid);
      return;
    }

    case 'card:edit': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row) return;
      const title = clampStr(msg.title ?? row.title, 60) || row.title;
      const emoji = clampStr(msg.emoji ?? row.emoji, 8);
      const config = msg.config !== undefined ? sanitizeConfig(row.type, msg.config) : JSON.parse(row.config);
      store.updateCardMeta(title, emoji, JSON.stringify(config), row.id);
      if (row.type === 'streak' && msg.config?.startAt !== undefined) {
        const state = JSON.parse(row.state);
        state.startAt = toInt(msg.config.startAt, 0, now, state.startAt) || state.startAt;
        store.updateCardState(JSON.stringify(state), row.id);
      }
      broadcastCard(code, row.id, by, 'card:edit');
      return;
    }

    case 'card:delete': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row) return;
      const cfg = JSON.parse(row.config);
      if (cfg.photo) fs.unlink(path.join(UPLOAD_DIR, path.basename(cfg.photo)), () => {});
      q.deleteCard.run(row.id);
      broadcast(code, { t: 'card:delete', id: row.id, title: row.title, by });
      pushToRoom(code, 'cardDelete', [ws.meta.name, row.title], ws.meta.cid);
      return;
    }

    case 'tally': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'tally') return;
      const delta = msg.delta === -1 ? -1 : 1;
      const state = JSON.parse(row.state);
      state.count = Math.max(0, (state.count || 0) + delta);
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, delta > 0 ? 'tally+' : 'tally-');
      if (delta > 0) {
        // one nudge per card per minute, however fast they tap
        pushToRoom(code, 'tally', [ws.meta.name, row.title, state.count], ws.meta.cid, {
          key: 'tally:' + row.id,
          windowMs: 60000,
        });
      }
      return;
    }

    case 'streak:reset': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'streak') return;
      const state = JSON.parse(row.state);
      const days = Math.floor((now - (state.startAt || now)) / 86400000);
      state.best = Math.max(state.best || 0, days);
      state.startAt = now;
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, 'streak:reset');
      pushToRoom(code, 'streakReset', [ws.meta.name, row.title], ws.meta.cid);
      return;
    }

    case 'timer': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'timer') return;
      const state = JSON.parse(row.state);
      if (msg.op === 'start' && !state.running) {
        state.running = true;
        state.startedAt = now;
      } else if (msg.op === 'pause' && state.running) {
        state.accumulated = (state.accumulated || 0) + (now - state.startedAt);
        state.running = false;
        state.startedAt = 0;
      } else if (msg.op === 'reset') {
        state.running = false;
        state.startedAt = 0;
        state.accumulated = 0;
      } else {
        return;
      }
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `timer:${msg.op}`);
      if (msg.op === 'start') pushToRoom(code, 'timerStart', [ws.meta.name, row.title], ws.meta.cid);
      if (msg.op === 'pause') pushToRoom(code, 'timerPause', [ws.meta.name, row.title], ws.meta.cid);
      return;
    }

    case 'money': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'money') return;
      const amount = toInt(msg.amount, -100000000, 100000000, 0);
      if (!amount) return;
      const state = JSON.parse(row.state);
      const before = state.total || 0;
      state.total = Math.max(0, before + amount);
      state.log = [{ a: amount, by: ws.meta.name, at: now }, ...(state.log || [])].slice(0, 20);

      // running per-person net, so the card can show who put in what
      state.by = state.by || {};
      const who = ws.meta.userId || ws.meta.cid || ws.meta.id;
      const mine = (state.by[who] = state.by[who] || { net: 0 });
      mine.name = ws.meta.name;
      mine.avatar = ws.meta.avatar;
      mine.net = (mine.net || 0) + amount;
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, amount > 0 ? 'money+' : 'money-');

      const cfg = JSON.parse(row.config);
      const cur = cfg.cur || '₺';
      pushToRoom(
        code,
        amount > 0 ? 'moneyIn' : 'moneyOut',
        [ws.meta.name, row.title, Math.abs(amount), state.total, cur],
        ws.meta.cid
      );
      // crossing the finish line deserves its own nudge
      if (cfg.goal && before < cfg.goal && state.total >= cfg.goal) {
        pushToRoom(code, 'moneyGoal', [row.title, state.total, cur], ws.meta.cid);
      }
      return;
    }

    case 'checkin': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'checkin') return;
      const day = validDay(msg.day);
      if (!day) return;

      const mode = JSON.parse(row.config).mode || 'all';
      const state = JSON.parse(row.state);
      state.people = state.people || {};
      state.days = state.days || {};
      state.covers = state.covers || [];

      // signed-in members keep one slot across all their devices
      const me = ws.meta.userId || ws.meta.cid || ws.meta.id;
      const wasComplete = dayIsComplete(state, mode, day);

      // top the shared mercy pool back up at the start of each month
      const month = day.slice(0, 7);
      if (state.tokenMonth !== month) {
        state.tokenMonth = month;
        state.tokens = COVER_TOKENS_PER_MONTH;
      }

      const rec = (state.days[day] = state.days[day] || {});

      if (msg.op === 'tick') {
        state.people[me] = { name: ws.meta.name, avatar: ws.meta.avatar };
        rec[me] = { by: ws.meta.name, at: now };
      } else if (msg.op === 'untick') {
        if (!rec[me] || rec[me].coveredBy) return;
        delete rec[me];
        if (!Object.keys(rec).length) delete state.days[day];
      } else if (msg.op === 'cover') {
        // you can only spend a token on someone else — that is the whole point
        const forKey = clampStr(msg.forKey, 80);
        if (!forKey || forKey === me) return;
        if (!state.people[forKey] || rec[forKey]) return;
        if ((state.tokens || 0) <= 0) return sendTo(ws, { t: 'error', code: 'no-tokens' });
        state.tokens--;
        rec[forKey] = { by: state.people[forKey].name, coveredBy: ws.meta.name, at: now };
        state.covers = [{ by: ws.meta.name, for: state.people[forKey].name, day }, ...state.covers].slice(0, 10);
      } else {
        return;
      }

      // keep the history bounded
      const cutoff = dayKey(new Date(now - KEEP_DAYS * 86400000));
      for (const k of Object.keys(state.days)) if (k < cutoff) delete state.days[k];

      state.best = Math.max(state.best || 0, computeStreak(state, mode));
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `checkin:${msg.op}`);

      if (msg.op === 'cover') {
        broadcast(code, {
          t: 'checkin:cover',
          id: row.id,
          title: row.title,
          by: ws.meta.name,
          forName: rec[clampStr(msg.forKey, 80)]?.by || '',
        });
        pushToRoom(code, 'cover', [ws.meta.name, row.title], ws.meta.cid);
        return;
      }

      if (!wasComplete && dayIsComplete(state, mode, day)) {
        const streak = computeStreak(state, mode);
        broadcast(code, { t: 'checkin:done', id: row.id, title: row.title, streak });
        pushToRoom(code, 'checkinDone', [row.title, streak], ws.meta.cid);
      } else if (msg.op === 'tick') {
        pushToRoom(code, 'checkinTick', [ws.meta.name, row.title], ws.meta.cid);
      }
      return;
    }

    case 'list': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'list') return;
      const state = JSON.parse(row.state);
      state.items = Array.isArray(state.items) ? state.items : [];

      if (msg.op === 'add') {
        const text = clampStr(msg.text, 120);
        if (!text || state.items.length >= MAX_LIST_ITEMS) return;
        state.items.push({ id: crypto.randomUUID(), text, done: false, doneBy: '' });
      } else if (msg.op === 'toggle') {
        const item = state.items.find((i) => i.id === msg.itemId);
        if (!item) return;
        item.done = !item.done;
        item.doneBy = item.done ? ws.meta.name : '';
      } else if (msg.op === 'remove') {
        const before = state.items.length;
        state.items = state.items.filter((i) => i.id !== msg.itemId);
        if (state.items.length === before) return;
      } else if (msg.op === 'clear-done') {
        const before = state.items.length;
        state.items = state.items.filter((i) => !i.done);
        if (state.items.length === before) return;
      } else {
        return;
      }

      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `list:${msg.op}`);

      const allDone = state.items.length && state.items.every((i) => i.done);
      if (allDone && msg.op === 'toggle') {
        broadcast(code, { t: 'list:done', id: row.id, title: row.title, by });
        pushToRoom(code, 'listDone', [row.title], ws.meta.cid);
      } else if (msg.op === 'add') {
        pushToRoom(code, 'listAdd', [ws.meta.name, row.title, clampStr(msg.text, 60)], ws.meta.cid, {
          key: 'list:' + row.id,
          windowMs: 45000,
        });
      } else if (msg.op === 'toggle') {
        const done = state.items.filter((i) => i.done).length;
        pushToRoom(code, 'listTick', [ws.meta.name, row.title, done, state.items.length], ws.meta.cid, {
          key: 'listtick:' + row.id,
          windowMs: 60000,
        });
      }
      return;
    }

    case 'chat:send': {
      const text = clampStr(msg.text, 500);
      const photo = typeof msg.photo === 'string' && /^\/u\/[\w-]+\.(jpg|png|webp|gif)$/.test(msg.photo)
        ? msg.photo
        : null;
      if (!text && !photo) return;
      const m = {
        id: crypto.randomUUID(),
        cid: ws.meta.cid || '',
        author: ws.meta.name,
        avatar: ws.meta.avatar,
        text,
        photo,
        createdAt: now,
      };
      store.insertMsg(m, code);
      for (const old of q.oldMsgs.all(code, code)) {
        if (old.photo) fs.unlink(path.join(UPLOAD_DIR, path.basename(old.photo)), () => {});
        q.delMsg.run(old.id);
      }
      broadcast(code, { t: 'chat:new', msg: m });
      pushToRoom(code, 'chat', [m.author, `${photo ? '📷 ' : ''}${text.slice(0, 90)}`.trim()], ws.meta.cid);
      return;
    }

    case 'note:set': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'note') return;
      const state = JSON.parse(row.state);
      state.text = clampStr(msg.text, 500);
      state.author = ws.meta.name;
      state.updatedAt = now;
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, 'note:set');
      pushToRoom(code, 'note', [ws.meta.name, state.text.slice(0, 90)], ws.meta.cid);
      return;
    }

    case 'cheer': {
      const kind = msg.kind === 'confetti' ? 'confetti' : 'hearts';
      broadcast(code, { t: 'cheer', kind, by });
      pushToRoom(code, 'cheer', [ws.meta.name], ws.meta.cid, { key: 'cheer', windowMs: 20000 });
      return;
    }
  }
}

server.listen(PORT, () => {
  console.log(`CozyTally listening on :${PORT} (data: ${DATA_DIR})`);
});
