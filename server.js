import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import webpush from 'web-push';
// lives under public/ because the browser loads the very same file to run the
// how-to-play demo — the rules a player is shown are the rules that referee
import {
  isGame, newGameState, nextRound, seatOf, applyMove, redactGame, CLOSEST_ROUND,
  chainTimeout, useDictionary,
} from './public/games.js';
import { newPetState, act as petAct, isKind, mood as petMood } from './public/pet.js';
import { QUESTIONS } from './questions.js';
import { WORDS } from './words.js';

// the referee gets the dictionary; a browser never does
useDictionary((w) => WORDS.has(w));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Railway volume mounts at /data; fall back to ./data for local development.
const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cozytally.db'));
db.pragma('journal_mode = WAL');
/* Without a limit the write-ahead log only ever grows: ours had settled at
   4 MB against a 114 KB database, none of it live, and every backup copied
   all of it. SQLite hands the space back at the next checkpoint. */
db.pragma('journal_size_limit = 33554432');
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
  CREATE TABLE IF NOT EXISTS chat_seen (
    room_code TEXT NOT NULL,
    person    TEXT NOT NULL,
    name      TEXT NOT NULL,
    avatar    TEXT NOT NULL DEFAULT '🐻',
    seen_at   INTEGER NOT NULL,
    PRIMARY KEY (room_code, person)
  );
  /* Who is allowed in a room. Until now the answer was "whoever knows the
     code", which was true enough when the only two people who knew it were
     the two people in it. Once every couple has a room, every code that works
     is a stranger's relationship, and there are only 24 x 23 x 90 of them.

     The person column is not a new kind of identity — it is the same
     userId-or-cid key the rest of the app uses, so signing in and merging a
     guest device carries membership along with everything else. */
  CREATE TABLE IF NOT EXISTS room_members (
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    person    TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    avatar    TEXT NOT NULL DEFAULT '🐻',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, person)
  );
  /* An invite is the room's real key; the code is just its name. Unlimited
     uses on purpose — some rooms are a couple, some are a friend group, and
     the app has no business deciding which. */
  CREATE TABLE IF NOT EXISTS room_invites (
    token      TEXT PRIMARY KEY,
    room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    made_by    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_invites_room ON room_invites(room_code);
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

// Who wrote a message, as opposed to which browser it came from. Messages
// only ever carried a device id, so signing in on a second device made your
// own words look like somebody else's. Older rows keep NULL and fall back to
// the device id, which is all we ever knew about them.
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'user_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN user_id TEXT');
}

/* Rooms made before there was such a thing as membership stay open for a
   while, because the people in them are spread across devices this server
   never wrote down, and locking the door on a partner's laptop would be a
   worse bug than the one being fixed. New rooms are born locked (0). */
if (!db.prepare('PRAGMA table_info(rooms)').all().some((c) => c.name === 'open_until')) {
  db.exec('ALTER TABLE rooms ADD COLUMN open_until INTEGER NOT NULL DEFAULT 0');
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
    moneyGoalNamed: (g, c, amt, cur) =>
      `“${g}” hedefine ulaştınız! ⭐ ${c} · ${nf('tr', amt)}${cur} 🎉`,
    cardAdd: (n, c) => `${n} yeni kart ekledi: ${c}`,
    cardDelete: (n, c) => `${n} bir kartı sildi: ${c} 🗑️`,
    tally: (n, c, v) => `${n}: ${c} → ${v} ✨`,
    money: (n, c, v) => `${n} 💰 ${v} · ${c}`,
    note: (n, t) => `${n} 💌 ${t}`,
    noteComment: (n, c, t) => `${n} “${c}” notuna yorum yaptı 💬 ${t}`,
    gameComment: (n, c, t) => `${n} oyunda yazdı 💬 ${c}: ${t}`,
    chat: (n, t) => `${n}: ${t}`,
    cheer: (n, e) => `${n} ${e}✨`,
    pet: (n, p) => `${n}, ${p} ile ilgilendi 🐾`,
    timerStart: (n, c) => `${n} başlattı: ${c} ⏳`,
    timerPause: (n, c) => `${n} durdurdu: ${c} 🌙`,
    streakReset: (n, c) => `${n}: ${c} sıfırlandı 🌧️`,
    listAdd: (n, c, t) => `${n}: ${c} 📝 ${t}`,
    listTick: (n, c, d, tot) => `${n}: ${c} ${d}/${tot} ✅`,
    listDone: (c) => `${c} tamamlandı! 🎉`,
    checkinTick: (n, c) => `${n} ✅ ${c}`,
    checkinDone: (c, s) => `Gün tamam! ${c} · ${s} gün 🔥`,
    cover: (n, c) => `${n} bugünü senin için örttü 🧣 · ${c}`,
    gameTurn: (n, c) => `${n} oynadı — sıra sende 🎲 ${c}`,
    gameWon: (n, c) => `${n} kazandı! 🎉 ${c}`,
    gameDraw: (c) => `Berabere kaldınız 🤝 ${c}`,
  },
  en: {
    moneyIn: (n, c, amt, total, cur) =>
      `${n} put +${nf('en', amt)}${cur} in 💰 · ${c}: ${nf('en', total)}${cur}`,
    moneyOut: (n, c, amt, total, cur) =>
      `${n} took −${nf('en', amt)}${cur} out 🍃 · ${c}: ${nf('en', total)}${cur}`,
    moneyGoal: (c, total, cur) => `Goal reached! ${c} · ${nf('en', total)}${cur} 🎉💰`,
    moneyGoalNamed: (g, c, amt, cur) =>
      `“${g}” reached! ⭐ ${c} · ${nf('en', amt)}${cur} 🎉`,
    cardAdd: (n, c) => `${n} added a card: ${c}`,
    cardDelete: (n, c) => `${n} deleted a card: ${c} 🗑️`,
    tally: (n, c, v) => `${n}: ${c} → ${v} ✨`,
    money: (n, c, v) => `${n} 💰 ${v} · ${c}`,
    note: (n, t) => `${n} 💌 ${t}`,
    noteComment: (n, c, t) => `${n} commented on “${c}” 💬 ${t}`,
    gameComment: (n, c, t) => `${n} said in the game 💬 ${c}: ${t}`,
    chat: (n, t) => `${n}: ${t}`,
    pet: (n, p) => `${n} looked after ${p} 🐾`,
    cheer: (n, e) => `${n} ${e}✨`,
    timerStart: (n, c) => `${n} started: ${c} ⏳`,
    timerPause: (n, c) => `${n} paused: ${c} 🌙`,
    streakReset: (n, c) => `${n}: ${c} was reset 🌧️`,
    listAdd: (n, c, t) => `${n}: ${c} 📝 ${t}`,
    listTick: (n, c, d, tot) => `${n}: ${c} ${d}/${tot} ✅`,
    listDone: (c) => `${c} is done! 🎉`,
    checkinTick: (n, c) => `${n} ✅ ${c}`,
    checkinDone: (c, s) => `Day complete! ${c} · ${s} days 🔥`,
    cover: (n, c) => `${n} covered today for you 🧣 · ${c}`,
    gameTurn: (n, c) => `${n} played — your turn 🎲 ${c}`,
    gameWon: (n, c) => `${n} won! 🎉 ${c}`,
    gameDraw: (c) => `It's a draw 🤝 ${c}`,
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

  addMember: db.prepare(
    `INSERT INTO room_members (room_code, person, name, avatar, joined_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_code, person) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`
  ),
  isMember: db.prepare('SELECT 1 FROM room_members WHERE room_code = ? AND person = ?'),
  roomMembers: db.prepare(
    'SELECT person, name, avatar, joined_at FROM room_members WHERE room_code = ? ORDER BY joined_at'
  ),
  dropMember: db.prepare('DELETE FROM room_members WHERE room_code = ? AND person = ?'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_code = ?'),
  lockRoom: db.prepare('UPDATE rooms SET open_until = 0 WHERE code = ?'),
  openRoomUntil: db.prepare('UPDATE rooms SET open_until = ? WHERE code = ?'),

  makeInvite: db.prepare(
    `INSERT INTO room_invites (token, room_code, made_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ),
  getInvite: db.prepare('SELECT * FROM room_invites WHERE token = ?'),
  roomInvites: db.prepare(
    'SELECT token, made_by, created_at, expires_at FROM room_invites WHERE room_code = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC'
  ),
  revokeInvite: db.prepare('UPDATE room_invites SET revoked = 1 WHERE token = ? AND room_code = ?'),
  revokeRoomInvites: db.prepare('UPDATE room_invites SET revoked = 1 WHERE room_code = ?'),
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
  minSort: db.prepare('SELECT COALESCE(MIN(sort), 0) AS m FROM cards WHERE room_code = ?'),
  cardIds: db.prepare('SELECT id FROM cards WHERE room_code = ?'),
  setCardSort: db.prepare('UPDATE cards SET sort = ? WHERE id = ? AND room_code = ?'),
  insertMsg: db.prepare(
    `INSERT INTO messages (id, room_code, cid, user_id, author, avatar, text, photo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  recentMsgs: db.prepare('SELECT * FROM messages WHERE room_code = ? ORDER BY created_at DESC LIMIT ?'),
  setSeen: db.prepare(
    `INSERT INTO chat_seen (room_code, person, name, avatar, seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_code, person) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
       seen_at = MAX(seen_at, excluded.seen_at)`
  ),
  seenForRoom: db.prepare('SELECT person, name, avatar, seen_at FROM chat_seen WHERE room_code = ?'),
  getSeen: db.prepare('SELECT * FROM chat_seen WHERE room_code = ? AND person = ?'),
  isUser: db.prepare('SELECT 1 FROM users WHERE id = ?'),
  deleteSeen: db.prepare('DELETE FROM chat_seen WHERE room_code = ? AND person = ?'),
  getMeta: db.prepare('SELECT v FROM schema_meta WHERE k = ?'),
  setMeta: db.prepare('INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)'),
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
  updatePass: db.prepare('UPDATE users SET pass = ? WHERE id = ?'),
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
    q.insertMsg.run(m.id, code, m.cid, m.userId || null, enc(m.author), m.avatar, enc(m.text), m.photo, m.createdAt),
  recentMsgs: (code, n) => q.recentMsgs.all(code, n).map(readMsgRow),
  setSeen: (code, person, name, avatar, at) => q.setSeen.run(code, person, enc(name), avatar, at),
  seenForRoom: (code) =>
    q.seenForRoom.all(code).map((r) => ({
      person: r.person,
      name: dec(r.name, '???'),
      avatar: r.avatar,
      at: r.seen_at,
    })),

  userRooms: (userId) => q.userRooms.all(userId).map((r) => ({ ...r, name: dec(r.name, '???') })),

  // names go in encrypted here for the same reason they do everywhere else
  addMember: (code, person, name, avatar, at) =>
    q.addMember.run(code, person, enc(name || ''), avatar || '🐻', at),
  roomMembers: (code) =>
    q.roomMembers.all(code).map((r) => ({
      person: r.person,
      name: dec(r.name, '???'),
      avatar: r.avatar,
      at: r.joined_at,
    })),
};

/* Piggy banks predate per-person totals, so their contributions are empty.
   Rebuild what we can from the transaction log they already carry. The log
   keeps the last 20 entries, so anything older stays unattributed rather
   than being guessed at — it shows up as its own "earlier" slice. */
const LEGACY_PREFIX = 'name:';
/** the bucket for money that was in the pot before anyone was being counted */
const LEGACY_KEY = 'legacy:earlier';
const setCardState = db.prepare('UPDATE cards SET state = ? WHERE id = ?');
const backfillMoney = db.transaction(() => {
  const rows = db.prepare("SELECT id, state FROM cards WHERE type = 'money'").all();
  let touched = 0;
  for (const row of rows) {
    let state;
    try {
      state = JSON.parse(dec(row.state, '{}'));
    } catch {
      continue;
    }
    if (state.by && Object.keys(state.by).length) continue;
    const log = Array.isArray(state.log) ? state.log : [];
    if (!log.length) continue;

    const by = {};
    let attributed = 0;
    for (const e of log) {
      const name = typeof e.by === 'string' ? e.by : '';
      const amount = Number(e.a) || 0;
      if (!name || !amount) continue;
      const key = LEGACY_PREFIX + name;
      by[key] = by[key] || { name, avatar: '👤', net: 0 };
      by[key].net += amount;
      attributed += amount;
    }
    if (!Object.keys(by).length) continue;

    const older = Math.max(0, (state.total || 0) - attributed);
    if (older > 0) by[LEGACY_KEY] = { name: 'önceki', avatar: '🕰️', net: older };

    state.by = by;
    setCardState.run(enc(JSON.stringify(state)), row.id);
    touched++;
  }
  return touched;
});

const MONEY_BACKFILL_KEY = 'money_backfill_v1';
try {
  // it scanned every card on every boot to find work it had already done
  if (!q.getMeta.get(MONEY_BACKFILL_KEY)) {
    const n = backfillMoney();
    q.setMeta.run(MONEY_BACKFILL_KEY, String(Date.now()));
    if (n) console.log(`Backfilled contributions on ${n} piggy bank(s) from their history`);
  }
} catch (err) {
  console.error('money backfill skipped:', err.message);
}

/* Spending used to take money off whoever pressed the button, and the pot was
   floored at zero while the shares were not — so a piggy bank could easily end
   up holding a different amount than its shares add up to. Now that a spend is
   split deliberately, that difference is the whole point of the card, and a
   number that was wrong before the change would stay wrong forever. This puts
   every existing pot back in step with its shares, once. */
const backfillShares = db.transaction(() => {
  const rows = db.prepare("SELECT id, state FROM cards WHERE type = 'money'").all();
  let touched = 0;
  for (const row of rows) {
    let state;
    try {
      state = JSON.parse(dec(row.state, '{}'));
    } catch {
      continue;
    }
    const by = state.by;
    if (!by || !Object.keys(by).length) continue;
    const total = Math.max(0, Number(state.total) || 0);

    // a negative share means nothing now — it was only ever the old rule's
    // arithmetic showing through
    for (const v of Object.values(by)) v.net = Math.max(0, Math.round(Number(v.net) || 0));
    let sum = Object.values(by).reduce((n, v) => n + v.net, 0);
    if (sum === total) continue;

    if (sum < total) {
      // more in the pot than anyone is credited with: the rest came from before
      const older = (by[LEGACY_KEY] = by[LEGACY_KEY] || { name: 'önceki', avatar: '🕰️', net: 0 });
      older.net += total - sum;
    } else {
      // credited with more than is actually there — spend the oldest money first
      const older = by[LEGACY_KEY];
      if (older) {
        const take = Math.min(older.net, sum - total);
        older.net -= take;
        sum -= take;
        if (!older.net) delete by[LEGACY_KEY];
      }
      if (sum > total) {
        /* Still over, so everyone loses the same proportion. Largest remainder,
           because the shares have to add up to the pot exactly and rounding
           each one on its own does not. */
        const people = Object.values(by);
        const exact = people.map((v) => (v.net * total) / sum);
        const floors = exact.map(Math.floor);
        let short = total - floors.reduce((a, b) => a + b, 0);
        const order = exact
          .map((v, i) => ({ i, frac: v - floors[i] }))
          .sort((a, b) => b.frac - a.frac);
        for (const o of order) {
          if (short <= 0) break;
          floors[o.i]++;
          short--;
        }
        people.forEach((v, i) => (v.net = floors[i]));
      }
    }
    for (const [k, v] of Object.entries(by)) if (!v.net) delete by[k];
    setCardState.run(enc(JSON.stringify(state)), row.id);
    touched++;
  }
  return touched;
});

/* Rooms that predate membership already know who is in them — it is written
   down in four places, none of which were put there for this. Take the union:
   anyone who has read the chat, anyone whose account saved the room, anyone
   who turned notifications on, and anyone who ever said anything.

   The window on top of that is not belt-and-braces, it is the honest
   admission that those four places miss people: a partner who only ever
   opened cards, on a browser that never subscribed to anything, is invisible
   here and would find the door locked. While the window is open the room is
   exactly as reachable as it has always been, so the only cost of giving it a
   month is that the fix lands a month later. */
const MEMBER_BACKFILL_KEY = 'room_members_v1';
const GRACE = 30 * 24 * 60 * 60 * 1000;

function backfillMembers(now) {
  const rows = db
    .prepare(
      `SELECT room_code, person, name, avatar FROM chat_seen
       UNION
       SELECT room_code, user_id AS person, '' AS name, '🐻' AS avatar FROM user_rooms
       UNION
       SELECT room_code, cid AS person, '' AS name, '🐻' AS avatar FROM push_subs WHERE cid IS NOT NULL
       UNION
       SELECT room_code, COALESCE(user_id, cid) AS person, author AS name, avatar FROM messages
        WHERE COALESCE(user_id, cid) IS NOT NULL`
    )
    .all();
  const add = db.prepare(
    `INSERT INTO room_members (room_code, person, name, avatar, joined_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_code, person) DO NOTHING`
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!r.person || !q.getRoom.get(r.room_code)) continue;
      // names arrive already encrypted from the tables they were read out of
      add.run(r.room_code, r.person, r.name || '', r.avatar || '🐻', now);
      n++;
    }
    db.prepare('UPDATE rooms SET open_until = ?').run(now + GRACE);
  })();
  return n;
}

try {
  if (!q.getMeta.get(MEMBER_BACKFILL_KEY)) {
    const now = Date.now();
    const n = backfillMembers(now);
    q.setMeta.run(MEMBER_BACKFILL_KEY, String(now));
    console.log(`Wrote down ${n} room membership(s); older rooms stay open for 30 days`);
  }
} catch (err) {
  console.error('member backfill skipped:', err.message);
}

const SHARE_BACKFILL_KEY = 'money_share_v1';
try {
  if (!q.getMeta.get(SHARE_BACKFILL_KEY)) {
    const n = backfillShares();
    q.setMeta.run(SHARE_BACKFILL_KEY, String(Date.now()));
    if (n) console.log(`Squared up the shares on ${n} piggy bank(s) with what is in them`);
  }
} catch (err) {
  console.error('share backfill skipped:', err.message);
}

/* Read receipts arrived after people had already been talking for weeks, so
   every older conversation starts blank: nothing is marked until the other
   person next opens the chat, which reads as "the feature is broken".

   We can't know what was read, but we do know something almost as good: if
   you wrote a message, you had the chat open, so you had seen everything up
   to that moment. Seed each person's receipt from the last thing they said.

   Runs exactly once, recorded in schema_meta — re-running would resurrect the
   guest rows that mergeSeen() below deliberately deletes. */
const SEEN_BACKFILL_KEY = 'seen_backfill_v1';
const backfillSeen = db.transaction(() => {
  if (q.getMeta.get(SEEN_BACKFILL_KEY)) return 0;
  // the newest message from each person in each room, keyed the way receipts
  // are: by account where we know it, by device otherwise
  const rows = db
    .prepare(
      `SELECT m.room_code, COALESCE(m.user_id, m.cid) AS person, m.author, m.avatar, m.created_at
         FROM messages m
         JOIN (SELECT room_code, COALESCE(user_id, cid) AS person, MAX(created_at) AS mx
                 FROM messages WHERE COALESCE(user_id, cid) IS NOT NULL
                                 AND COALESCE(user_id, cid) <> ''
                GROUP BY room_code, COALESCE(user_id, cid)) t
           ON t.room_code = m.room_code
          AND t.person = COALESCE(m.user_id, m.cid)
          AND t.mx = m.created_at`
    )
    .all();
  for (const r of rows) {
    // r.author is still ciphertext and chat_seen.name is stored the same way,
    // so it goes in as-is — store.setSeen would encrypt it a second time and
    // the name would come back as '???'.
    q.setSeen.run(r.room_code, r.person, r.author, r.avatar || '🐻', r.created_at);
  }
  q.setMeta.run(SEEN_BACKFILL_KEY, String(rows.length));
  return rows.length;
});

try {
  const n = backfillSeen();
  if (n) console.log(`Seeded read receipts for ${n} person/room pair(s) from chat history`);
} catch (err) {
  console.error('read-receipt backfill skipped:', err.message);
}

/**
 * Every person this room's cards have attributed something to, and what they
 * were called at the time. A shared board keeps who-did-what in half a dozen
 * shapes — a piggy bank's shares, a check-in's roster, the name on a comment,
 * the chair in a game — and they are all keyed the same way, so they can all
 * be found the same way.
 */
function roomPeople(code) {
  const out = new Map();
  const put = (key, name, avatar) => {
    if (!key) return;
    const had = out.get(key);
    out.set(key, { name: name || had?.name || '', avatar: avatar || had?.avatar || '' });
  };
  for (const row of store.roomCards(code)) {
    let state;
    try {
      state = JSON.parse(row.state);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(state.by || {})) put(k, v?.name, v?.avatar);
    for (const [k, v] of Object.entries(state.people || {})) put(k, v?.name, v?.avatar);
    for (const c of state.comments || []) put(c?.key, c?.by, c?.avatar);
    for (const pl of state.players || []) put(pl?.key, pl?.name, pl?.avatar);
  }
  return out;
}

const sameName = (a, b) =>
  !!a && !!b && String(a).toLocaleLowerCase('tr') === String(b).toLocaleLowerCase('tr');

/**
 * Who in this room is nobody — a device used before there was an account to
 * put it under, or a name a piggy bank reconstructed out of its own history.
 * These are the entries that read as a second person on the card and are
 * really you from before.
 *
 * Only ones going by your name are offered. In a room of two, the other
 * unattached identity is usually your partner's old phone, and "was this
 * you?" is a terrible question to ask about somebody else's contributions —
 * one wrong tap and you have taken their half of the pot.
 */
function unclaimedIn(code, meKey, meName) {
  const out = [];
  for (const [key, who] of roomPeople(code)) {
    if (!key || key === meKey || key === LEGACY_KEY) continue;
    if (key.startsWith(LEGACY_PREFIX)) {
      const name = who.name || key.slice(LEGACY_PREFIX.length);
      if (sameName(name, meName)) out.push({ key, name, avatar: who.avatar || '🕰️' });
      continue;
    }
    if (q.isUser.get(key)) continue; // already somebody's account
    if (!sameName(who.name, meName)) continue;
    out.push({ key, name: who.name, avatar: who.avatar || '🐻' });
  }
  return out.slice(0, 12);
}

/**
 * Fold one or more old identities into a person, everywhere in one room.
 *
 * The shares of a piggy bank add up, because they are amounts of the same
 * money. Everything else is a label, and the label becomes yours. Returns the
 * cards it actually changed, so only those have to be sent out again.
 */
const mergeInto = db.transaction((code, fromKeys, toKey, name, avatar) => {
  const from = new Set(fromKeys.filter((k) => k && k !== toKey));
  const touched = [];
  if (!from.size) return touched;

  for (const row of store.roomCards(code)) {
    let state;
    try {
      state = JSON.parse(row.state);
    } catch {
      continue;
    }
    let hit = false;

    if (state.by) {
      const mine = (state.by[toKey] = state.by[toKey] || { net: 0, name, avatar });
      for (const k of from) {
        if (!state.by[k]) continue;
        mine.net = (mine.net || 0) + (state.by[k].net || 0);
        delete state.by[k];
        hit = true;
      }
      if (hit) {
        mine.name = name;
        mine.avatar = avatar;
      } else if (!state.by[toKey].net && !Object.prototype.hasOwnProperty.call(state.by, toKey)) {
        delete state.by[toKey];
      }
    }

    if (state.people) {
      for (const k of from) {
        if (!state.people[k]) continue;
        state.people[toKey] = { name, avatar };
        delete state.people[k];
        hit = true;
      }
      /* A day is ticked once per person, so two identities that both ticked it
         collapse into the one tick they always were. */
      for (const day of Object.values(state.days || {})) {
        for (const k of from) {
          if (!day[k]) continue;
          day[toKey] = day[toKey] || day[k];
          delete day[k];
          hit = true;
        }
      }
    }

    for (const c of state.comments || []) {
      if (!from.has(c.key)) continue;
      c.key = toKey;
      c.by = name;
      c.avatar = avatar;
      hit = true;
    }

    /* Both chairs at a game could have been the same person under two names.
       Re-keying would seat them twice, which no game can make sense of, so
       the second one is left as it was. */
    for (const pl of state.players || []) {
      if (!from.has(pl.key)) continue;
      if ((state.players || []).some((o) => o !== pl && o.key === toKey)) continue;
      pl.key = toKey;
      pl.name = name;
      pl.avatar = avatar;
      hit = true;
    }

    if (hit) {
      store.updateCardState(JSON.stringify(state), row.id);
      touched.push(row.id);
    }
  }
  return touched;
});

/* A receipt is filed under your account id once you sign in, but under this
   device's id while you are a guest. Someone who used a room as a guest and
   later made an account would otherwise leave the guest row behind forever —
   read as a second person, stuck under whatever they last read as a guest.
   Fold it into the account row the next time they connect. */
const mergeSeen = db.transaction((code, cid, name, avatar, userId) => {
  const guest = q.getSeen.get(code, cid);
  if (!guest) return;
  // keep how far they had read, but label it with who they are now rather
  // than the nickname they were using before they signed in
  store.setSeen(code, userId, name, avatar, guest.seen_at);
  q.deleteSeen.run(code, cid);
});

const reorderCards = db.transaction((code, ids) => {
  ids.forEach((id, i) => q.setCardSort.run(i, id, code));
  // cards the client never saw sink below the explicitly ordered ones
  const placed = new Set(ids);
  for (const row of q.cardIds.all(code)) {
    if (!placed.has(row.id)) q.setCardSort.run(ids.length, row.id, code);
  }
});

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

const CARD_TYPES = new Set([
  'tally', 'streak', 'timer', 'countdown', 'note', 'money', 'list', 'checkin', 'game', 'pet',
]);
/** cards that carry a little conversation of their own */
const COMMENTABLE = new Set(['note', 'game', 'pet']);
const MAX_LIST_ITEMS = 60;
const MAX_GOALS = 6;
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
  if (type === 'pet') {
    out.kind = isKind(src.kind) ? src.kind : 'cat';
    out.petName = clampStr(src.petName, 24);
  }
  if (type === 'game') {
    out.game = isGame(src.game) ? src.game : 'xox';
    // word chain's house rules, agreed when the card is made
    if (out.game === 'chain') {
      out.dict = src.dict === 'tr' ? 'tr' : 'free';
      out.limit = [0, 15, 30, 60].includes(Number(src.limit)) ? Number(src.limit) : 0;
    }
  }
  if (type === 'tally') out.goal = toInt(src.goal, 0, 100000, 0);
  if (type === 'countdown') out.targetAt = toInt(src.targetAt, 0, 4102444800000, 0);
  if (type === 'checkin') out.mode = src.mode === 'any' ? 'any' : 'all';
  if (type === 'money') {
    out.cur = clampStr(src.cur, 4) || '₺';
    const photoOf = (v) =>
      typeof v === 'string' && /^\/u\/[\w-]+\.(jpg|png|webp|gif)$/.test(v) ? v : undefined;

    if (Array.isArray(src.goals)) {
      // Each goal costs its own amount and they are paid off in the order they
      // were written — the pot fills the first one, then what is left over
      // spills into the second, and so on. So no sorting and no de-duping:
      // two goals may well cost the same, and the order is the plan.
      out.goals = src.goals
        .map((g) => ({
          amount: toInt(g?.amount, 0, 1000000000, 0),
          title: clampStr(g?.title, 40),
          photo: photoOf(g?.photo),
        }))
        .filter((g) => g.amount > 0)
        .slice(0, MAX_GOALS);
      // keep the flat field in step: what the whole plan costs together
      out.goal = out.goals.reduce((s, g) => s + g.amount, 0);
      const firstPhoto = out.goals.find((g) => g.photo)?.photo;
      if (firstPhoto) out.photo = firstPhoto;
    } else {
      out.goal = toInt(src.goal, 0, 1000000000, 0);
      const photo = photoOf(src.photo);
      if (photo) out.photo = photo;
    }
  }
  return out;
}

/** The goal ladder as a list, whichever of the two shapes the card was made in. */
function goalLadder(cfg) {
  if (Array.isArray(cfg.goals) && cfg.goals.length) return cfg.goals;
  if (cfg.goal) return [{ amount: cfg.goal, title: '', photo: cfg.photo }];
  return [];
}

/**
 * Read a stated split of a spend: who it comes out of, and how much of each.
 *
 * Nobody can be charged more than they actually have in the pot, which is what
 * keeps the shares from going negative — and with them the promise that the
 * pot is exactly the sum of the shares. Names and avatars are copied in beside
 * the numbers, because this record outlives the room: read back in a year, the
 * person may be gone and their entry in `by` with them.
 */
function spendSplit(raw, by) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [key, v] of Object.entries(raw)) {
    const share = by[key];
    if (!share) return []; // an unknown pocket to take from is a refusal, not a zero
    const amount = toInt(v, 0, Math.max(0, share.net || 0), -1);
    if (amount < 0) return []; // asked for more than they have
    if (!amount) continue;
    out.push({ key, name: share.name || '', avatar: share.avatar || '🐻', amount });
  }
  return out;
}

/* Ten questions for a round of "closest guess", drawn without repeats. The
   answers only ever live here — questions.js is outside public/ so a browser
   can't read ahead, and redactGame keeps them off the wire until both people
   have written a number down. */
function dealQuestions() {
  const pool = [...QUESTIONS];
  const out = [];
  for (let i = 0; i < CLOSEST_ROUND && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/* What a round needs to start. Closest gets a fresh deal; word chain carries
   the house rules forward — read off the card's config when it is made, and
   off the state it already has on every round after that. */
const gameOpts = (game, from) =>
  game === 'closest'
    ? { questions: dealQuestions() }
    : game === 'chain'
      ? { dict: from?.dict, limit: from?.limit }
      : {};

function defaultState(type, now, config) {
  if (type === 'pet') return newPetState(config?.kind, config?.petName, now);
  if (type === 'game') {
    const game = isGame(config?.game) ? config.game : 'xox';
    return newGameState(game, gameOpts(game, config));
  }
  if (type === 'tally') return { count: 0 };
  if (type === 'streak') return { startAt: now, best: 0 };
  if (type === 'timer') return { running: false, startedAt: 0, accumulated: 0 };
  if (type === 'note') return { text: '', author: '', updatedAt: 0, comments: [] };
  if (type === 'money') return { total: 0, log: [], by: {}, paid: [], hit: [] };
  if (type === 'list') return { items: [] };
  if (type === 'checkin')
    return { people: {}, days: {}, best: 0, tokens: COVER_TOKENS_PER_MONTH, tokenMonth: '', covers: [] };
  return {};
}

function rowToCard(row, forKey) {
  const state = JSON.parse(row.state);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    emoji: row.emoji,
    config: JSON.parse(row.config),
    /* The only funnel card state takes to reach a browser, so it is also the
       only place a game's secrets have to be held back. `forKey` is who the
       copy is for: most games keep the same secret from everyone and ignore
       it, but battleship owes the two of you different pictures. */
    state: row.type === 'game' ? redactGame(state, forKey) : state,
    sort: row.sort,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------- http
const app = express();
app.use(express.json({ limit: '16kb' }));
/* The whole client is 292 KB of text and none of it was compressed. Over a
   phone connection that is the single biggest thing standing between tapping
   a link and seeing your cards — it comes down to 81 KB. */
app.use(compression());

/* A stamp that changes once per deploy. Every asset is asked for as
   /app.js?v=<stamp>, which means a phone can hold on to it for a year and
   still pick up new code the moment it ships. Without it the browser has to
   ask about all five files on every single launch before anything can run. */
const BUILD = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) || String(Date.now());
const INDEX = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replaceAll('?v=dev', `?v=${BUILD}`);
const sendIndex = (_req, res) => {
  // the shell itself must never be held on to — it is what names the stamp
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX);
};
app.get('/', sendIndex);
app.get('/r/:code', sendIndex);

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (res.req.query?.v) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

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

/* Looking a room up used to be free, which made the whole 49.680-code space a
   yes/no oracle you could sweep in one pass. */
const lookupBuckets = new Map();
function allowLookup(ip) {
  const now = Date.now();
  let b = lookupBuckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 10 * 60 * 1000 };
    lookupBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= 40;
}

/* Who is asking, over HTTP — the same key the sockets use, so membership
   survives signing in and the guest-to-account merge that follows it. */
/* The device is reported alongside the account, not instead of it. Somebody
   who has been in a room for months as a guest and signs in this morning is
   still in that room — their account has never been a member of anything yet,
   and refusing them would make signing in a way to lose your own room. The
   socket already knew this; the door in front of it has to know it too.

   The cid is nested under `me` on a body because a request body already has a
   `name` in it and it is the room's, not the person's — the creator of
   "Tatil fonu" is not called Tatil fonu. */
function askerOf(req) {
  const cid = clampStr(req.body?.me?.cid || req.query?.cid, 64);
  const user = userFromToken(bearer(req));
  if (user) return { person: user.id, alt: cid, name: user.name, avatar: user.avatar };
  if (!cid) return null;
  const me = req.body?.me || {};
  return {
    person: cid,
    alt: '',
    name: clampStr(me.name, 24) || '',
    avatar: clampStr(me.avatar, 8) || '🐻',
  };
}

/** Whichever of the two the room actually knows, or nothing. */
function memberAs(code, who) {
  if (!who) return null;
  if (isMember(code, who.person)) return who.person;
  if (who.alt && isMember(code, who.alt)) return who.alt;
  return null;
}

/** A room made before membership existed is still open for its grace window. */
const roomOpen = (room) => (room?.open_until || 0) > Date.now();
const isMember = (code, person) => !!(person && q.isMember.get(code, person));

/* One answer for "no such room" and "not your room" on purpose. Telling them
   apart would hand back the oracle this whole change is about — the rate limit
   only slows a sweep down, it does not make the answer safe to give. */
const SHUT = { error: 'no-entry' };

app.post('/api/rooms', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!allowCreate(ip)) return res.status(429).json({ error: 'rate-limited' });
  const name = clampStr(req.body?.name, 40) || 'CozyTally';
  const code = newRoomCode();
  const now = Date.now();
  store.createRoom(code, name, now, now);
  // whoever made it is in it, and being first is what makes them the one who
  // can show somebody else the door later
  const who = askerOf(req);
  if (who) store.addMember(code, who.person, who.name, who.avatar, now);
  res.json({ code, name });
});

app.get('/api/rooms/:code', (req, res) => {
  const ip = clientIp(req);
  if (!allowLookup(ip)) return res.status(429).json({ error: 'rate-limited' });
  const code = clampStr(req.params.code, 40).toLowerCase();
  const room = store.getRoom(code);
  const who = askerOf(req);
  if (!room) return res.status(403).json(SHUT);
  const unclaimed = q.memberCount.get(code).n === 0;
  if (!memberAs(code, who) && !roomOpen(room) && !unclaimed) {
    return res.status(403).json(SHUT);
  }
  res.json({ code: room.code, name: room.name });
});

// ---------------------------------------------------------- invites
const INVITE_TTL = 30 * 24 * 60 * 60 * 1000;

/** Every invite route answers the same way to someone who is not in the room. */
function memberGate(req, res) {
  const code = clampStr(req.params.code, 40).toLowerCase();
  const room = store.getRoom(code);
  const who = askerOf(req);
  const seat = room && memberAs(code, who);
  if (!seat) {
    res.status(403).json(SHUT);
    return null;
  }
  // whichever identity the room knows them by is the one that acts here
  return { code, room, who: { ...who, person: seat } };
}

app.post('/api/rooms/:code/invite', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  q.makeInvite.run(token, gate.code, gate.who.person, now, now + INVITE_TTL);
  res.json({ token, expiresAt: now + INVITE_TTL });
});

app.get('/api/rooms/:code/invites', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  res.json({ invites: q.roomInvites.all(gate.code, Date.now()) });
});

app.post('/api/rooms/:code/invite/:token/revoke', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  q.revokeInvite.run(clampStr(req.params.token, 64), gate.code);
  res.json({ ok: true });
});

/* Opening an invite is how you get in. It says nothing about the room until it
   has worked, so a guessed token learns nothing either. */
app.post('/api/invites/:token/accept', (req, res) => {
  if (!allowLookup(clientIp(req))) return res.status(429).json({ error: 'rate-limited' });
  const inv = q.getInvite.get(clampStr(req.params.token, 64));
  const now = Date.now();
  if (!inv || inv.revoked || inv.expires_at < now) return res.status(403).json(SHUT);
  const room = store.getRoom(inv.room_code);
  if (!room) return res.status(403).json(SHUT);
  const who = askerOf(req);
  if (!who) return res.status(400).json({ error: 'who-are-you' });
  store.addMember(inv.room_code, who.person, who.name, who.avatar, now);
  res.json({ code: room.code, name: room.name });
});

// ---------------------------------------------------------- members
app.get('/api/rooms/:code/members', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  const members = store.roomMembers(gate.code);
  res.json({
    members,
    // the first one in is the one who can show somebody else the door
    owner: members[0]?.person || null,
    me: gate.who.person,
    openUntil: gate.room.open_until || 0,
  });
});

app.post('/api/rooms/:code/leave', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  q.dropMember.run(gate.code, gate.who.person);
  res.json({ ok: true });
});

app.post('/api/rooms/:code/remove', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  const members = store.roomMembers(gate.code);
  if (members[0]?.person !== gate.who.person) return res.status(403).json(SHUT);
  const person = clampStr(req.body?.person, 64);
  if (!person || person === gate.who.person) return res.status(400).json({ error: 'bad-target' });
  q.dropMember.run(gate.code, person);
  // whoever was shown the door must not be able to walk back in on an old link
  q.revokeRoomInvites.run(gate.code);
  res.json({ ok: true });
});

/* Ending the grace window early, for someone who has already gathered everyone
   and would rather not wait out the fortnight. */
app.post('/api/rooms/:code/lock', (req, res) => {
  const gate = memberGate(req, res);
  if (!gate) return;
  q.lockRoom.run(gate.code);
  res.json({ ok: true });
});

app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* An invite link. The token is not spent here — the page loads first and then
   asks, because accepting needs to know who is asking, and only the browser
   knows that. */
app.get('/j/:token', (_req, res) => {
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

/* Keep in step with RAIN in public/app.js — the key travels, the client
   decides what it looks like, and the emoji here is only for the push text. */
const CHEER_EMOJI = {
  love: '💖', smile: '😄', party: '🎉', star: '⭐',
  flower: '🌸', laugh: '😂', hug: '🤗', sleepy: '😴',
};
const CHEER_KINDS = new Set(Object.keys(CHEER_EMOJI));

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

/* There is no email here, so there is no reset link to send — and a scrypt
   hash cannot be read back, only replaced. What there is instead is a session
   that lasts about thirteen months: if you are still signed in somewhere, that
   device has already proved who you are, and asking it for a password you have
   by definition forgotten would be a lock with no key. So a live session is
   the credential.

   Other sessions are deliberately left alone. In an app for two people the
   stale-session risk is imaginary, while the device you are still signed in on
   is the only thing that saved you — signing yourself out of the others is a
   good way to end up right back here. */
app.post('/api/auth/password', (req, res) => {
  const user = userFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const password = String(req.body?.password ?? '');
  if (password.length < 6) return res.status(400).json({ error: 'short-password' });
  q.updatePass.run(hashPassword(password), user.id);
  res.json({ ok: true });
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
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  /* Everything on this socket is JSON with the same handful of keys over and
     over, which deflate eats alive: a room you join drops from 19 KB to 4, and
     a whole game of reversi from 40 KB to 2. Below the threshold a pong is
     smaller than the machinery, so those go out plain. */
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 6, memLevel: 8 } },
});

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
  /* Encoded once: handed a string, ws measures and re-encodes it for every
     socket. It must still go out as a text frame, though — a Buffer would
     otherwise be sent as binary and arrive as a Blob. */
  const data = Buffer.from(JSON.stringify(msg));
  for (const s of set) {
    if (s !== exceptWs && s.readyState === s.OPEN) s.send(data, { binary: false });
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Who is acting, as the rest of the app keys people: account first, then
    this device, then this socket. */
const personKey = (ws) => ws.meta.userId || ws.meta.cid || ws.meta.id;
const personOf = (ws) => ({ key: personKey(ws), name: ws.meta.name, avatar: ws.meta.avatar });

/* Word chain can be played against a clock, and a clock only means anything
   if something is actually watching it — a player who has walked away is
   exactly the case it exists for. So the deadline is kept in the state for
   both screens to draw, and the server keeps the one timer that enforces it.
   One per card, replaced on every move, dropped when the card is. */
const chainClocks = new Map();

function clearChainClock(cardId) {
  const h = chainClocks.get(cardId);
  if (h) clearTimeout(h);
  chainClocks.delete(cardId);
}

function armChainClock(code, cardId, state) {
  clearChainClock(cardId);
  if (state.game !== 'chain' || !state.limit || state.over) {
    state.deadline = 0;
    return;
  }
  // no clock until both chairs are taken; a chain of one is just waiting
  if (state.players.length < 2) {
    state.deadline = 0;
    return;
  }
  state.deadline = Date.now() + state.limit * 1000;
  chainClocks.set(
    cardId,
    setTimeout(() => {
      chainClocks.delete(cardId);
      try {
        const row = store.getCard(cardId, code);
        if (!row || row.type !== 'game') return;
        const live = JSON.parse(row.state);
        // it may have moved on between the timer being set and firing
        if (live.deadline !== state.deadline || live.over) return;
        if (!chainTimeout(live)) return;
        live.deadline = 0;
        store.updateCardState(JSON.stringify(live), cardId);
        broadcastCard(code, cardId, { name: '', avatar: '', id: '' }, 'game:move');
        const winner = live.players[live.over.winner];
        broadcast(code, {
          t: 'game:over',
          id: cardId,
          winner: winner ? { name: winner.name, avatar: winner.avatar } : null,
        });
      } catch (err) {
        console.error('chain clock:', err.message);
      }
    }, state.limit * 1000 + 250) // a little slack for the round trip
  );
}

function broadcastCard(code, cardId, by, verb, ref) {
  const row = store.getCard(cardId, code);
  if (!row) return;
  // `ref` is echoed straight back from the sender's card:add so they can
  // recognise the card they just made and finish filling it in
  const now = Date.now();
  if (row.type !== 'game') {
    broadcast(code, { t: 'card:update', card: rowToCard(row), by, verb, ref, now });
    return;
  }
  /* A game card is redacted for whoever is receiving it, so it cannot be
     encoded once and handed round — everyone gets their own copy. Two
     serialisations instead of one, in a room of two people. */
  for (const s of roomSockets.get(code) || []) {
    if (s.readyState !== s.OPEN) continue;
    sendTo(s, { t: 'card:update', card: rowToCard(row, personKey(s)), by, verb, ref, now });
  }
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
    // `return` here would end the whole sweep at the first dead socket and
    // leave everyone after it un-checked for another half minute
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/* "when was this room last used" only ever needs to be right to the minute,
   but it was being written on every single message — and in WAL mode bumping
   one integer still costs a whole 4 KB page, so it was doubling everything
   this app writes to disk. */
const touched = new Map();
function touchRoom(code, now) {
  if (now - (touched.get(code) || 0) < 60_000) return;
  touched.set(code, now);
  q.touchRoom.run(now, code);
}

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
    if (!room) return sendTo(ws, { t: 'error', code: 'no-entry' });

    /* The real door. Everything else is a courtesy: the browser is told early
       so it can show a decent screen, but this is the check that matters,
       because a socket is all anyone needs to read a room.

       Membership follows the same key as identity — an account if there is
       one, the device otherwise — and the account inherits whatever the
       device was already allowed, so signing in on the sofa does not lock you
       out of your own room. A room still inside its grace window lets anyone
       with the code in and writes them down; that window is how rooms that
       predate membership find their people. */
    const cid = clampStr(msg.cid, 64);
    const account = userFromToken(msg.token);
    const person = account?.id || cid;
    const name = account?.name || clampStr(msg.name, 24) || 'misafir';
    const avatar = account?.avatar || clampStr(msg.avatar, 8) || '🐻';
    const open = (room.open_until || 0) > now;
    const memberByDevice = cid && q.isMember.get(code, cid);
    /* A room nobody belongs to yet takes its first arrival. That covers a room
       made through the API without saying who was asking, and an old one whose
       people were never written down anywhere the backfill could read — and it
       gives nothing away, because a room with no members has nobody's
       anything in it. */
    const noOwnerYet = q.memberCount.get(code).n === 0;
    if (!person) return sendTo(ws, { t: 'error', code: 'no-entry' });
    if (!q.isMember.get(code, person) && !memberByDevice && !open && !noOwnerYet) {
      return sendTo(ws, { t: 'error', code: 'no-entry' });
    }
    // being here is what records you, whether you arrived by invite, by
    // account, or through a grace window that is about to close
    store.addMember(code, person, name, avatar, now);
    if (account && cid && cid !== person) q.dropMember.run(code, cid);

    // Leaving a previous room on the same socket is not supported; clients reconnect.
    // Signed-in members get their account identity and the room saved to
    // their account, so it follows them to every device.
    ws.meta.room = code;
    ws.meta.name = name;
    ws.meta.avatar = avatar;
    ws.meta.cid = cid;
    ws.meta.userId = account?.id || null;
    ws.meta.joined = true;
    if (account) q.linkRoom.run(account.id, code, now);
    /* Before the room payload is read, so they never see their own ghost. The
       device they are signing in on is theirs, so whatever it did here as a
       guest is theirs too — that much needs no asking. Anything left over
       belongs to some other device, and that does. */
    let unclaimed = [];
    if (account && ws.meta.cid) {
      try {
        mergeSeen(code, ws.meta.cid, ws.meta.name, ws.meta.avatar, account.id);
        mergeInto(code, [ws.meta.cid], account.id, ws.meta.name, ws.meta.avatar);
        unclaimed = unclaimedIn(code, account.id, ws.meta.name);
      } catch (err) {
        console.error('identity merge skipped:', err.message);
      }
    }

    let set = roomSockets.get(code);
    if (!set) roomSockets.set(code, (set = new Set()));
    set.add(ws);

    touchRoom(code, now);
    sendTo(ws, {
      t: 'room',
      room: { code: room.code, name: room.name },
      cards: store.roomCards(code).map((r) => rowToCard(r, personKey(ws))),
      members: membersOf(code),
      you: ws.meta.id,
      unclaimed,
      seen: store.seenForRoom(code),
      chat: store
        .recentMsgs(code, 60)
        .reverse()
        .map((m) => ({
          id: m.id, cid: m.cid, userId: m.user_id, author: m.author, avatar: m.avatar,
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
  touchRoom(code, now);

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
      let state = defaultState(c.type, now, config);
      if (c.type === 'game') {
        // whoever sets the game up takes the first chair, so the card opens
        // with a name against the first turn instead of two empty seats
        seatOf(state, personOf(ws));
      }
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
      // new cards land at the top of the board
      const sort = q.minSort.get(code).m - 1;
      store.insertCard(id, code, c.type, title, emoji, JSON.stringify(config), JSON.stringify(state), sort, now);
      broadcastCard(code, id, by, 'card:add', clampStr(msg.ref, 40) || undefined);
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

    case 'card:reorder': {
      if (!Array.isArray(msg.ids)) return;
      const known = new Set(q.cardIds.all(code).map((r) => r.id));
      const seen = new Set();
      const ordered = msg.ids
        .slice(0, 200)
        .map((id) => clampStr(id, 40))
        .filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
      if (!ordered.length) return;

      // anything the sender didn't know about (a card added mid-drag) keeps
      // its place after the ones they did order
      reorderCards(code, ordered);
      broadcast(code, { t: 'cards:order', ids: ordered, by });
      return;
    }

    case 'card:delete': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row) return;
      const cfg = JSON.parse(row.config);
      // drop every picture the card owned, not just the legacy single one
      const orphans = new Set(
        [cfg.photo, ...(Array.isArray(cfg.goals) ? cfg.goals.map((g) => g?.photo) : [])].filter(Boolean)
      );
      for (const p of orphans) fs.unlink(path.join(UPLOAD_DIR, path.basename(p)), () => {});
      clearChainClock(row.id); // nothing left to count down for
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

    case 'game:move':
    case 'game:next': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'game') return;
      const state = JSON.parse(row.state);
      const seatsBefore = state.players.length;
      const seat = seatOf(state, personOf(ws));
      if (seat < 0) return sendTo(ws, { t: 'error', code: 'game-full' });

      if (msg.t === 'game:next') {
        // anyone at the table can deal the next round, but only once this one
        // has actually finished
        if (!state.over) return;
        nextRound(state, gameOpts(state.game, state));
        armChainClock(code, row.id, state);
        store.updateCardState(JSON.stringify(state), row.id);
        broadcastCard(code, row.id, by, 'game:next');
        return;
      }

      const before = state.over;
      const res = applyMove(state, seat, msg.move);
      if (!res.ok) {
        // the move was refused, but sitting down still counts — show the room
        // that a second player has arrived, and say nothing otherwise
        if (state.players.length !== seatsBefore) {
          store.updateCardState(JSON.stringify(state), row.id);
          broadcastCard(code, row.id, by, 'game:seat');
        }
        // and tell the person who tried why it bounced, so they can fix it
        if (state.why) sendTo(ws, { t: 'game:no', id: row.id, why: state.why });
        return;
      }
      armChainClock(code, row.id, state);
      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, 'game:move');

      if (state.over && !before) {
        const won = state.over.winner;
        const winner = won === 'draw' ? null : state.players[won];
        broadcast(code, {
          t: 'game:over',
          id: row.id,
          card: row.title,
          game: state.game,
          draw: won === 'draw',
          winner: winner ? { name: winner.name, avatar: winner.avatar } : null,
        });
        pushToRoom(
          code,
          won === 'draw' ? 'gameDraw' : 'gameWon',
          won === 'draw' ? [row.title] : [winner?.name || '?', row.title],
          ws.meta.cid
        );
        return;
      }
      // Only nudge a phone when the turn actually changed hands — and never
      // throttle it. A turn can only come round as fast as the other person
      // plays, and the throttle is per card, so a quick exchange would eat
      // the notification meant for whoever had walked away.
      if (res.passed) pushToRoom(code, 'gameTurn', [ws.meta.name, row.title], ws.meta.cid);
      return;
    }

    case 'money': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'money') return;
      const state = JSON.parse(row.state);
      const before = state.total || 0;
      state.by = state.by || {};
      const who = ws.meta.userId || ws.meta.cid || ws.meta.id;
      const cfgNow = JSON.parse(row.config);
      const goalsNow = goalLadder(cfgNow);
      /* In the spend branch `amount` is the size of the spend, always positive,
         so its sign no longer says which way the money went. */
      const spending = msg.op === 'spend';
      let amount;

      if (spending) {
        /* Money leaving the pot is a different act from money arriving, and it
           is the one that used to be wrong: whoever pressed the button had it
           taken off their own share, however the money was really made up. Now
           the split is stated, and the pot and the shares can never disagree. */
        const gave = spendSplit(msg.gave, state.by);
        if (!gave.length) return;
        amount = gave.reduce((n, g) => n + g.amount, 0);
        const asked = toInt(msg.amount, 1, 100000000, 0);
        if (!amount || (asked && asked !== amount)) return;
        if (amount > before) return; // you cannot spend what is not in there

        for (const g of gave) state.by[g.key].net -= g.amount;
        state.total = before - amount;

        // people write a spend down after the fact, sometimes long after, and
        // sometimes on a card they only made once the money had gone
        const at = toInt(msg.at, 0, now, now);
        const note = clampStr(msg.note, 60);
        const goal = Number.isInteger(msg.goal) && goalsNow[msg.goal] ? msg.goal : -1;
        /* Pointing a spend at a goal says that goal is paid off, so what left
           the pot has to be enough to pay it. Without this, a single lira
           settles a 150.000 ₺ car: the stamp goes on the photo, the ladder
           moves on to the next rung, and the frozen contributions under the
           stamp add up to nothing like the price. Paying more than planned is
           fine — things cost what they cost. Paying less means the plan is
           what wants correcting, not the history. */
        if (goal >= 0 && amount < goalsNow[goal].amount) return;
        if (goal >= 0) {
          /* A goal that has been paid stays paid. Its name and price are copied
             in as they were, so editing the plan later cannot rewrite what
             happened — and so is who put the money in, because the shares it
             came out of are about to go down and that is the only record left
             of them. */
          state.paid = (state.paid || []).filter((p) => p.i !== goal);
          state.paid.push({
            i: goal,
            title: goalsNow[goal].title || '',
            amount: goalsNow[goal].amount,
            at,
            note,
            gave,
          });
          state.paid.sort((x, y) => x.i - y.i);
        }
        state.log = [
          { a: -amount, by: ws.meta.name, key: who, at, note, goal, gave },
          ...(state.log || []),
        ]
          .sort((x, y) => (y.at || 0) - (x.at || 0))
          .slice(0, 20);
      } else {
        amount = toInt(msg.amount, -100000000, 100000000, 0);
        if (!amount) return;

        /* Money out with nothing said about it comes off the share of whoever
           asked. Most of the time it is a correction — you typed the wrong
           number, and the wrong number was yours — and the rest of the time it
           is money that went nowhere in particular, which is nobody's business
           but the person writing it down.

           It stops at your own share. Quietly taking the difference off the
           other person would be a lie, and quietly writing off less than was
           asked for would be another; over that, the answer is no and the
           sheet is where to say who it really came from. That refusal is also
           what keeps the pot equal to the shares — the old floor at zero here
           was exactly what used to break it. */
        const held = Math.max(0, state.by[who]?.net || 0);
        if (amount < 0 && -amount > held) return;

        state.total = before + amount;
        const mine = (state.by[who] = state.by[who] || { net: 0 });
        mine.name = ws.meta.name;
        mine.avatar = ws.meta.avatar;
        mine.net = (mine.net || 0) + amount;

        /* A spend records whose money it was; so does this, so that the log
           reads the same either way and never has to say "Rabia" about money
           that was never hers. */
        state.log = [
          {
            a: amount,
            by: ws.meta.name,
            key: who,
            at: now,
            ...(amount < 0
              ? { gave: [{ key: who, name: ws.meta.name, avatar: ws.meta.avatar, amount: -amount }] }
              : {}),
          },
          ...(state.log || []),
        ].slice(0, 20);

        // fold any history that was reconstructed under this person's name
        // into their real entry, so they don't show up twice
        const legacy = LEGACY_PREFIX + ws.meta.name;
        if (legacy !== who && state.by[legacy]) {
          mine.net += state.by[legacy].net || 0;
          delete state.by[legacy];
        }
      }
      /* Which lines this crossed, worked out before anything is written: the
         copy that goes to the browsers has to be the same one that goes to
         disk, or a milestone can be cheered twice — once now and once when
         somebody reloads. */
      state.hit = Array.isArray(state.hit) ? state.hit : [];
      const settled = new Set((state.paid || []).map((x) => x.i));
      const cheered = [];
      /* A goal is paid off once the pot covers it *and* everything still owed
         before it, so the line to cross is a running sum — and a rung that has
         already been settled is not part of it any more. Its money left the day
         it was spent; counting it again would push every line after it out of
         reach. */
      let need = 0;
      goalsNow.forEach((g, i) => {
        if (settled.has(i)) return;
        need += g.amount;
        if (before >= need || state.total < need || state.hit.includes(i)) return;
        cheered.push(i);
      });
      if (cheered.length) state.hit = [...state.hit, ...cheered];

      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, !spending && amount > 0 ? 'money+' : 'money-');

      const cur = cfgNow.cur || '₺';
      pushToRoom(
        code,
        !spending && amount > 0 ? 'moneyIn' : 'moneyOut',
        [ws.meta.name, row.title, Math.abs(amount), state.total, cur],
        ws.meta.cid
      );
      /* Each line crossed gets its own celebration — and only ever one. A pot
         that dips under a line and climbs back over it has not achieved
         anything a second time, and confetti for something you did last month
         is worse than no confetti at all. */
      cheered.forEach((i) => {
        const g = goalsNow[i];
        broadcast(code, {
          t: 'money:goal',
          id: row.id,
          card: row.title,
          goal: g,
          index: i,
          of: goalsNow.length,
          last: i === goalsNow.length - 1,
        });
        pushToRoom(
          code,
          g.title ? 'moneyGoalNamed' : 'moneyGoal',
          g.title ? [g.title, row.title, g.amount, cur] : [row.title, state.total, cur],
          ws.meta.cid
        );
      });
      return;
    }

    /* "That was me too." An old device, or a name a piggy bank pieced together
       out of its own history — anything in this room that belongs to nobody
       can be taken over by somebody signed in. What is offered is worked out
       on the server, and checked again here, so a claim can only ever collect
       things that were genuinely unattached. */
    case 'claim': {
      if (!ws.meta.userId) return;
      const asked = (Array.isArray(msg.keys) ? msg.keys : [])
        .slice(0, 12)
        .map((k) => clampStr(k, 64))
        .filter(Boolean);
      if (!asked.length) return;
      const free = new Set(unclaimedIn(code, ws.meta.userId, ws.meta.name).map((x) => x.key));
      const take = asked.filter((k) => free.has(k));
      if (!take.length) return;
      const touched = mergeInto(code, take, ws.meta.userId, ws.meta.name, ws.meta.avatar);
      for (const id of touched) broadcastCard(code, id, by, 'claim');
      sendTo(ws, { t: 'claimed', n: take.length, cards: touched.length });
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
        userId: ws.meta.userId || null,
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

    case 'chat:seen': {
      const at = toInt(msg.at, 0, now + 60000, 0);
      if (!at) return;
      const person = ws.meta.userId || ws.meta.cid || ws.meta.id;
      store.setSeen(code, person, ws.meta.name, ws.meta.avatar, at);
      broadcast(code, { t: 'seen', seen: store.seenForRoom(code) });
      return;
    }

    // `note:comment` is the old name, still accepted so a tab left open
    // across a deploy keeps working
    case 'note:comment':
    case 'card:comment': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || !COMMENTABLE.has(row.type)) return;
      const state = JSON.parse(row.state);
      state.comments = Array.isArray(state.comments) ? state.comments : [];

      if (msg.op === 'remove') {
        const before = state.comments.length;
        // you can only take back your own words
        state.comments = state.comments.filter(
          (c) => !(c.id === msg.commentId && c.key === (ws.meta.userId || ws.meta.cid))
        );
        if (state.comments.length === before) return;
      } else {
        const text = clampStr(msg.text, 300);
        if (!text || state.comments.length >= 100) return;
        state.comments.push({
          id: crypto.randomUUID(),
          key: ws.meta.userId || ws.meta.cid || ws.meta.id,
          by: ws.meta.name,
          avatar: ws.meta.avatar,
          text,
          at: now,
        });
      }

      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `${row.type}:${msg.op === 'remove' ? 'uncomment' : 'comment'}`);
      if (msg.op !== 'remove') {
        pushToRoom(
          code,
          row.type === 'game' ? 'gameComment' : 'noteComment',
          [ws.meta.name, row.title, clampStr(msg.text, 70)],
          ws.meta.cid
        );
      }
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

    case 'pet:act': {
      const row = store.getCard(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'pet') return;
      const state = JSON.parse(row.state);
      const before = petMood(state, now);
      /* Everything a pet needs is worked out from the clock, so the server
         doing the acting is the whole of the enforcement — a browser can ask,
         it can't decide that the cat is hungry. */
      const done = petAct(state, clampStr(msg.act, 12), now, ws.meta);
      if (!done) return sendTo(ws, { t: 'pet:no', id: row.id, act: clampStr(msg.act, 12) });

      store.updateCardState(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `pet:${done.action}`);
      // worth a nudge when somebody has actually turned it around
      if (before !== 'happy' && done.mood === 'happy') {
        pushToRoom(code, 'pet', [ws.meta.name, state.name || row.title], ws.meta.cid, {
          key: `pet:${row.id}`,
          windowMs: 120000,
        });
      }
      return;
    }

    case 'cheer': {
      /* What each of these looks like when it falls is the client's business
         — see RAIN in public/app.js. The server only checks that it is one of
         the things we know about, so nothing unexpected reaches a screen. */
      const kind = CHEER_KINDS.has(msg.kind) ? msg.kind : 'love';
      broadcast(code, { t: 'cheer', kind, by });
      pushToRoom(code, 'cheer', [ws.meta.name, CHEER_EMOJI[kind]], ws.meta.cid, {
        key: 'cheer',
        windowMs: 20000,
      });
      return;
    }
  }
}

server.listen(PORT, () => {
  console.log(`CozyTally listening on :${PORT} (data: ${DATA_DIR})`);
});

/* Every deploy used to kill this process outright, so the log was never
   finalised and a backup taken from the .db file alone could be missing the
   last few minutes. Closing folds it back in. */
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    server.close();
    for (const ws of wss.clients) ws.close(1001, 'restart');
    try {
      db.close();
    } catch (err) {
      console.error('db close:', err.message);
    }
    process.exit(0);
  });
}
