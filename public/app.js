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
    renderIntro();
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
    money: { emoji: '💰', nameKey: 'typeMoney', descKey: 'typeMoneyDesc' },
    list: { emoji: '📝', nameKey: 'typeList', descKey: 'typeListDesc' },
    checkin: { emoji: '🤝', nameKey: 'typeCheckin', descKey: 'typeCheckinDesc' },
  };

  // ---- shared day helpers (local calendar, so "today" matches your phone)
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDay = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dayBefore = (n) => localDay(new Date(Date.now() - n * 86400000));

  const myKey = () => auth?.user?.id || myCid;

  function checkinComplete(state, mode, day) {
    const rec = state.days?.[day];
    if (!rec) return false;
    const people = Object.keys(state.people || {});
    if (!people.length) return false;
    if (mode === 'any') return Object.keys(rec).length > 0;
    return people.every((k) => rec[k]);
  }

  function checkinStreak(state, mode) {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (checkinComplete(state, mode, dayBefore(i))) n++;
      else if (i === 0) continue; // today may still be in progress
      else break;
    }
    return n;
  }

  // ------------------------------------------------------------ account
  let auth = JSON.parse(localStorage.getItem('ct:auth') || 'null'); // { token, user }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth?.token ? { Authorization: 'Bearer ' + auth.token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'request-failed'), { code: data.error });
    return data;
  }

  function setAuth(next) {
    auth = next;
    if (next) localStorage.setItem('ct:auth', JSON.stringify(next));
    else localStorage.removeItem('ct:auth');
  }

  // stable per-browser id: lets the server skip push notifications to yourself
  let myCid = localStorage.getItem('ct:cid');
  if (!myCid) {
    myCid = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    localStorage.setItem('ct:cid', myCid);
  }

  const fmtNum = (n) => Number(n || 0).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');

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
  let accountRooms = null; // server-side room list when signed in

  function renderRecents() {
    const wrap = $('#recent-rooms');
    if (!wrap) return;
    const signedIn = !!auth;
    const rooms = signedIn
      ? accountRooms || []
      : JSON.parse(localStorage.getItem('ct:recent') || '[]');

    $('#recent-rooms h3').textContent = signedIn ? t('yourRooms') : t('recentTitle');
    const list = $('#recent-list');
    list.innerHTML = '';
    wrap.hidden = !signedIn && rooms.length === 0;

    if (signedIn && rooms.length === 0) {
      list.innerHTML = `<span class="sub-label">${esc(t('noAccountRooms'))}</span>`;
      return;
    }
    for (const r of rooms) {
      const a = document.createElement('a');
      a.className = 'chip chip-btn';
      a.href = '/r/' + encodeURIComponent(r.code);
      a.innerHTML = `${esc(r.name)}&nbsp;<small>${esc(r.code)}</small>`;
      list.appendChild(a);
    }
  }

  function renderAccountBtn() {
    const btn = $('#account-btn');
    if (!btn) return;
    btn.textContent = auth ? `${auth.user.avatar} ${auth.user.name}` : `👤 ${t('signIn')}`;
  }

  async function refreshAccount() {
    if (!auth) return;
    try {
      const me = await api('/api/auth/me');
      setAuth({ token: auth.token, user: me.user });
      accountRooms = me.rooms;
    } catch (err) {
      if (err.code === 'unauthorized') setAuth(null); // expired session
    }
    renderAccountBtn();
    renderRecents();
  }

  function openAccountModal(mode = auth ? 'profile' : 'signin') {
    if (mode === 'profile' && auth) {
      const box = openModal(`
        <h2>${esc(t('accountTitle'))}</h2>
        <p class="tour-body">${esc(t('helloUser', { name: auth.user.name }))} <span style="font-size:1.4rem">${esc(auth.user.avatar)}</span></p>
        <p class="sub-label" style="margin-top:10px">@${esc(auth.user.username)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost js-out">${esc(t('signOut'))}</button>
          <button class="btn btn-primary js-close">${esc(t('cancel'))}</button>
        </div>`);
      $('.js-close', box).onclick = closeModal;
      $('.js-out', box).onclick = async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* token already gone */ }
        setAuth(null);
        accountRooms = null;
        closeModal();
        renderAccountBtn();
        renderRecents();
        toast(t('signedOut'));
      };
      return;
    }

    const isUp = mode === 'signup';
    let avatar = AVATARS[0];
    const box = openModal(`
      <h2>${esc(isUp ? t('signUp') : t('signIn'))} 🌙</h2>
      <p class="sub-label" style="margin-bottom:16px">${esc(t('accountWhy'))}</p>
      <div class="field">
        <label>${esc(t('username'))}</label>
        <input id="au-user" type="text" maxlength="24" autocomplete="username"
          placeholder="${esc(t('usernamePh'))}" spellcheck="false">
      </div>
      <div class="field">
        <label>${esc(t('password'))}</label>
        <input id="au-pass" type="password" maxlength="100"
          autocomplete="${isUp ? 'new-password' : 'current-password'}" placeholder="${esc(t('passwordPh'))}">
      </div>
      ${isUp
        ? `<div class="field">
             <label>${esc(t('displayName'))}</label>
             <input id="au-name" type="text" maxlength="24" placeholder="${esc(t('namePlaceholder'))}">
           </div>
           <div class="field">
             <label>${esc(t('pickAvatar'))}</label>
             <div class="emoji-row avatar-row">
               ${AVATARS.map((a) => `<button type="button" class="emoji-opt av-opt ${a === avatar ? 'selected' : ''}" data-a="${a}">${a}</button>`).join('')}
             </div>
           </div>`
        : ''}
      <p class="auth-error" hidden></p>
      <div class="modal-actions">
        <button class="btn btn-ghost js-swap">${esc(isUp ? t('signIn') : t('signUp'))}</button>
        <button class="btn btn-primary js-go">${esc(isUp ? t('signUp') : t('signIn'))}</button>
      </div>
      <p class="sub-label" style="margin-top:14px">${esc(t('guestNote'))}</p>`);

    $$('.av-opt', box).forEach((b) => {
      b.onclick = () => {
        avatar = b.dataset.a;
        $$('.av-opt', box).forEach((x) => x.classList.toggle('selected', x === b));
      };
    });

    $('.js-swap', box).onclick = () => openAccountModal(isUp ? 'signin' : 'signup');

    const errEl = $('.auth-error', box);
    const fail = (key) => {
      errEl.textContent = t(key);
      errEl.hidden = false;
    };

    const submit = async () => {
      const username = $('#au-user', box).value.trim().toLowerCase();
      const password = $('#au-pass', box).value;
      if (!username || !password) return;
      const goBtn = $('.js-go', box);
      goBtn.disabled = true;
      try {
        const data = isUp
          ? await api('/api/auth/register', {
              method: 'POST',
              body: { username, password, name: $('#au-name', box).value.trim() || username, avatar },
            })
          : await api('/api/auth/login', { method: 'POST', body: { username, password } });
        setAuth({ token: data.token, user: data.user });
        accountRooms = data.rooms || [];
        // an account's identity wins over any nickname saved on this device
        localStorage.setItem('ct:name', data.user.name);
        localStorage.setItem('ct:avatar', data.user.avatar);
        closeModal();
        renderAccountBtn();
        renderRecents();
        toast(t('welcomeBack'));
      } catch (err) {
        const map = {
          'username-taken': 'errUsernameTaken',
          'bad-username': 'errBadUsername',
          'short-password': 'errShortPassword',
          'bad-credentials': 'errBadCredentials',
        };
        fail(map[err.code] || 'errNetwork');
        goBtn.disabled = false;
      }
    };

    $('.js-go', box).onclick = submit;
    ['#au-user', '#au-pass', '#au-name'].forEach((sel) => {
      $(sel, box)?.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    });
    setTimeout(() => $('#au-user', box)?.focus(), 60);
  }

  function rememberRoom(code, name) {
    let recents = JSON.parse(localStorage.getItem('ct:recent') || '[]');
    recents = recents.filter((r) => r.code !== code);
    recents.unshift({ code, name, ts: Date.now() });
    localStorage.setItem('ct:recent', JSON.stringify(recents.slice(0, 6)));
  }

  const PERKS = [
    { emoji: '⚡', k: 'perkLive' },
    { emoji: '💬', k: 'perkChat' },
    { emoji: '🔔', k: 'perkPush' },
    { emoji: '🌙', k: 'perkFree' },
  ];

  function renderIntro() {
    const cardsEl = $('#intro-cards');
    if (!cardsEl) return;
    cardsEl.innerHTML = Object.entries(TYPE_META)
      .map(
        ([type, meta]) => `
        <div class="intro-card card--${type}">
          <span class="ic-emoji">${meta.emoji}</span>
          <div>
            <b>${esc(t(meta.nameKey))}</b>
            <span>${esc(t(meta.descKey))}</span>
          </div>
        </div>`
      )
      .join('');

    $('#intro-perks').innerHTML = PERKS.map(
      (p) => `
      <div class="perk">
        <span class="p-emoji">${p.emoji}</span>
        <div>
          <b>${esc(t(p.k))}</b>
          <span>${esc(t(p.k + 'Desc'))}</span>
        </div>
      </div>`
    ).join('');
  }

  function initLanding() {
    $('#view-landing').hidden = false;
    renderAccountBtn();
    renderRecents();
    renderIntro();
    refreshAccount();
    $('#account-btn').onclick = () => openAccountModal();

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
      // signed-in members carry their account identity everywhere
      if (auth) return resolve({ name: auth.user.name, avatar: auth.user.avatar });
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
      ws.send(JSON.stringify({
        t: 'join',
        room: roomCode,
        name: identity.name,
        avatar: identity.avatar,
        cid: myCid,
        token: auth?.token,
      }));
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
        chatMsgs = msg.chat || [];
        rememberRoom(room.code, room.name);
        renderRoomHeader();
        renderMembers(msg.members);
        renderAllCards();
        renderChat();
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

      case 'chat:new': {
        chatMsgs.push(msg.msg);
        if (chatMsgs.length > 200) chatMsgs.shift();
        appendChatMsg(msg.msg, true);
        if (!chatOpen && msg.msg.cid !== myCid) {
          chatUnread++;
          updateChatBadge();
          toast(`${msg.msg.author}: ${msg.msg.photo ? '📷 ' : ''}${msg.msg.text.slice(0, 42)}`);
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
        // everyone celebrates when the piggy bank crosses its goal
        if (msg.verb === 'money+' && msg.card.config.goal) {
          const before = prev?.state?.total || 0;
          const after = msg.card.state.total || 0;
          if (before < msg.card.config.goal && after >= msg.card.config.goal) {
            confetti();
            centerCheer(t('moneyReached'));
          }
        }
        updateEmptyHint();
        return;
      }

      case 'card:delete':
        cards.delete(msg.id);
        $(`.card[data-id="${msg.id}"]`)?.remove();
        if (msg.by?.id !== myId) toast(t('toastCardDelete', { name: msg.by.name, card: msg.title }));
        updateEmptyHint();
        return;

      case 'list:done':
        confetti();
        centerCheer(t('toastListAllDone', { card: msg.title }));
        return;

      case 'checkin:done':
        confetti();
        centerCheer(t('dayComplete', { n: msg.streak }));
        return;

      case 'checkin:cover':
        heartsRain();
        centerCheer(t('coveredCheer', { name: msg.by }));
        return;

      case 'cheer':
        heartsRain();
        if (msg.by?.id !== myId) toast(t('toastHearts', { name: msg.by.name }));
        return;
    }
  }

  let myId = null;
  let chatMsgs = [];
  let chatOpen = false;
  let chatUnread = 0;

  function handleCardToasts(msg) {
    const { by, verb, card } = msg;
    if (!by || by.id === myId) return; // own actions get cheers, not toasts
    const vars = { name: by.name, card: card.title };
    if (verb === 'money+' || verb === 'money-') {
      const last = card.state.log?.[0];
      const amt = fmtNum(Math.abs(last?.a || 0)) + (card.config.cur || '₺');
      toast(t(verb === 'money+' ? 'toastMoneyPlus' : 'toastMoneyMinus', { ...vars, amt }));
      return;
    }
    const map = {
      'tally+': 'toastTallyPlus',
      'tally-': 'toastTallyMinus',
      'timer:start': 'toastTimerStart',
      'timer:pause': 'toastTimerPause',
      'timer:reset': 'toastTimerReset',
      'streak:reset': 'toastStreakReset',
      'card:add': 'toastCardAdd',
      'note:set': 'toastNote',
      'list:add': 'toastListAdd',
      'list:toggle': 'toastListDone',
      'checkin:tick': 'toastCheckin',
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

    // A card re-renders whenever anyone touches it. Don't yank the text out
    // from under someone who is mid-typing in this card's input.
    const typing = el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
      ? { cls: document.activeElement.className, value: document.activeElement.value }
      : null;

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
    if (card.type === 'money') renderMoneyBody(body, card, opts);
    if (card.type === 'list') renderListBody(body, card);
    if (card.type === 'checkin') renderCheckinBody(body, card);

    if (typing) {
      const again = el.querySelector('input.' + typing.cls.trim().split(/\s+/).join('.'));
      if (again) {
        again.value = typing.value;
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }
    return el;
  }

  // ---- together check-in
  function renderCheckinBody(body, card) {
    const state = card.state || {};
    const mode = card.config.mode || 'all';
    const today = localDay();
    const people = state.people || {};
    const todayRec = state.days?.[today] || {};
    const me = myKey();
    const myRec = todayRec[me];
    const iTicked = !!myRec;
    const coveredForMe = myRec?.coveredBy || '';
    const streak = checkinStreak(state, mode);
    const others = Object.entries(people).filter(([k]) => k !== me);
    const days7 = Array.from({ length: 7 }, (_, i) => dayBefore(6 - i));
    const dayNames = lang === 'tr'
      ? ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct']
      : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    body.innerHTML = `
      <div class="streak-hero">
        <span class="streak-flame ${streak ? 'lit' : ''}">${streak ? '🔥' : '🌱'}</span>
        <span class="big-number">${streak}</span>
      </div>
      <div class="sub-label">${esc(t('ourStreak'))} · ${esc(t(mode === 'any' ? 'modeAnyShort' : 'modeAllShort'))}</div>

      <button class="small-btn ${iTicked ? '' : 'accent'} js-tick" ${coveredForMe ? 'disabled' : ''}>
        ${coveredForMe
          ? `🧣 ${esc(t('coveredForYou', { name: coveredForMe }))}`
          : iTicked
            ? `✓ ${esc(t('tickedToday'))}`
            : esc(t('tickToday'))}
      </button>

      ${others.length
        ? `<div class="peep-row">
            ${others
              .map(([k, p]) => {
                const rec = todayRec[k];
                const covered = rec?.coveredBy;
                return `<div class="peep ${rec ? 'on' : ''}" title="${esc(p.name)}">
                  <span class="peep-av">${esc(p.avatar || '🐻')}</span>
                  <span class="peep-name">${esc(p.name)}</span>
                  ${rec
                    ? `<span class="peep-state">${covered ? `🧣 ${esc(covered)}` : '✓'}</span>`
                    : `<button class="cover-btn js-cover" data-key="${esc(k)}"
                         ${(state.tokens || 0) > 0 ? '' : 'disabled'}>🧣</button>`}
                </div>`;
              })
              .join('')}
          </div>`
        : `<div class="sub-label">${esc(t('waitingForOthers'))}</div>`}

      <div class="week-grid">
        ${days7
          .map((d) => {
            const done = checkinComplete(state, mode, d);
            const partial = !done && state.days?.[d];
            const wd = dayNames[new Date(d + 'T12:00:00').getDay()];
            return `<div class="wk-cell ${done ? 'done' : partial ? 'partial' : ''}">
              <span class="wk-dot"></span><span class="wk-day">${wd}</span>
            </div>`;
          })
          .join('')}
      </div>

      <div class="sub-label checkin-foot">
        🧣 ${esc(t('tokensLeft', { n: state.tokens ?? 0 }))}${state.best ? ` · 🏆 ${esc(t('bestStreak', { n: state.best }))}` : ''}
      </div>`;

    $('.js-tick', body).onclick = () => {
      if (coveredForMe) return; // someone gifted this day; not yours to undo
      send({ t: 'checkin', id: card.id, op: iTicked ? 'untick' : 'tick', day: today });
      if (!iTicked && navigator.vibrate) navigator.vibrate(12);
    };

    $$('.js-cover', body).forEach((btn) => {
      btn.onclick = async () => {
        const person = people[btn.dataset.key];
        const ok = await confirmModal({
          title: t('coverTitle'),
          body: t('coverBody', { name: person?.name || '' }),
          yesLabel: t('coverYes'),
          danger: false,
        });
        if (ok) send({ t: 'checkin', id: card.id, op: 'cover', forKey: btn.dataset.key, day: today });
      };
    });
  }

  // ---- checklist
  function renderListBody(body, card) {
    const items = card.state.items || [];
    const done = items.filter((i) => i.done).length;
    const allDone = items.length > 0 && done === items.length;

    body.innerHTML = `
      ${items.length
        ? `<div class="goal-bar"><div class="goal-fill" style="width:${(done / items.length) * 100}%"></div></div>
           <div class="sub-label">${allDone ? esc(t('listAllDone')) : esc(t('listProgress', { done, total: items.length }))}</div>`
        : ''}
      <ul class="check-list">
        ${items
          .map(
            (i) => `
          <li class="check-item ${i.done ? 'done' : ''}" data-id="${esc(i.id)}">
            <button class="check-box">${i.done ? '✓' : ''}</button>
            <span class="check-text">${esc(i.text)}</span>
            ${i.done && i.doneBy ? `<span class="check-by">${esc(i.doneBy)}</span>` : ''}
            <button class="check-del icon-btn">✕</button>
          </li>`
          )
          .join('')}
      </ul>
      <form class="list-add">
        <input type="text" maxlength="120" class="js-item" placeholder="${esc(t('listAddPh'))}" autocomplete="off">
        <button type="submit" class="small-btn accent">+</button>
      </form>
      ${done ? `<button class="small-btn js-clear-done">${esc(t('clearDone'))}</button>` : ''}`;

    $$('.check-item', body).forEach((li) => {
      const itemId = li.dataset.id;
      $('.check-box', li).onclick = () => send({ t: 'list', id: card.id, op: 'toggle', itemId });
      $('.check-text', li).onclick = () => send({ t: 'list', id: card.id, op: 'toggle', itemId });
      $('.check-del', li).onclick = () => send({ t: 'list', id: card.id, op: 'remove', itemId });
    });

    $('.list-add', body).addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('.js-item', body);
      const text = input.value.trim();
      if (!text) return;
      send({ t: 'list', id: card.id, op: 'add', text });
      input.value = '';
      input.focus();
    });

    const clearBtn = $('.js-clear-done', body);
    if (clearBtn) clearBtn.onclick = () => send({ t: 'list', id: card.id, op: 'clear-done' });
  }

  // ---- money pot
  function renderMoneyBody(body, card, opts = {}) {
    const total = card.state.total || 0;
    const goal = card.config.goal || 0;
    const cur = card.config.cur || '₺';
    const pct = goal ? (total / goal) * 100 : 0;

    const milestones = goal
      ? `<div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, pct)}%"></div></div>
         <div class="milestones">${[25, 50, 75, 100]
           .map((m) => `<div class="milestone ${pct >= m ? 'reached' : ''}">
             <span class="ms-star">${pct >= m ? '⭐' : '☆'}</span>${lang === 'tr' ? '%' + m : m + '%'}
           </div>`)
           .join('')}</div>
         <div class="sub-label">${total >= goal
           ? esc(t('moneyReached'))
           : esc(t('moneyLeft', { n: fmtNum(goal - total) + cur }))} · ${esc(t('goal', { n: fmtNum(goal) + cur }))}</div>`
      : '';

    const log = (card.state.log || []).slice(0, 4)
      .map((e) => `<div><span class="${e.a > 0 ? 'm-in' : 'm-out'}">${e.a > 0 ? '+' : '−'}${fmtNum(Math.abs(e.a))}${esc(cur)}</span> — ${esc(e.by)}</div>`)
      .join('');

    body.innerHTML = `
      ${card.config.photo ? `<img class="money-photo" src="${esc(card.config.photo)}" alt="">` : ''}
      <div class="money-total">${fmtNum(total)}<small>${esc(cur)}</small></div>
      ${milestones}
      <div class="money-form">
        <input type="number" inputmode="numeric" class="money-input js-amt" placeholder="${esc(t('amountPh'))}">
        <button class="round-btn plus js-madd">+</button>
        <button class="round-btn minus js-msub">−</button>
      </div>
      ${log ? `<div class="money-log">${log}</div>` : ''}`;

    const photoEl = $('.money-photo', body);
    if (photoEl) photoEl.onclick = () => openLightbox(card.config.photo);

    const amtInput = $('.js-amt', body);
    const sendAmount = (sign) => {
      const v = Math.round(Math.abs(Number(amtInput.value)));
      if (!v) return amtInput.focus();
      send({ t: 'money', id: card.id, amount: sign * v });
      amtInput.value = '';
    };
    $('.js-madd', body).onclick = () => sendAmount(1);
    $('.js-msub', body).onclick = () => sendAmount(-1);
    amtInput.addEventListener('keydown', (e) => e.key === 'Enter' && sendAmount(1));

    if (opts.verb === 'money+') coinRain(body.closest('.card'));
    if (opts.verb === 'money-') sparklesAt(body.closest('.card'));
  }

  function coinRain(cardEl) {
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    for (let i = 0; i < 7; i++) {
      const c = document.createElement('div');
      c.className = 'coin-fx';
      c.textContent = '🪙';
      c.style.left = rect.left + 14 + Math.random() * (rect.width - 28) + 'px';
      c.style.top = rect.top + 8 + 'px';
      c.style.animationDelay = (Math.random() * 0.35).toFixed(2) + 's';
      c.style.fontSize = 16 + Math.random() * 12 + 'px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 1600);
    }
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
  const PACKS = {
    trip: { emoji: '🏖️', nameKey: 'packTrip', descKey: 'packTripDesc' },
    move: { emoji: '📦', nameKey: 'packMove', descKey: 'packMoveDesc' },
    health: { emoji: '💪', nameKey: 'packHealth', descKey: 'packHealthDesc' },
  };

  function openTypePicker() {
    const box = openModal(`
      <h2>${esc(t('newCardTitle'))}</h2>
      <h3 class="pack-head">${esc(t('packsTitle'))}</h3>
      <div class="pack-grid">
        ${Object.entries(PACKS)
          .map(
            ([key, p]) => `
          <button class="pack-btn" data-pack="${key}">
            <span class="p-emoji">${p.emoji}</span>
            <span>
              <b>${esc(t(p.nameKey))}</b>
              <small>${esc(t(p.descKey))}</small>
            </span>
          </button>`
          )
          .join('')}
      </div>
      <h3 class="pack-head">${esc(t('orSingleCard'))}</h3>
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
    $$('.pack-btn', box).forEach((btn) => {
      btn.onclick = () => openPackModal(btn.dataset.pack);
    });
  }

  // ---- ready-made packs: create several linked cards in one go
  function openPackModal(pack) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const inTwoMonths = new Date(today.getTime() + 60 * 86400000);
    const dateVal = `${inTwoMonths.getFullYear()}-${pad(inTwoMonths.getMonth() + 1)}-${pad(inTwoMonths.getDate())}T09:00`;

    const cfg = {
      trip: { emoji: '🏖️', titleKey: 'tripSetup', nameLabel: 'tripName', namePh: 'tripNamePh', dateLabel: 'tripDate', budget: true },
      move: { emoji: '📦', titleKey: 'packMove', nameLabel: 'tripName', namePh: 'tripNamePh', dateLabel: 'tripDate', budget: true },
      health: { emoji: '💪', titleKey: 'packHealth', nameLabel: 'fieldTitle', namePh: 'fieldTitlePh', dateLabel: null, budget: false },
    }[pack];

    const box = openModal(`
      <h2>${cfg.emoji} ${esc(t(cfg.titleKey))}</h2>
      <div class="field">
        <label>${esc(t(cfg.nameLabel))}</label>
        <input id="pk-name" type="text" maxlength="40" placeholder="${esc(t(cfg.namePh))}" autocomplete="off">
      </div>
      ${cfg.dateLabel
        ? `<div class="field">
             <label>${esc(t(cfg.dateLabel))}</label>
             <input id="pk-date" type="datetime-local" value="${dateVal}">
           </div>`
        : ''}
      ${cfg.budget
        ? `<div class="field">
             <label>${esc(t('tripBudget'))}</label>
             <input id="pk-budget" type="number" inputmode="numeric" min="0" placeholder="${esc(t('fieldGoalPh'))}">
           </div>`
        : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost js-back">${esc(t('back'))}</button>
        <button class="btn btn-primary js-create">${esc(t('createPack'))}</button>
      </div>`);

    $('.js-back', box).onclick = openTypePicker;
    $('.js-create', box).onclick = () => {
      const name = $('#pk-name', box).value.trim();
      if (!name) return $('#pk-name', box).focus();
      const dateEl = $('#pk-date', box);
      const budget = Math.max(0, Math.round(Number($('#pk-budget', box)?.value))) || 0;
      const targetAt = dateEl?.value ? new Date(dateEl.value).getTime() : 0;

      const add = (card) => send({ t: 'card:add', card });

      if (pack === 'trip' || pack === 'move') {
        if (targetAt) {
          add({
            type: 'countdown',
            title: t('tripCountdown', { name }),
            emoji: pack === 'trip' ? '✈️' : '📦',
            config: { targetAt },
          });
        }
        if (budget) {
          add({
            type: 'money',
            title: t('tripFund', { name }),
            emoji: '💰',
            config: { goal: budget, cur: '₺' },
          });
        }
        add({
          type: 'list',
          title: t('tripChecklist', { name }),
          emoji: '📝',
          config: { items: t(pack === 'trip' ? 'tripItems' : 'moveItems') },
        });
      } else {
        add({ type: 'tally', title: `${name} 💧`, emoji: '💧', config: { goal: 8 } });
        add({ type: 'streak', title: name, emoji: '💪', config: { startAt: Date.now() } });
        add({ type: 'list', title: name, emoji: '📝', config: { items: [] } });
      }
      closeModal();
    };

    setTimeout(() => $('#pk-name', box)?.focus(), 60);
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
    if (type === 'checkin') {
      const modeNow = existing?.config?.mode || 'all';
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldMode'))}</label>
          <div class="mode-row">
            ${['all', 'any']
              .map(
                (m) => `<button type="button" class="mode-opt ${m === modeNow ? 'selected' : ''}" data-m="${m}">
                  <b>${esc(t(m === 'all' ? 'modeAll' : 'modeAny'))}</b>
                  <span>${esc(t(m === 'all' ? 'modeAllDesc' : 'modeAnyDesc'))}</span>
                </button>`
              )
              .join('')}
          </div>
        </div>`;
    }
    if (type === 'note' && !isEdit) {
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldNote'))}</label>
          <textarea id="cf-note" maxlength="500" placeholder="${esc(t('fieldNotePh'))}"></textarea>
        </div>`;
    }

    if (type === 'money') {
      const curs = ['₺', '$', '€', '£'];
      const curNow = existing?.config?.cur || '₺';
      extraFields = `
        <div class="field">
          <label>${esc(t('fieldMoneyGoal'))}</label>
          <input id="cf-mgoal" type="number" inputmode="numeric" min="0" placeholder="${esc(t('fieldGoalPh'))}"
            value="${existing?.config?.goal || ''}">
        </div>
        <div class="field">
          <label>${esc(t('fieldCurrency'))}</label>
          <div class="emoji-row">
            ${curs.map((c) => `<button type="button" class="emoji-opt cur-opt ${c === curNow ? 'selected' : ''}" data-c="${c}">${c}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>${esc(t('fieldMoneyPhoto'))}</label>
          <button type="button" class="small-btn js-mphoto">📷 ${esc(t('choosePhoto'))}</button>
          <input type="file" class="js-mfile" accept="image/*" hidden>
          <img class="js-mpreview money-photo" style="margin-top:10px; ${existing?.config?.photo ? '' : 'display:none'}"
            src="${esc(existing?.config?.photo || '')}" alt="">
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

    $$('.emoji-opt[data-e]', box).forEach((btn) => {
      btn.onclick = () => {
        emoji = btn.dataset.e;
        $$('.emoji-opt[data-e]', box).forEach((b) => b.classList.toggle('selected', b === btn));
      };
    });

    let mode = existing?.config?.mode || 'all';
    $$('.mode-opt', box).forEach((btn) => {
      btn.onclick = () => {
        mode = btn.dataset.m;
        $$('.mode-opt', box).forEach((b) => b.classList.toggle('selected', b === btn));
      };
    });

    // money extras: currency picker + goal photo
    let cur = existing?.config?.cur || '₺';
    let photoFile = null;
    $$('.cur-opt', box).forEach((btn) => {
      btn.onclick = () => {
        cur = btn.dataset.c;
        $$('.cur-opt', box).forEach((b) => b.classList.toggle('selected', b === btn));
      };
    });
    const mPhotoBtn = $('.js-mphoto', box);
    if (mPhotoBtn) {
      const fileInput = $('.js-mfile', box);
      mPhotoBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        photoFile = fileInput.files[0] || null;
        if (photoFile) {
          const prev = $('.js-mpreview', box);
          prev.src = URL.createObjectURL(photoFile);
          prev.style.display = '';
        }
      };
    }

    const backBtn = $('.js-back', box);
    if (backBtn) backBtn.onclick = () => openTypePicker();
    $('.js-cancel', box).onclick = closeModal;

    $('.js-save', box).onclick = async () => {
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
      if (type === 'checkin') config.mode = mode;
      if (type === 'note' && !isEdit) {
        config.text = $('#cf-note', box)?.value.trim() || '';
      }
      if (type === 'money') {
        config.goal = Math.max(0, Math.round(Number($('#cf-mgoal', box)?.value))) || 0;
        config.cur = cur;
        if (existing?.config?.photo) config.photo = existing.config.photo;
        if (photoFile) {
          const saveBtn = $('.js-save', box);
          saveBtn.disabled = true;
          saveBtn.textContent = '⏳';
          try {
            config.photo = await uploadPhoto(photoFile);
          } catch {
            toast(t('photoFailed'));
            saveBtn.disabled = false;
            saveBtn.textContent = isEdit ? t('save') : t('create');
            return;
          }
        }
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

  // ------------------------------------------------------------ photos
  async function processImage(file) {
    if (file.type === 'image/gif') {
      if (file.size > 6 * 1024 * 1024) throw new Error('too-big');
      return file;
    }
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode-failed');
    return blob;
  }

  async function uploadPhoto(file) {
    const blob = await processImage(file);
    if (blob.size > 6 * 1024 * 1024) {
      toast(t('photoTooBig'));
      throw new Error('too-big');
    }
    const res = await fetch('/api/upload/' + encodeURIComponent(room.code), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) throw new Error('upload-failed');
    return (await res.json()).url;
  }

  function openLightbox(url) {
    openModal(`<img class="lightbox-img" src="${esc(url)}" alt="">`);
  }

  // ------------------------------------------------------------ chat
  function updateChatBadge() {
    const badge = $('#chat-badge');
    badge.hidden = chatUnread === 0;
    badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
  }

  function chatMsgEl(m) {
    const el = document.createElement('div');
    el.className = 'msg' + (m.cid === myCid ? ' mine' : '');
    const time = new Date(m.createdAt).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    el.innerHTML = `
      <div class="msg-meta">${esc(m.avatar || '')} ${esc(m.author)} · ${time}</div>
      <div class="msg-bubble">${esc(m.text)}${m.photo ? `<img class="msg-photo" src="${esc(m.photo)}" alt="" loading="lazy">` : ''}</div>`;
    const img = $('.msg-photo', el);
    if (img) img.onclick = () => openLightbox(m.photo);
    return el;
  }

  function renderChat() {
    const list = $('#chat-list');
    list.innerHTML = '';
    if (!chatMsgs.length) {
      list.innerHTML = `<div class="chat-empty">${esc(t('chatEmpty'))}</div>`;
      return;
    }
    for (const m of chatMsgs) list.appendChild(chatMsgEl(m));
    list.scrollTop = list.scrollHeight;
  }

  function appendChatMsg(m) {
    const list = $('#chat-list');
    $('.chat-empty', list)?.remove();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
    list.appendChild(chatMsgEl(m));
    if (nearBottom || m.cid === myCid) list.scrollTop = list.scrollHeight;
  }

  function setChatOpen(open) {
    chatOpen = open;
    $('#chat-drawer').classList.toggle('open', open);
    $('#chat-scrim').classList.toggle('open', open);
    if (open) {
      chatUnread = 0;
      updateChatBadge();
      const list = $('#chat-list');
      list.scrollTop = list.scrollHeight;
      $('#chat-input').focus();
    }
  }

  function initChat() {
    $('#fab-chat').onclick = () => setChatOpen(!chatOpen);
    $('#chat-close').onclick = () => setChatOpen(false);
    $('#chat-scrim').onclick = () => setChatOpen(false);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chatOpen && overlay.hidden) setChatOpen(false);
    });

    // swipe right on the drawer to dismiss
    const drawer = $('#chat-drawer');
    let swipeX = null;
    let swipeY = null;
    drawer.addEventListener('touchstart', (e) => {
      swipeX = e.touches[0].clientX;
      swipeY = e.touches[0].clientY;
    }, { passive: true });
    drawer.addEventListener('touchend', (e) => {
      if (swipeX === null) return;
      const dx = e.changedTouches[0].clientX - swipeX;
      const dy = Math.abs(e.changedTouches[0].clientY - swipeY);
      if (dx > 70 && dy < 60) setChatOpen(false);
      swipeX = swipeY = null;
    }, { passive: true });
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      send({ t: 'chat:send', text });
      input.value = '';
    });
    const photoBtn = $('#chat-photo');
    const fileInput = $('#chat-file');
    photoBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      photoBtn.textContent = '⏳';
      try {
        const url = await uploadPhoto(file);
        send({ t: 'chat:send', text: $('#chat-input').value.trim(), photo: url });
        $('#chat-input').value = '';
      } catch {
        toast(t('photoFailed'));
      }
      photoBtn.textContent = '📷';
    };
  }

  // ------------------------------------------------------------ welcome tour
  const TOUR_SLIDES = [
    { art: '🌙✨', title: 'tourTitle1', body: 'tourBody1' },
    { art: '✏️🔥⏳<br>🎈💌💰', title: 'tourTitle2', body: 'tourBody2' },
    { art: '💬💖🔔', title: 'tourTitle3', body: 'tourBody3' },
  ];

  function showTour(step = 0) {
    const slide = TOUR_SLIDES[step];
    const last = step === TOUR_SLIDES.length - 1;
    const box = openModal(`
      <div class="tour-art">${slide.art}</div>
      <h2 style="text-align:center; margin-bottom:12px">${esc(t(slide.title))}</h2>
      <p class="tour-body">${esc(t(slide.body))}</p>
      <div class="tour-dots">
        ${TOUR_SLIDES.map((_, i) => `<span class="tour-dot ${i === step ? 'on' : ''}"></span>`).join('')}
      </div>
      <div class="tour-actions">
        <button class="btn btn-ghost js-skip">${esc(last ? '' : t('tourSkip'))}</button>
        <button class="btn btn-primary js-next">${esc(last ? t('tourDone') : t('tourNext'))}</button>
      </div>`, { dismissable: false });

    const skipBtn = $('.js-skip', box);
    if (last) skipBtn.style.visibility = 'hidden';
    skipBtn.onclick = endTour;
    $('.js-next', box).onclick = () => (last ? endTour() : showTour(step + 1));
  }

  function endTour() {
    localStorage.setItem('ct:toured', '1');
    closeModal();
    // only nudge once the board has actually loaded and turned out empty
    if (!$('#empty-hint').hidden) pointAtAddButton();
  }

  function pointAtAddButton() {
    const fab = $('#fab-add');
    fab.classList.add('pulse');
    const bubble = document.createElement('div');
    bubble.className = 'hint-bubble';
    bubble.textContent = t('hintAdd');
    document.body.appendChild(bubble);
    const place = () => {
      const r = fab.getBoundingClientRect();
      bubble.style.top = r.top - bubble.offsetHeight - 12 + 'px';
      bubble.style.left = Math.max(12, r.right - bubble.offsetWidth) + 'px';
    };
    place();
    addEventListener('resize', place);
    const clear = () => {
      bubble.remove();
      fab.classList.remove('pulse');
      removeEventListener('resize', place);
      fab.removeEventListener('click', clear);
    };
    fab.addEventListener('click', clear);
    setTimeout(clear, 7000);
  }

  // ------------------------------------------------------------ push notifications
  let swReg = null;
  const pushKey = () => 'ct:push:' + roomCode;

  function updateBellUI() {
    const btn = $('#notif-btn');
    btn.textContent = localStorage.getItem(pushKey()) === '1' ? '🔔' : '🔕';
  }

  async function initPushUI() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swReg = await navigator.serviceWorker.register('/sw.js');
    } catch {
      return;
    }
    const btn = $('#notif-btn');
    btn.hidden = false;
    updateBellUI();
    btn.onclick = togglePush;
  }

  const urlB64 = (s) => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  };

  async function togglePush() {
    if (!swReg || !('PushManager' in window) || !('Notification' in window)) {
      return toast(t('notifUnsupported'));
    }
    try {
      if (localStorage.getItem(pushKey()) === '1') {
        const sub = await swReg.pushManager.getSubscription();
        if (sub) {
          fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          await sub.unsubscribe();
        }
        localStorage.setItem(pushKey(), '0');
        toast(t('notifOff'));
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return toast(t('notifDenied'));
        const { key } = await (await fetch('/api/push/key')).json();
        const sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64(key),
        });
        const res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: room.code, cid: myCid, sub: sub.toJSON() }),
        });
        if (!res.ok) throw new Error('subscribe-failed');
        localStorage.setItem(pushKey(), '1');
        toast(t('notifOn'));
      }
    } catch {
      toast(t('notifUnsupported'));
    }
    updateBellUI();
  }

  // ------------------------------------------------------------ room init
  async function initRoom() {
    $('#view-room').hidden = false;

    identity = await ensureIdentity();
    connect();
    initChat();
    initPushUI();

    if (!localStorage.getItem('ct:toured')) showTour(0);
    $('#replay-tour').onclick = () => showTour(0);

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
