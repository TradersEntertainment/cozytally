/* CozyTally client */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ------------------------------------------------------------ i18n
  let lang = localStorage.getItem('ct:lang') ||
    ((navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en');

  const t = (key, vars = {}) => {
    let s = (window.I18N[lang] && window.I18N[lang][key]) ?? window.I18N.en[key] ?? key;
    if (typeof s !== 'string') return s;
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  };

  function applyI18n() {
    document.documentElement.lang = lang;
    $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $$('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $('#lang-toggle').textContent = lang === 'tr' ? '🌐 TR' : '🌐 EN';
  }

  $('#lang-toggle').addEventListener('click', () => {
    lang = lang === 'tr' ? 'en' : 'tr';
    localStorage.setItem('ct:lang', lang);
    applyI18n();
    if (room) renderAllCards();
    renderRecents();
  });

  // ------------------------------------------------------------ night sky
  function buildSky() {
    const sky = $('#sky');
    for (let i = 0; i < 70; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.left = Math.random() * 100 + '%';
      s.style.top = Math.random() * 70 + '%';
      const sc = 0.5 + Math.random();
      s.style.width = s.style.height = 3 * sc + 'px';
      s.style.animationDelay = (Math.random() * 3).toFixed(2) + 's';
      s.style.animationDuration = (2 + Math.random() * 3).toFixed(2) + 's';
      sky.appendChild(s);
    }
    // bulbs along the string-lights path
    const path = $('#string-lights path');
    const svg = $('#string-lights');
    try {
      const len = path.getTotalLength();
      const colors = ['#ffd7a8', '#ff9eb5', '#b7a4ff', '#8be9c9'];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const p = path.getPointAtLength((len * i) / n);
        const b = document.createElement('div');
        b.className = 'bulb';
        const c = colors[i % colors.length];
        b.style.background = c;
        b.style.boxShadow = `0 0 10px 3px ${c}66`;
        b.style.left = `calc(${(p.x / 1200) * 100}% - 4px)`;
        b.style.top = (p.y / 90) * (svg.clientHeight || 90) + 4 + 'px';
        b.style.animationDelay = (i * 0.17).toFixed(2) + 's';
        sky.appendChild(b);
      }
    } catch { /* SVG API not available — skip bulbs */ }
    for (let i = 0; i < 6; i++) {
      const f = document.createElement('div');
      f.className = 'firefly';
      f.style.left = 5 + Math.random() * 90 + '%';
      f.style.top = 40 + Math.random() * 55 + '%';
      f.style.animationDelay = (Math.random() * 11).toFixed(2) + 's';
      sky.appendChild(f);
    }
  }

  // ------------------------------------------------------------ shared state
  const roomCode = location.pathname.startsWith('/r/')
    ? decodeURIComponent(location.pathname.slice(3)).toLowerCase()
    : null;

  let ws = null;
  let room = null;
  let cards = new Map();
  let clockOffset = 0;
  let wasDisconnected = false;
  const countdownCelebrated = new Set();

  const serverNow = () => Date.now() + clockOffset;

  const AVATARS = ['🐻', '🐰', '🦊', '🐱', '🐼', '🐨', '🦄', '🐣', '🐧', '🦉', '🐹', '🐸'];
  const EMOJIS = ['✏️', '🔥', '⏳', '🎈', '💌', '💖', '🌙', '⭐', '🍓', '🍵', '📚', '💪',
    '🧸', '🌸', '🎯', '💧', '🚭', '🏃', '🎁', '☕', '🎮', '🕌', '🌿', '✈️', '🎂'];
  const TYPE_META = {
    tally: { emoji: '✏️', nameKey: 'typeTally', descKey: 'typeTallyDesc' },
    streak: { emoji: '🔥', nameKey: 'typeStreak', descKey: 'typeStreakDesc' },
    timer: { emoji: '⏳', nameKey: 'typeTimer', descKey: 'typeTimerDesc' },
    countdown: { emoji: '🎈', nameKey: 'typeCountdown', descKey: 'typeCountdownDesc' },
    note: { emoji: '💌', nameKey: 'typeNote', descKey: 'typeNoteDesc' },
  };

  // ------------------------------------------------------------ modal helpers
  const overlay = $('#modal-overlay');
  const modalBox = $('#modal-box');
  let modalDismissable = true;

  function openModal(html, { dismissable = true } = {}) {
    modalDismissable = dismissable;
    modalBox.innerHTML = html;
    overlay.hidden = false;
    return modalBox;
  }

  function closeModal() {
    overlay.hidden = true;
    modalBox.innerHTML = '';
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && modalDismissable) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden && modalDismissable) closeModal();
  });

  function confirmModal({ title, body, yesLabel, danger = true }) {
    return new Promise((resolve) => {
      const box = openModal(`
        <h2>${esc(title)}</h2>
        <p style="color:var(--ink-dim); margin:0 0 6px">${esc(body)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost js-no">${esc(t('cancel'))}</button>
          <button class="btn ${danger ? 'btn-primary' : 'btn-secondary'} js-yes">${esc(yesLabel)}</button>
        </div>`);
      $('.js-no', box).onclick = () => { closeModal(); resolve(false); };
      $('.js-yes', box).onclick = () => { closeModal(); resolve(true); };
    });
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ toasts
  const toastsEl = $('#toasts');
  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }, 3200);
  }

  // ------------------------------------------------------------ effects
  function centerCheer(text, sad = false) {
    $$('.center-cheer').forEach((c) => c.remove());
    const el = document.createElement('div');
    el.className = 'center-cheer' + (sad ? ' sad' : '');
    el.textContent = text;
    el.style.rotate = (Math.random() * 12 - 6).toFixed(1) + 'deg';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1550);
  }

  function randomCheer(sad = false) {
    const list = t(sad ? 'sadCheers' : 'cheers');
    centerCheer(list[Math.floor(Math.random() * list.length)], sad);
  }

  function sparklesAt(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const types = ['✨', '⭐', '🌟'];
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('div');
      s.className = 'sparkle-fx';
      s.textContent = types[Math.floor(Math.random() * types.length)];
      s.style.left = rect.left + Math.random() * rect.width + 'px';
      s.style.top = rect.top + Math.random() * rect.height + 'px';
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1000);
    }
  }

  function heartsRain() {
    const hearts = ['💖', '💕', '💗', '🩷', '💘'];
    for (let i = 0; i < 26; i++) {
      const h = document.createElement('div');
      h.className = 'heart-fx';
      h.textContent = hearts[Math.floor(Math.random() * hearts.length)];
      h.style.left = Math.random() * 100 + 'vw';
      h.style.fontSize = 18 + Math.random() * 22 + 'px';
      h.style.animationDuration = (2.2 + Math.random() * 2.5).toFixed(2) + 's';
      h.style.animationDelay = (Math.random() * 0.8).toFixed(2) + 's';
      document.body.appendChild(h);
      setTimeout(() => h.remove(), 6000);
    }
  }

  // tiny confetti burst
  const confettiCanvas = $('#confetti-canvas');
  const ctx = confettiCanvas.getContext('2d');
  let confettiParticles = [];
  let confettiRunning = false;

  function confetti() {
    confettiCanvas.width = innerWidth;
    confettiCanvas.height = innerHeight;
    const colors = ['#ffb86b', '#ff9eb5', '#b7a4ff', '#8be9c9', '#ffd7a8', '#fff'];
    for (let i = 0; i < 130; i++) {
      confettiParticles.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * 200,
        y: innerHeight * 0.35,
        vx: (Math.random() - 0.5) * 13,
        vy: -Math.random() * 12 - 3,
        size: 5 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    if (!confettiRunning) {
      confettiRunning = true;
      requestAnimationFrame(confettiTick);
    }
  }

  function confettiTick() {
    ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    confettiParticles = confettiParticles.filter((p) => p.y < innerHeight + 30);
    for (const p of confettiParticles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.vx *= 0.99;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
      ctx.restore();
    }
    if (confettiParticles.length) requestAnimationFrame(confettiTick);
    else {
      confettiRunning = false;
      ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }
  }

  // ------------------------------------------------------------ landing
  function renderRecents() {
    const recents = JSON.parse(localStorage.getItem('ct:recent') || '[]');
    const wrap = $('#recent-rooms');
    if (!wrap) return;
    const list = $('#recent-list');
    list.innerHTML = '';
    wrap.hidden = recents.length === 0;
    for (const r of recents) {
      const a = document.createElement('a');
      a.className = 'chip chip-btn';
      a.href = '/r/' + encodeURIComponent(r.code);
      a.innerHTML = `${esc(r.name)}&nbsp;<small>${esc(r.code)}</small>`;
      list.appendChild(a);
    }
  }

  function rememberRoom(code, name) {
    let recents = JSON.parse(localStorage.getItem('ct:recent') || '[]');
    recents = recents.filter((r) => r.code !== code);
    recents.unshift({ code, name, ts: Date.now() });
    localStorage.setItem('ct:recent', JSON.stringify(recents.slice(0, 6)));
  }

  function initLanding() {
    $('#view-landing').hidden = false;
    renderRecents();

    $('#create-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#create-name').value.trim() || 'CozyTally';
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return;
      const data = await res.json();
      rememberRoom(data.code, data.name);
      location.href = '/r/' + encodeURIComponent(data.code);
    });

    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#join-code').value.trim().toLowerCase();
      if (!code) return;
      const res = await fetch('/api/rooms/' + encodeURIComponent(code));
      if (res.ok) {
        location.href = '/r/' + encodeURIComponent(code);
      } else {
        $('#join-error').hidden = false;
      }
    });
  }

  // ------------------------------------------------------------ identity
  function ensureIdentity() {
    return new Promise((resolve) => {
      const savedName = localStorage.getItem('ct:name');
      const savedAvatar = localStorage.getItem('ct:avatar');
      if (savedName) return resolve({ name: savedName, avatar: savedAvatar || '🐻' });

      let avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
      const box = openModal(`
        <h2>${esc(t('whoAreYou'))}</h2>
        <div class="field">
          <input id="nick-input" type="text" maxlength="24" placeholder="${esc(t('namePlaceholder'))}" autocomplete="off">
        </div>
        <div class="field">
          <label>${esc(t('pickAvatar'))}</label>
          <div class="emoji-row avatar-row">
            ${AVATARS.map((a) => `<button type="button" class="emoji-opt ${a === avatar ? 'selected' : ''}" data-a="${a}">${a}</button>`).join('')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary js-go">${esc(t('letsGo'))}</button>
        </div>
        <p class="modal-note">${esc(t('tagline'))}</p>
      `, { dismissable: false });

      $$('.emoji-opt', box).forEach((btn) => {
        btn.onclick = () => {
          avatar = btn.dataset.a;
          $$('.emoji-opt', box).forEach((b) => b.classList.toggle('selected', b === btn));
        };
      });

      const finish = () => {
        const name = $('#nick-input', box).value.trim();
        if (!name) return $('#nick-input', box).focus();
        localStorage.setItem('ct:name', name);
        localStorage.setItem('ct:avatar', avatar);
        closeModal();
        resolve({ name, avatar });
      };
      $('.js-go', box).onclick = finish;
      $('#nick-input', box).addEventListener('keydown', (e) => e.key === 'Enter' && finish());
      setTimeout(() => $('#nick-input', box)?.focus(), 60);
    });
  }

  // ------------------------------------------------------------ websocket
  let identity = null;
  let connBanner = null;
  let reconnectDelay = 1000;

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ t: 'join', room: roomCode, name: identity.name, avatar: identity.avatar }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServer(msg);
    };

    ws.onclose = () => {
      if (!connBanner) {
        connBanner = document.createElement('div');
        connBanner.className = 'conn-banner';
        connBanner.textContent = t('reconnecting');
        document.body.appendChild(connBanner);
      }
      wasDisconnected = true;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
    };

    ws.onerror = () => ws.close();
  }

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  setInterval(() => send({ t: 'ping' }), 25000);

  function handleServer(msg) {
    switch (msg.t) {
      case 'pong':
        clockOffset = msg.now - Date.now();
        return;

      case 'error':
        if (msg.code === 'room-not-found') {
          location.href = '/';
        }
        return;

      case 'room': {
        clockOffset = msg.now - Date.now();
        room = msg.room;
        cards = new Map(msg.cards.map((c) => [c.id, c]));
        rememberRoom(room.code, room.name);
        renderRoomHeader();
        renderMembers(msg.members);
        renderAllCards();
        if (connBanner) {
          connBanner.remove();
          connBanner = null;
        }
        if (wasDisconnected) {
          toast(t('reconnected'));
          wasDisconnected = false;
        }
        return;
      }

      case 'room:update':
        room = msg.room;
        rememberRoom(room.code, room.name);
        renderRoomHeader();
        return;

      case 'members':
        renderMembers(msg.members);
        return;

      case 'joined':
        toast(t('toastJoined', { name: msg.name }));
        return;

      case 'left':
        toast(t('toastLeft', { name: msg.name }));
        return;

      case 'card:update': {
        const prev = cards.get(msg.card.id);
        cards.set(msg.card.id, msg.card);
        if (msg.now) clockOffset = msg.now - Date.now();
        renderCard(msg.card, { prev, verb: msg.verb, by: msg.by });
        handleCardToasts(msg);
        updateEmptyHint();
        return;
      }

      case 'card:delete':
        cards.delete(msg.id);
        $(`.card[data-id="${msg.id}"]`)?.remove();
        if (msg.by?.id !== myId) toast(t('toastCardDelete', { name: msg.by.name, card: msg.title }));
        updateEmptyHint();
        return;

      case 'cheer':
        heartsRain();
        if (msg.by?.id !== myId) toast(t('toastHearts', { name: msg.by.name }));
        return;
    }
  }

  let myId = null;

  function handleCardToasts(msg) {
    const { by, verb, card } = msg;
    if (!by || by.id === myId) return; // own actions get cheers, not toasts
    const vars = { name: by.name, card: card.title };
    const map = {
      'tally+': 'toastTallyPlus',
      'tally-': 'toastTallyMinus',
      'timer:start': 'toastTimerStart',
      'timer:pause': 'toastTimerPause',
      'timer:reset': 'toastTimerReset',
      'streak:reset': 'toastStreakReset',
      'card:add': 'toastCardAdd',
      'note:set': 'toastNote',
    };
    if (map[verb]) toast(t(map[verb], vars));
  }

  // ------------------------------------------------------------ room rendering
  function renderRoomHeader() {
    $('#room-name').textContent = room.name;
    $('.chip-code').textContent = room.code;
    document.title = `${room.name} · CozyTally 🌙`;
  }

  function renderMembers(members) {
    const wrap = $('#members');
    wrap.innerHTML = '';
    for (const m of members) {
      const el = document.createElement('div');
      el.className = 'member';
      el.textContent = m.avatar;
      el.title = m.name;
      wrap.appendChild(el);
    }
  }

  function updateEmptyHint() {
    $('#empty-hint').hidden = cards.size > 0;
  }

  function renderAllCards() {
    const board = $('#board');
    board.innerHTML = '';
    const sorted = [...cards.values()].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
    for (const card of sorted) renderCard(card);
    updateEmptyHint();
  }

  function renderCard(card, opts = {}) {
    let el = $(`.card[data-id="${card.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = card.id;
      $('#board').appendChild(el);
    }
    el.className = `card card--${card.type}`;
    el.innerHTML = `
      <div class="card-head">
        <span class="card-emoji">${esc(card.emoji || TYPE_META[card.type].emoji)}</span>
        <span class="card-title">${esc(card.title)}</span>
        <button class="icon-btn js-edit" title="${esc(t('edit'))}">✏️</button>
        <button class="icon-btn js-del" title="${esc(t('del'))}">🗑️</button>
      </div>
      <div class="card-body"></div>`;

    $('.js-edit', el).onclick = () => openCardModal(card.type, card);
    $('.js-del', el).onclick = async () => {
      const ok = await confirmModal({
        title: t('confirmDeleteTitle'),
        body: t('confirmDeleteBody', { title: card.title }),
        yesLabel: t('yesDelete'),
      });
      if (ok) send({ t: 'card:delete', id: card.id });
    };

    const body = $('.card-body', el);
    if (card.type === 'tally') renderTallyBody(body, card, opts);
    if (card.type === 'streak') renderStreakBody(body, card);
    if (card.type === 'timer') renderTimerBody(body, card);
    if (card.type === 'countdown') renderCountdownBody(body, card);
    if (card.type === 'note') renderNoteBody(body, card);
    return el;
  }

  // ---- sticky note
  function renderNoteBody(body, card) {
    const text = card.state.text || '';
    body.innerHTML = `
      <div class="note-paper">
        ${text ? esc(text) : `<span class="note-empty">${esc(t('noteEmpty'))}</span>`}
        ${text && card.state.author ? `<span class="note-author">— ${esc(card.state.author)}</span>` : ''}
      </div>`;
    $('.note-paper', body).onclick = () => openNoteEditor(card);
  }

  function openNoteEditor(card) {
    const box = openModal(`
      <h2>💌 ${esc(card.title)}</h2>
      <div class="field">
        <textarea id="note-text" maxlength="500" placeholder="${esc(t('fieldNotePh'))}">${esc(card.state.text || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost js-cancel">${esc(t('cancel'))}</button>
        <button class="btn btn-primary js-save">${esc(t('save'))}</button>
      </div>`);
    $('.js-cancel', box).onclick = closeModal;
    $('.js-save', box).onclick = () => {
      send({ t: 'note:set', id: card.id, text: $('#note-text', box).value.trim() });
      closeModal();
    };
    setTimeout(() => $('#note-text', box)?.focus(), 60);
  }

  // ---- tally
  function renderTallyBody(body, card, opts = {}) {
    const count = card.state.count || 0;
    const goal = card.config.goal || 0;
    const animateLast = opts.verb === 'tally+';

    const groups = [];
    const full = Math.floor(count / 5);
    const rem = count % 5;
    const maxGroups = 40; // keep DOM sane for huge counts
    const startGroup = Math.max(0, full + (rem ? 1 : 0) - maxGroups);
    for (let g = startGroup; g < full; g++) groups.push(5);
    if (rem) groups.push(rem);

    body.innerHTML = `
      <div class="big-number">${count}</div>
      <div class="tally-marks">${groups
        .map((n, gi) => {
          const rot = (Math.random() * 8 - 4).toFixed(1);
          const marks = [];
          for (let i = 1; i <= n; i++) {
            const isLastMark = gi === groups.length - 1 && i === n;
            marks.push(`<div class="tm ${i === 5 ? 'slash' : ''} ${animateLast && isLastMark ? 'pop' : ''}"></div>`);
          }
          return `<div class="tg" style="--rot:${rot}deg">${marks.join('')}</div>`;
        })
        .join('')}</div>
      ${goal
        ? `<div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, (count / goal) * 100)}%"></div></div>
           <div class="sub-label">${count >= goal ? esc(t('goalDone')) : esc(t('left', { n: goal - count }))} · ${esc(t('goal', { n: goal }))}</div>`
        : ''}
      <div class="card-actions">
        <button class="round-btn minus js-minus">−</button>
        <button class="round-btn plus js-plus">+</button>
      </div>`;

    const marksEl = $('.tally-marks', body);
    if (marksEl) marksEl.scrollTop = marksEl.scrollHeight;

    $('.js-plus', body).onclick = (e) => {
      send({ t: 'tally', id: card.id, delta: 1 });
      sparklesAt(e.currentTarget.closest('.card'));
    };
    $('.js-minus', body).onclick = () => send({ t: 'tally', id: card.id, delta: -1 });
  }

  // ---- streak
  function renderStreakBody(body, card) {
    body.innerHTML = `
      <div class="big-number js-days"></div>
      <div class="sub-label js-since"></div>
      ${card.state.best ? `<div class="sub-label">🏆 ${esc(t('bestStreak', { n: card.state.best }))}</div>` : ''}
      <div class="card-actions">
        <button class="small-btn js-streak-reset">${esc(t('resetStreak'))}</button>
      </div>`;
    updateStreakBody(body, card);
    $('.js-streak-reset', body).onclick = async () => {
      const ok = await confirmModal({
        title: t('confirmStreakTitle'),
        body: t('confirmStreakBody'),
        yesLabel: t('yesReset'),
      });
      if (ok) send({ t: 'streak:reset', id: card.id });
    };
  }

  function updateStreakBody(body, card) {
    const days = Math.max(0, Math.floor((serverNow() - card.state.startAt) / 86400000));
    $('.js-days', body).innerHTML = `${days}<small>${esc(days === 1 ? t('day') : t('days'))}</small>`;
    const date = new Date(card.state.startAt).toLocaleDateString(
      lang === 'tr' ? 'tr-TR' : 'en-US',
      { day: 'numeric', month: 'long', year: 'numeric' }
    );
    $('.js-since', body).textContent = t('sinceStart', { date });
  }

  // ---- timer
  function renderTimerBody(body, card) {
    const running = card.state.running;
    body.innerHTML = `
      <div class="timer-display js-time ${running ? '' : 'paused'}"></div>
      ${running ? `<div class="sub-label"><span class="running-dot"></span>${esc(t('runningBy'))}</div>` : ''}
      <div class="card-actions">
        ${running
          ? `<button class="small-btn accent js-pause">⏸ ${esc(t('pause'))}</button>`
          : `<button class="small-btn accent js-start">▶ ${esc(t('start'))}</button>`}
        <button class="small-btn js-treset">${esc(t('reset'))}</button>
      </div>`;
    updateTimerBody(body, card);
    const startBtn = $('.js-start', body);
    if (startBtn) startBtn.onclick = () => send({ t: 'timer', id: card.id, op: 'start' });
    const pauseBtn = $('.js-pause', body);
    if (pauseBtn) pauseBtn.onclick = () => send({ t: 'timer', id: card.id, op: 'pause' });
    $('.js-treset', body).onclick = () => send({ t: 'timer', id: card.id, op: 'reset' });
  }

  function updateTimerBody(body, card) {
    const s = card.state;
    const elapsed = (s.accumulated || 0) + (s.running ? Math.max(0, serverNow() - s.startedAt) : 0);
    const total = Math.floor(elapsed / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    $('.js-time', body).textContent = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  // ---- countdown
  function renderCountdownBody(body, card) {
    body.innerHTML = `
      <div class="count-grid js-count"></div>
      <div class="sub-label js-target"></div>`;
    const target = card.config.targetAt || 0;
    const date = new Date(target).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    $('.js-target', body).textContent = date;
    updateCountdownBody(body, card);
  }

  function updateCountdownBody(body, card) {
    const target = card.config.targetAt || 0;
    const diff = target - serverNow();
    const grid = $('.js-count', body);
    if (!grid) return;
    if (diff <= 0) {
      grid.innerHTML = `<div class="big-number" style="font-size:1.8rem">${esc(t('countdownDone'))}</div>`;
      if (target && !countdownCelebrated.has(card.id)) {
        countdownCelebrated.add(card.id);
        confetti();
      }
      return;
    }
    const total = Math.floor(diff / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    const unit = (v, label) => `<div class="count-cell"><b>${v}</b><span>${label}</span></div>`;
    const dayLabel = lang === 'tr' ? 'gün' : 'days';
    grid.innerHTML =
      (d ? unit(d, dayLabel) : '') +
      unit(pad(h), lang === 'tr' ? 'saat' : 'hrs') +
      unit(pad(m), lang === 'tr' ? 'dk' : 'min') +
      unit(pad(s), lang === 'tr' ? 'sn' : 'sec');
  }

  // ticker for live displays
  setInterval(() => {
    if (!room) return;
    for (const card of cards.values()) {
      const el = $(`.card[data-id="${card.id}"] .card-body`);
      if (!el) continue;
      if (card.type === 'timer' && card.state.running) updateTimerBody(el, card);
      if (card.type === 'countdown') updateCountdownBody(el, card);
      if (card.type === 'streak') updateStreakBody(el, card);
    }
  }, 500);

  // ------------------------------------------------------------ card add/edit modal
  function openTypePicker() {
    const box = openModal(`
      <h2>${esc(t('newCardTitle'))}</h2>
      <div class="type-grid">
        ${Object.entries(TYPE_META)
          .map(
            ([type, meta]) => `
          <button class="type-btn" data-type="${type}">
            <span class="t-emoji">${meta.emoji}</span>
            <span class="t-name">${esc(t(meta.nameKey))}</span>
            <span class="t-desc">${esc(t(meta.descKey))}</span>
          </button>`
          )
          .join('')}
      </div>`);
    $$('.type-btn', box).forEach((btn) => {
      btn.onclick = () => openCardModal(btn.dataset.type, null);
    });
  }

  function openCardModal(type, existing) {
    const isEdit = !!existing;
    const meta = TYPE_META[type];
    let emoji = existing?.emoji || meta.emoji;

    const today = new Date();
    const toDateInput = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    let extraFields = '';
    if (type === 'tally') {
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldGoal'))}</label>
          <input id="cf-goal" type="number" min="0" max="100000" placeholder="${esc(t('fieldGoalPh'))}"
            value="${existing?.config?.goal || ''}">
        </div>`;
    }
    if (type === 'streak') {
      const startVal = existing ? toDateInput(new Date(existing.state.startAt)) : toDateInput(today);
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldStartDate'))}</label>
          <input id="cf-start" type="date" value="${startVal}" max="${toDateInput(today)}">
        </div>`;
    }
    if (type === 'countdown') {
      let targetVal = '';
      if (existing?.config?.targetAt) {
        const d = new Date(existing.config.targetAt);
        targetVal = `${toDateInput(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldTargetDate'))}</label>
          <input id="cf-target" type="datetime-local" value="${targetVal}">
        </div>`;
    }
    if (type === 'note' && !isEdit) {
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldNote'))}</label>
          <textarea id="cf-note" maxlength="500" placeholder="${esc(t('fieldNotePh'))}"></textarea>
        </div>`;
    }

    const box = openModal(`
      <h2>${meta.emoji} ${esc(isEdit ? t('editCardTitle') : t(meta.nameKey))}</h2>
      <div class="field">
        <label>${esc(t('fieldTitle'))}</label>
        <input id="cf-title" type="text" maxlength="60" placeholder="${esc(t('fieldTitlePh'))}"
          value="${esc(existing?.title || '')}" autocomplete="off">
      </div>
      <div class="field">
        <label>${esc(t('fieldEmoji'))}</label>
        <div class="emoji-row">
          ${EMOJIS.map((e) => `<button type="button" class="emoji-opt ${e === emoji ? 'selected' : ''}" data-e="${e}">${e}</button>`).join('')}
        </div>
      </div>
      ${extraFields}
      <div class="modal-actions">
        ${isEdit ? '' : `<button class="btn btn-ghost js-back">${esc(t('back'))}</button>`}
        <button class="btn btn-ghost js-cancel">${esc(t('cancel'))}</button>
        <button class="btn btn-primary js-save">${esc(isEdit ? t('save') : t('create'))}</button>
      </div>`);

    $$('.emoji-opt', box).forEach((btn) => {
      btn.onclick = () => {
        emoji = btn.dataset.e;
        $$('.emoji-opt', box).forEach((b) => b.classList.toggle('selected', b === btn));
      };
    });

    const backBtn = $('.js-back', box);
    if (backBtn) backBtn.onclick = () => openTypePicker();
    $('.js-cancel', box).onclick = closeModal;

    $('.js-save', box).onclick = () => {
      const title = $('#cf-title', box).value.trim();
      if (!title) return $('#cf-title', box).focus();
      const config = {};
      if (type === 'tally') config.goal = parseInt($('#cf-goal', box)?.value) || 0;
      if (type === 'streak') {
        const v = $('#cf-start', box)?.value;
        if (v) {
          const [y, mo, d] = v.split('-').map(Number);
          config.startAt = new Date(y, mo - 1, d).getTime();
        }
      }
      if (type === 'countdown') {
        const v = $('#cf-target', box)?.value;
        if (!v) return $('#cf-target', box).focus();
        config.targetAt = new Date(v).getTime();
        countdownCelebrated.delete(existing?.id);
      }
      if (type === 'note' && !isEdit) {
        config.text = $('#cf-note', box)?.value.trim() || '';
      }
      if (isEdit) {
        send({ t: 'card:edit', id: existing.id, title, emoji, config });
      } else {
        send({ t: 'card:add', card: { type, title, emoji, config } });
      }
      closeModal();
    };

    setTimeout(() => $('#cf-title', box)?.focus(), 60);
  }

  // ------------------------------------------------------------ room init
  async function initRoom() {
    $('#view-room').hidden = false;

    identity = await ensureIdentity();
    connect();

    $('#fab-add').onclick = openTypePicker;
    $('#fab-love').onclick = () => send({ t: 'cheer', kind: 'hearts' });

    $('#copy-link').onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.origin + '/r/' + encodeURIComponent(room.code));
        toast(t('linkCopied'));
      } catch {
        prompt('', location.origin + '/r/' + encodeURIComponent(room.code));
      }
    };

    $('#rename-btn').onclick = () => {
      const box = openModal(`
        <h2>${esc(t('renameRoom'))} ✏️</h2>
        <div class="field">
          <input id="rn-input" type="text" maxlength="40" value="${esc(room?.name || '')}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost js-cancel">${esc(t('cancel'))}</button>
          <button class="btn btn-primary js-save">${esc(t('save'))}</button>
        </div>`);
      $('.js-cancel', box).onclick = closeModal;
      const doSave = () => {
        const name = $('#rn-input', box).value.trim();
        if (name) send({ t: 'room:rename', name });
        closeModal();
      };
      $('.js-save', box).onclick = doSave;
      $('#rn-input', box).addEventListener('keydown', (e) => e.key === 'Enter' && doSave());
      setTimeout(() => $('#rn-input', box)?.focus(), 60);
    };
  }

  // intercept my own actions for cheer effects + capture my id from 'room'
  const _handleServer = handleServer;
  handleServer = (msg) => {
    if (msg.t === 'room') myId = msg.you;
    if (msg.t === 'card:update' && msg.by?.id && msg.by.id === myId) {
      if (msg.verb === 'tally+') {
        randomCheer(false);
        if (navigator.vibrate) navigator.vibrate(12);
        const goal = msg.card.config?.goal;
        if (goal && msg.card.state.count === goal) confetti();
      }
      if (msg.verb === 'tally-') randomCheer(true);
    } else if (msg.t === 'card:update' && msg.verb === 'tally+') {
      // someone else's +1 — everyone celebrates goal completion
      const goal = msg.card.config?.goal;
      if (goal && msg.card.state.count === goal) confetti();
    }
    _handleServer(msg);
  };

  // ------------------------------------------------------------ boot
  buildSky();
  applyI18n();
  if (roomCode) initRoom();
  else initLanding();
})();
