import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

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
`);

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
    if (!q.getRoom.get(code)) return code;
  }
  return crypto.randomUUID().slice(0, 8);
}

const CARD_TYPES = new Set(['tally', 'streak', 'timer', 'countdown']);
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
  return out;
}

function defaultState(type, now) {
  if (type === 'tally') return { count: 0 };
  if (type === 'streak') return { startAt: now, best: 0 };
  if (type === 'timer') return { running: false, startedAt: 0, accumulated: 0 };
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
  q.createRoom.run(code, name, now, now);
  res.json({ code, name });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = q.getRoom.get(clampStr(req.params.code, 40).toLowerCase());
  if (!room) return res.status(404).json({ error: 'not-found' });
  res.json({ code: room.code, name: room.name });
});

app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
  const row = q.getCard.get(cardId, code);
  if (!row) return;
  broadcast(code, { t: 'card:update', card: rowToCard(row), by, verb, now: Date.now() });
}

wss.on('connection', (ws) => {
  ws.meta = { joined: false, id: crypto.randomUUID(), room: null, name: '', avatar: '🐻' };
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

  if (msg.t === 'join') {
    const code = clampStr(msg.room, 40).toLowerCase();
    const room = q.getRoom.get(code);
    if (!room) return sendTo(ws, { t: 'error', code: 'room-not-found' });

    // Leaving a previous room on the same socket is not supported; clients reconnect.
    ws.meta.room = code;
    ws.meta.name = clampStr(msg.name, 24) || 'misafir';
    ws.meta.avatar = clampStr(msg.avatar, 8) || '🐻';
    ws.meta.joined = true;

    let set = roomSockets.get(code);
    if (!set) roomSockets.set(code, (set = new Set()));
    set.add(ws);

    q.touchRoom.run(now, code);
    sendTo(ws, {
      t: 'room',
      room: { code: room.code, name: room.name },
      cards: q.roomCards.all(code).map(rowToCard),
      members: membersOf(code),
      you: ws.meta.id,
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
      q.renameRoom.run(name, now, code);
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
      const sort = q.maxSort.get(code).m + 1;
      q.insertCard.run(id, code, c.type, title, emoji, JSON.stringify(config), JSON.stringify(state), sort, now);
      broadcastCard(code, id, by, 'card:add');
      return;
    }

    case 'card:edit': {
      const row = q.getCard.get(clampStr(msg.id, 40), code);
      if (!row) return;
      const title = clampStr(msg.title ?? row.title, 60) || row.title;
      const emoji = clampStr(msg.emoji ?? row.emoji, 8);
      const config = msg.config !== undefined ? sanitizeConfig(row.type, msg.config) : JSON.parse(row.config);
      q.updateCardMeta.run(title, emoji, JSON.stringify(config), row.id);
      if (row.type === 'streak' && msg.config?.startAt !== undefined) {
        const state = JSON.parse(row.state);
        state.startAt = toInt(msg.config.startAt, 0, now, state.startAt) || state.startAt;
        q.updateCardState.run(JSON.stringify(state), row.id);
      }
      broadcastCard(code, row.id, by, 'card:edit');
      return;
    }

    case 'card:delete': {
      const row = q.getCard.get(clampStr(msg.id, 40), code);
      if (!row) return;
      q.deleteCard.run(row.id);
      broadcast(code, { t: 'card:delete', id: row.id, title: row.title, by });
      return;
    }

    case 'tally': {
      const row = q.getCard.get(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'tally') return;
      const delta = msg.delta === -1 ? -1 : 1;
      const state = JSON.parse(row.state);
      state.count = Math.max(0, (state.count || 0) + delta);
      q.updateCardState.run(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, delta > 0 ? 'tally+' : 'tally-');
      return;
    }

    case 'streak:reset': {
      const row = q.getCard.get(clampStr(msg.id, 40), code);
      if (!row || row.type !== 'streak') return;
      const state = JSON.parse(row.state);
      const days = Math.floor((now - (state.startAt || now)) / 86400000);
      state.best = Math.max(state.best || 0, days);
      state.startAt = now;
      q.updateCardState.run(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, 'streak:reset');
      return;
    }

    case 'timer': {
      const row = q.getCard.get(clampStr(msg.id, 40), code);
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
      q.updateCardState.run(JSON.stringify(state), row.id);
      broadcastCard(code, row.id, by, `timer:${msg.op}`);
      return;
    }

    case 'cheer': {
      const kind = msg.kind === 'confetti' ? 'confetti' : 'hearts';
      broadcast(code, { t: 'cheer', kind, by });
      return;
    }
  }
}

server.listen(PORT, () => {
  console.log(`CozyTally listening on :${PORT} (data: ${DATA_DIR})`);
});
