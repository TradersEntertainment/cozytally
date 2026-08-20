/* A room worth looking at.

   App Review opens the app alone, and an app for two people looks broken when
   you are one person: an empty board and nowhere to go. That reads as "it does
   not work" and it is a common way to be sent back. So this builds a room that
   already has a life in it — two names, a pot with a goal, a game half played,
   a few messages — and prints an invite link to put in the review notes.

   The same room is what the App Store screenshots are taken from.

   Run:  node scripts/seed-demo.mjs                    (local)
         CT_API_BASE=https://cetele.up.railway.app node scripts/seed-demo.mjs
*/
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const BASE = (process.env.CT_API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const RABIA = { cid: 'demo-rabia', name: 'Rabia', avatar: '🐰' };
const OMER = { cid: 'demo-omer', name: 'Ömer', avatar: '🐻' };

/* Pictures made here rather than shipped, so the repository does not carry
   stock photography it has no licence for. */
async function makePictures() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const shots = {};
  for (const [key, bg, emoji] of [
    ['bike', 'linear-gradient(150deg,#ffb86b,#ff9eb5)', '🚲'],
    ['sea', 'linear-gradient(150deg,#8be9c9,#9fd8ff)', '🏖️'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(
      `<style>*{margin:0}body{width:900px;height:600px;background:${bg};
        display:grid;place-items:center;font-size:280px}</style><div>${emoji}</div>`
    );
    await page.waitForTimeout(150);
    shots[key] = await page.screenshot({ type: 'jpeg', quality: 88 });
    await page.close();
  }
  await browser.close();
  return shots;
}

async function upload(code, buf) {
  const r = await fetch(`${BASE}/api/upload/${code}`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: buf,
  });
  if (!r.ok) throw new Error('upload failed: ' + r.status);
  return (await r.json()).url;
}

/** A socket that talks like the app does, and remembers what it was told. */
async function connect(code, who) {
  const ws = new WebSocket(WS);
  const inbox = [];
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ t: 'join', room: code, name: who.name, avatar: who.avatar, cid: who.cid }));
  await wait(500);
  return {
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    lastCard: () => [...inbox].reverse().find((m) => m.t === 'card:update')?.card,
  };
}

const pics = await makePictures();

const room = await (await fetch(`${BASE}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Bizim Köşe', me: RABIA }),
})).json();
const code = room.code;

const invite = (await (await fetch(`${BASE}/api/rooms/${code}/invite`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ me: RABIA }),
})).json()).token;
await fetch(`${BASE}/api/invites/${invite}/accept`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ me: OMER }),
});

const bike = await upload(code, pics.bike);
const sea = await upload(code, pics.sea);

const a = await connect(code, RABIA);
const b = await connect(code, OMER);

a.send({ t: 'card:add', card: { type: 'tally', title: 'Kahve', emoji: '☕', config: {} } });
await wait(500);
const tally = a.lastCard().id;
for (let i = 0; i < 7; i++) { a.send({ t: 'tally', id: tally, delta: 1 }); await wait(80); }

b.send({ t: 'card:add', card: { type: 'streak', title: 'Yürüyüş', emoji: '🔥', config: {} } });
await wait(500);

a.send({ t: 'card:add', card: { type: 'list', title: 'Hafta sonu', emoji: '📝',
  config: { items: ['Pazara git', 'Film seç', 'Kek yap'] } } });
await wait(500);
const list = a.lastCard().id;
const items = a.lastCard().state.items;
if (items?.[0]) { b.send({ t: 'list', id: list, op: 'toggle', itemId: items[0].id }); await wait(250); }
if (items?.[2]) { a.send({ t: 'list', id: list, op: 'toggle', itemId: items[2].id }); await wait(250); }

a.send({ t: 'card:add', card: { type: 'pet', title: 'Pamuk', emoji: '🐾',
  config: { kind: 'cat', name: 'Pamuk' } } });
await wait(500);
const pet = a.lastCard().id;
b.send({ t: 'pet', id: pet, act: 'feed' });
await wait(300);

// a game with a move in it, so the card is not an empty board
b.send({ t: 'card:add', card: { type: 'game', title: 'XOX', emoji: '⭕', config: { game: 'xox' } } });
await wait(600);
const game = b.lastCard().id;
b.send({ t: 'game:move', id: game, move: { cell: 4 } });
await wait(300);
a.send({ t: 'game:move', id: game, move: { cell: 0 } });
await wait(300);

/* Last, so it lands on top: new cards go to the front of the board, and a pot
   with two photographed goals in it is the thing worth opening on. */
a.send({
  t: 'card:add',
  card: {
    type: 'money', title: 'Tatil fonu', emoji: '💰',
    config: { cur: '₺', goals: [
      { title: 'Bisiklet', amount: 9000, photo: bike },
      { title: 'Deniz tatili', amount: 45000, photo: sea },
    ] },
  },
});
await wait(700);
const pot = a.lastCard().id;
a.send({ t: 'money', id: pot, amount: 5400 });
await wait(350);
b.send({ t: 'money', id: pot, amount: 3800 });
await wait(500);

for (const [who, text] of [
  [a, 'bisiklet için 5.400 attım 🚲'],
  [b, 'ben de 3.800 💪 yaza yetişiriz'],
  [a, 'kahve sayacı yine benden ilerledi ☕'],
]) { who.send({ t: 'chat:send', text }); await wait(350); }

a.close();
b.close();
await wait(300);

console.log(`
Demo odası hazır.

  oda        ${code}
  adres      ${BASE}/r/${code}
  davet bağı ${BASE}/j/${invite}

App Review notlarına davet bağını koy: incelemeci onu açınca odaya üye olur ve
Rabia ile Ömer'in yanına katılır. Odalara yalnızca davetle girildiği için,
bağ olmadan boş bir ekran görür ve uygulamayı çalışmıyor sanır.
`);
