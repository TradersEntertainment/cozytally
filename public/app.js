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
    resubscribePushLang();
  });

  /** Re-register the push subscription so notifications follow the UI language. */
  async function resubscribePushLang() {
    if (!room || !swReg || localStorage.getItem(pushKey()) !== '1') return;
    try {
      const sub = await swReg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: room.code, cid: myCid, lang, sub: sub.toJSON() }),
      });
    } catch { /* language will catch up on the next subscribe */ }
  }

  // ------------------------------------------------------------ night sky
  function buildSky() {
    const sky = $('#sky');
    // a phone screen doesn't need a desktop's worth of stars, and every one
    // of them is an element the compositor animates forever
    const stars = Math.round(Math.min(70, Math.max(28, (innerWidth * innerHeight) / 15000)));
    for (let i = 0; i < stars; i++) {
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
    // the sky keeps twinkling in a backgrounded tab otherwise — pure battery
    document.addEventListener('visibilitychange', () =>
      document.body.classList.toggle('away', document.hidden)
    );
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
    game: { emoji: '🎲', nameKey: 'typeGame', descKey: 'typeGameDesc' },
  };

  /* The four mini games. They all live behind the one 'game' card type, so
     the picker lists these rather than the type. Board sizes are fixed on the
     server in games.js — repeated here only to lay the grid out. */
  const GAME_META = {
    xox: { emoji: '⭕', nameKey: 'gameXox', descKey: 'gameXoxDesc' },
    connect4: { emoji: '🔵', nameKey: 'gameConnect4', descKey: 'gameConnect4Desc' },
    dots: { emoji: '⬜', nameKey: 'gameDots', descKey: 'gameDotsDesc' },
    truths: { emoji: '🤥', nameKey: 'gameTruths', descKey: 'gameTruthsDesc' },
  };
  const C4_COLS = 7;
  const C4_ROWS = 6;
  const DOTS_N = 5;

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
    modalBox.innerHTML = `<div class="sheet-grabber"></div>${html}`;
    modalBox.scrollTop = 0;
    modalBox.style.transform = '';
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

  // Bottom sheets on phones: drag down to dismiss, with rubber-banding past
  // the top. Only starts when the sheet is already scrolled to the top.
  (() => {
    let startY = null;
    let dy = 0;

    modalBox.addEventListener('touchstart', (e) => {
      if (!modalDismissable || modalBox.scrollTop > 0) return;
      startY = e.touches[0].clientY;
      dy = 0;
      modalBox.style.transition = 'none';
    }, { passive: true });

    modalBox.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0) return;
      modalBox.style.transform = `translateY(${dy * 0.75}px)`;
    }, { passive: true });

    modalBox.addEventListener('touchend', () => {
      if (startY === null) return;
      modalBox.style.transition = '';
      if (dy > 110) closeModal();
      else modalBox.style.transform = '';
      startY = null;
      dy = 0;
    }, { passive: true });
  })();

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
      if (document.hidden) ws.send(JSON.stringify({ t: 'vis', hidden: true }));
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

  // Tell the server when we stop looking, so it knows to push instead of
  // relying on the in-app toast nobody is there to see.
  document.addEventListener('visibilitychange', () => {
    send({ t: 'vis', hidden: document.hidden });
    if (!document.hidden) markSeen();
  });

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
        seenList = msg.seen || [];
        lastSeenSent = 0;
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
        if (!chatOpen && !isMine(msg.msg)) {
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
        if (msg.verb === 'card:add' && !prev) renderAllCards();
        else renderCard(msg.card, { prev, verb: msg.verb, by: msg.by });
        handleCardToasts(msg);
        updateEmptyHint();
        // our own card, saved before its photos finished uploading
        if (msg.ref && photoJobs.has(msg.ref)) {
          const job = photoJobs.get(msg.ref);
          photoJobs.delete(msg.ref);
          attachPhotosLater(msg.card.id, job);
        }
        return;
      }

      case 'card:delete':
        cards.delete(msg.id);
        $(`.card[data-id="${msg.id}"]`)?.remove();
        if (msg.by?.id !== myId) toast(t('toastCardDelete', { name: msg.by.name, card: msg.title }));
        updateEmptyHint();
        return;

      case 'seen':
        seenList = msg.seen || [];
        renderSeen();
        return;

      case 'cards:order': {
        msg.ids.forEach((id, i) => {
          const c = cards.get(id);
          if (c) c.sort = i;
        });
        if (msg.by?.id !== myId) {
          renderAllCards();
          toast(t('toastReordered', { name: msg.by.name }));
        }
        return;
      }

      case 'game:over': {
        // whoever won, both screens celebrate — it's a game between friends
        confetti();
        centerCheer(
          msg.draw ? t('gameDrawMsg') : t('gameWonCheer', { name: msg.winner?.name || '?' })
        );
        return;
      }

      case 'money:goal': {
        confetti();
        centerCheer(msg.goal?.title ? t('goalReachedCheer', { name: msg.goal.title }) : t('moneyReached'));
        const step = $(`.card[data-id="${msg.id}"] .goal-step[data-i="${msg.index}"]`);
        if (step) {
          step.classList.add('just-won');
          setTimeout(() => step.classList.remove('just-won'), 1400);
        }
        return;
      }

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
  let seenList = [];
  let lastSeenSent = 0;

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
      'note:comment': 'toastNoteComment',
      'list:add': 'toastListAdd',
      'list:toggle': 'toastListDone',
      'checkin:tick': 'toastCheckin',
      'game:move': 'toastGameMove',
      'game:next': 'toastGameNext',
      'game:seat': 'toastGameSeat',
    };
    // the win gets its own confetti; don't also toast the move that caused it
    if (verb === 'game:move' && card.state?.over) return;
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

  /* ------------------------------------------------------------------
     Reordering. Dragging starts only from the ≡ grip, so nothing inside a
     card can ever be mistaken for a drag. Arrow keys on a focused grip do
     the same thing without a pointer.
     ------------------------------------------------------------------ */
  const EDGE = 90;        // how close to the screen edge before we auto-scroll
  const EDGE_SPEED = 900; // px per second at the very edge, tapering to 0
  const MAX_GOALS = 6;    // matches the server's cap

  function currentOrder() {
    return $$('#board .card').map((el) => el.dataset.id);
  }

  function commitOrder() {
    const ids = currentOrder();
    ids.forEach((id, i) => {
      const c = cards.get(id);
      if (c) c.sort = i;
    });
    send({ t: 'card:reorder', ids });
  }

  /** Slide the cards that shifted, from where they were to where they are. */
  function flip(before) {
    for (const [el, prev] of before) {
      if (!el.isConnected || el.classList.contains('dragging')) continue;
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.24s cubic-bezier(0.34, 1.3, 0.64, 1)';
        el.style.transform = '';
      });
    }
  }

  const snapshot = () =>
    new Map($$('#board .card').map((el) => [el, el.getBoundingClientRect()]));

  function initReorder() {
    const board = $('#board');
    let drag = null;

    const cleanup = () => {
      if (!drag) return;
      clearTimeout(drag.holdTimer);
      cancelAnimationFrame(drag.raf);
      const { card, placeholder } = drag;
      card.classList.remove('dragging');
      card.style.cssText = '';
      if (placeholder) placeholder.replaceWith(card);
      document.body.classList.remove('reordering');
      $$('#board .card').forEach((el) => (el.style.transition = ''));
      drag = null;
    };

    const lift = (e) => {
      const rect = drag.card.getBoundingClientRect();
      drag.lifted = true;
      drag.grabX = drag.startX - rect.left;
      drag.grabY = drag.startY - rect.top;

      drag.placeholder = document.createElement('div');
      drag.placeholder.className = 'card-placeholder';
      drag.placeholder.style.height = rect.height + 'px';
      drag.card.after(drag.placeholder);

      Object.assign(drag.card.style, {
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        margin: '0',
      });
      drag.card.classList.add('dragging');
      document.body.classList.add('reordering');
      if (navigator.vibrate) navigator.vibrate(15);
      moveTo(e.clientX, e.clientY);
    };

    function moveTo(x, y) {
      drag.card.style.left = x - drag.grabX + 'px';
      drag.card.style.top = y - drag.grabY + 'px';

      // slot the placeholder next to whichever card the pointer is over
      const others = $$('#board .card:not(.dragging)');
      let target = null;
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2 || (y < r.bottom && x < r.left + r.width / 2)) {
          target = el;
          break;
        }
      }
      const before = snapshot();
      if (target) {
        if (drag.placeholder.nextElementSibling !== target) target.before(drag.placeholder);
        else return;
      } else if (board.lastElementChild !== drag.placeholder) {
        board.appendChild(drag.placeholder);
      } else return;
      flip(before);
    }

    const autoScroll = (ts) => {
      if (!drag) return;
      // measured in px per second, so a 120 Hz phone doesn't fly twice as fast
      // as a 60 Hz one; a long frame is capped so a hiccup can't jump the page
      const dt = Math.min(50, ts - (drag.lastTs ?? ts));
      drag.lastTs = ts;
      // keep the loop alive while the press is still deciding — bailing out
      // before the lift would kill it for the whole drag
      if (drag.lifted) {
        const { y } = drag;
        let speed = 0;
        if (y < EDGE) speed = -EDGE_SPEED * (1 - y / EDGE);
        else if (y > innerHeight - EDGE) speed = EDGE_SPEED * (1 - (innerHeight - y) / EDGE);
        if (speed) {
          // carry the leftover fraction so slow crawls near the edge still move
          drag.scrollLeft = (drag.scrollLeft || 0) + (speed * dt) / 1000;
          const whole = Math.trunc(drag.scrollLeft);
          if (whole) {
            drag.scrollLeft -= whole;
            scrollBy(0, whole);
            moveTo(drag.x, drag.y);
          }
        }
      }
      drag.raf = requestAnimationFrame(autoScroll);
    };

    board.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.card-grip');
      if (!grip || e.button > 0) return;
      const card = grip.closest('.card');
      if (!card) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);

      drag = {
        card,
        grip,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        lifted: false,
        placeholder: null,
        raf: 0,
        holdTimer: setTimeout(() => drag && !drag.lifted && lift(e), 150),
      };
      drag.raf = requestAnimationFrame(autoScroll);
    });

    board.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      // a decisive move lifts it without waiting out the hold
      if (!drag.lifted) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
        clearTimeout(drag.holdTimer);
        lift(e);
        return;
      }
      moveTo(e.clientX, e.clientY);
    });

    const finish = (e) => {
      if (!drag || (e && e.pointerId !== drag.pointerId)) return;
      const moved = drag.lifted;
      cleanup();
      if (moved) commitOrder();
    };

    board.addEventListener('pointerup', finish);
    board.addEventListener('pointercancel', () => {
      if (drag?.lifted) renderAllCards();
      cleanup();
    });

    // keyboard: focus a grip and nudge the card up or down
    board.addEventListener('keydown', (e) => {
      const grip = e.target.closest?.('.card-grip');
      if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const card = grip.closest('.card');
      const sibling = e.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
      if (!sibling) return;
      const before = snapshot();
      if (e.key === 'ArrowUp') sibling.before(card);
      else sibling.after(card);
      flip(before);
      grip.focus();
      commitOrder();
    });
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
        <button class="card-grip" title="${esc(t('moveCard'))}" aria-label="${esc(t('moveCard'))}">≡</button>
        ${card.type === 'game'
          ? `<button class="icon-btn js-how" title="${esc(t('howToPlay'))}"
               aria-label="${esc(t('howToPlay'))}">?</button>`
          : ''}
        <button class="icon-btn js-edit" title="${esc(t('edit'))}">✏️</button>
        <button class="icon-btn js-del" title="${esc(t('del'))}">🗑️</button>
      </div>
      <div class="card-body"></div>`;

    $('.js-edit', el).onclick = () => openCardModal(card.type, card);
    $('.js-how', el)?.addEventListener('click', () => openHowToPlay(card.config?.game || 'xox'));
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
    if (card.type === 'game') renderGameBody(body, card, opts);

    if (typing) {
      const again = el.querySelector('input.' + typing.cls.trim().split(/\s+/).join('.'));
      if (again) {
        again.value = typing.value;
        again.focus();
        // number inputs throw on setSelectionRange, and they park the caret
        // at the end anyway
        if (again.type === 'text' || again.type === 'search') {
          again.setSelectionRange(again.value.length, again.value.length);
        }
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

  // ---- mini games
  /**
   * All four games wear the same frame — two seats, a scoreboard, whose turn
   * it is — and differ only in the board underneath. The browser draws what
   * the server sent and asks for moves; it never decides whether one is
   * legal, so the two of you can't end up looking at different boards.
   */
  function renderGameBody(body, card, opts = {}) {
    const s = card.state || {};
    const kind = card.config?.game || s.game || 'xox';
    const seats = s.players || [];
    const mySeat = seats.findIndex((p) => p.key === myKey());
    /* Seats are handed out by the server on someone's first move, so a player
       who hasn't sat down yet still has to be able to touch the board — the
       chair they would take is simply the next free one. */
    const openSeat = mySeat < 0 && seats.length < 2 ? seats.length : -1;
    const playSeat = mySeat >= 0 ? mySeat : openSeat;
    const myTurn = playSeat >= 0 && s.turn === playSeat && !s.over;

    const seatChip = (i) => {
      const p = seats[i];
      const live = !s.over && s.turn === i;
      if (!p) {
        return `<span class="g-seat empty ${live ? 'live' : ''}">
          <span class="g-disc p${i + 1}"></span>${esc(t('gameFreeSeat'))}</span>`;
      }
      return `<span class="g-seat ${live ? 'live' : ''} ${i === mySeat ? 'me' : ''}">
        <span class="g-disc p${i + 1}"></span>${esc(p.avatar)} ${esc(p.name)}
        <b>${s.scores?.[i] ?? 0}</b></span>`;
    };

    let status;
    if (s.over) {
      status = s.over.winner === 'draw'
        ? t('gameDrawMsg')
        : s.over.winner === mySeat
          ? t('gameYouWon')
          : t('gameTheyWon', { name: seats[s.over.winner]?.name || '?' });
    } else if (myTurn && mySeat < 0) {
      status = t('gameSitDown'); // your move is what puts you in the chair
    } else if (myTurn) {
      status = s.again ? t('gameAgain') : t('gameYourTurn');
    } else if (mySeat < 0 && seats.length >= 2) {
      status = t('gameSpectator');
    } else if (seats[s.turn]) {
      status = t('gameTheirTurn', { name: seats[s.turn].name });
    } else {
      status = t('gameWaitingOther'); // the chair whose turn it is, is empty
    }

    // in dots the thing you actually watch climb is boxes, not rounds won
    const boxes = kind === 'dots'
      ? t('gameBoxes', {
          a: s.boxes.filter((v) => v === 1).length,
          b: s.boxes.filter((v) => v === 2).length,
        })
      : '';

    const boards = { xox: xoxBoard, connect4: c4Board, dots: dotsBoard, truths: truthsBoard };
    body.innerHTML = `
      <div class="g-seats">${seatChip(0)}${seatChip(1)}</div>
      <div class="g-status ${myTurn ? 'mine' : ''} ${s.over ? 'over' : ''}">${esc(status)}</div>
      ${boards[kind](s, mySeat, myTurn)}
      <div class="g-foot">
        <span class="sub-label">${esc(t('gameRound', { n: s.round || 1 }))}${boxes ? ' · ' + esc(boxes) : ''}</span>
        ${s.over ? `<button class="btn btn-primary btn-sm js-gnext">${esc(t('gameNext'))}</button>` : ''}
      </div>
      ${commentsHtml(card, 'gameCommentPh')}`;

    const move = (m) => send({ t: 'game:move', id: card.id, move: m });
    $('.js-gnext', body)?.addEventListener('click', () => send({ t: 'game:next', id: card.id }));
    wireGameBoard(kind, body, s, myTurn, move);
    wireComments(body, card);

    if (opts.verb === 'game:move' && s.over && s.over.winner === mySeat) coinRain(body.closest('.card'));
  }

  const discOf = (v) => (v ? `<span class="g-disc p${v}"></span>` : '');

  function xoxBoard(s, mySeat, myTurn) {
    const marks = ['', '✕', '◯'];
    return `<div class="g-xox ${myTurn ? 'playable' : ''}">
      ${s.board.map((v, i) => `
        <button class="g-cell ${v ? 'taken' : ''} ${s.over?.line?.includes(i) ? 'win' : ''}
          ${i === s.last ? 'last' : ''}" data-cell="${i}" ${v || !myTurn ? 'disabled' : ''}>
          ${v ? `<span class="g-mark p${v}">${marks[v]}</span>` : ''}
        </button>`).join('')}
    </div>`;
  }

  function c4Board(s, mySeat, myTurn) {
    // one tall button per column: on a phone you aim at a column, not a hole
    const cols = Array.from({ length: C4_COLS }, (_, c) => {
      const full = !!s.board[c];
      const holes = Array.from({ length: C4_ROWS }, (_, r) => {
        const i = r * C4_COLS + c;
        return `<span class="g-hole ${s.over?.line?.includes(i) ? 'win' : ''} ${i === s.last ? 'last' : ''}">
          ${discOf(s.board[i])}</span>`;
      }).join('');
      return `<button class="g-col" data-col="${c}" ${full || !myTurn ? 'disabled' : ''}>${holes}</button>`;
    }).join('');
    return `<div class="g-c4 ${myTurn ? 'playable' : ''}">${cols}</div>`;
  }

  function dotsBoard(s, mySeat, myTurn) {
    const parts = [];
    for (let r = 0; r < DOTS_N; r++) {
      for (let c = 0; c < DOTS_N; c++) {
        parts.push(`<span class="g-dot" style="grid-row:${r * 2 + 1};grid-column:${c * 2 + 1}"></span>`);
        if (c < DOTS_N - 1) {
          const i = r * (DOTS_N - 1) + c;
          const on = s.h[i];
          parts.push(`<button class="g-edge h ${on ? 'on p' + on : ''}
            ${s.last?.dir === 'h' && s.last.i === i ? 'last' : ''}"
            data-dir="h" data-i="${i}" style="grid-row:${r * 2 + 1};grid-column:${c * 2 + 2}"
            ${on || !myTurn ? 'disabled' : ''}></button>`);
        }
      }
      if (r < DOTS_N - 1) {
        for (let c = 0; c < DOTS_N; c++) {
          const i = r * DOTS_N + c;
          const on = s.v[i];
          parts.push(`<button class="g-edge v ${on ? 'on p' + on : ''}
            ${s.last?.dir === 'v' && s.last.i === i ? 'last' : ''}"
            data-dir="v" data-i="${i}" style="grid-row:${r * 2 + 2};grid-column:${c * 2 + 1}"
            ${on || !myTurn ? 'disabled' : ''}></button>`);
          if (c < DOTS_N - 1) {
            const b = r * (DOTS_N - 1) + c;
            parts.push(`<span class="g-box ${s.boxes[b] ? 'p' + s.boxes[b] : ''}"
              style="grid-row:${r * 2 + 2};grid-column:${c * 2 + 2}">
              ${s.boxes[b] ? (s.boxes[b] === 1 ? '●' : '○') : ''}</span>`);
          }
        }
      }
    }
    return `<div class="g-dots ${myTurn ? 'playable' : ''}">${parts.join('')}</div>`;
  }

  function truthsBoard(s, mySeat, myTurn) {
    if (s.phase === 'writing') {
      if (!myTurn) {
        return `<div class="g-truths waiting">${esc(t('gameTruthsWaiting'))}</div>`;
      }
      return `<div class="g-truths">
        <p class="sub-label">${esc(t('gameTruthsHint'))}</p>
        ${[0, 1, 2].map((i) => `
          <label class="g-tline">
            <input type="radio" name="lie-${s.round}" class="js-lie" value="${i}" ${i === 2 ? 'checked' : ''}>
            <input type="text" class="js-stmt" maxlength="120" data-i="${i}"
              placeholder="${esc(t('gameTruthsPh', { n: i + 1 }))}" autocomplete="off">
          </label>`).join('')}
        <button class="btn btn-primary btn-sm js-tsend">${esc(t('gameTruthsSend'))}</button>
      </div>`;
    }

    const done = s.phase === 'done';
    return `<div class="g-truths">
      <p class="sub-label">${esc(done ? t('gameTruthsResult') : myTurn ? t('gameTruthsPick') : t('gameTruthsTheyPick'))}</p>
      ${s.statements.map((text, i) => {
        const isLie = done && s.over?.lie === i;
        const picked = done && s.over?.guess === i;
        return `<button class="g-tstmt ${isLie ? 'lie' : ''} ${picked ? 'picked' : ''}"
          data-guess="${i}" ${myTurn && !done ? '' : 'disabled'}>
          <span class="g-tmark">${done ? (isLie ? '🤥' : '✅') : '?'}</span>${esc(text)}
        </button>`;
      }).join('')}
    </div>`;
  }

  /* ---- how to play
     A scripted game between two made-up people, played out move by move on
     the real board by the real rules (public/games.js is the same module the
     server referees with). Nothing here is a mock-up: if the rules changed,
     the demo would change with them. */
  const DEMO_A = { key: 'demo-a', name: 'Rabia', avatar: '🐰' };
  const DEMO_B = { key: 'demo-b', name: 'Ömer', avatar: '🐻' };

  /**
   * Every edge of the dots board, drawn column by column. The order matters
   * more than it looks: drawing all the horizontals and then all the
   * verticals hands one player a 16–0 cascade at the very end, which teaches
   * nothing. Going column by column closes boxes throughout and finishes
   * 10–6, so the extra-turn rule shows up seven separate times.
   */
  function dotsDemoSteps() {
    const order = [];
    const seen = new Set();
    const add = (dir, i) => {
      const k = dir + i;
      if (seen.has(k)) return;
      seen.add(k);
      order.push({ move: { dir, i } });
    };
    for (let c = 0; c < DOTS_N - 1; c++) {
      for (let r = 0; r < DOTS_N; r++) add('h', r * (DOTS_N - 1) + c);
      for (let r = 0; r < DOTS_N - 1; r++) {
        add('v', r * DOTS_N + c);
        add('v', r * DOTS_N + c + 1);
      }
    }
    return order; // whoever's turn it is takes the next step
  }

  const DEMOS = {
    xox: {
      speed: 950,
      steps: [
        { move: { cell: 0 } },
        { move: { cell: 4 } },
        { move: { cell: 1 } },
        { move: { cell: 2 }, tip: 'demoBlocks' },
        { move: { cell: 3 } },
        { move: { cell: 5 } },
        { move: { cell: 6 } },
      ],
    },
    connect4: {
      speed: 850,
      steps: [3, 4, 3, 4, 3, 4, 3].map((col) => ({ move: { col } })),
    },
    dots: { speed: 200, steps: dotsDemoSteps() },
    truths: {
      speed: 2400,
      steps: [
        { tip: 'demoTruthsWrite' },
        { move: { statements: [], lie: 1 }, tip: 'demoTruthsGuess', truthsWrite: true },
        { move: { guess: 1 }, tip: 'demoTruthsReveal' },
      ],
    },
  };

  const DEMO_HOW = {
    xox: 'demoHowXox',
    connect4: 'demoHowC4',
    dots: 'demoHowDots',
    truths: 'demoHowTruths',
  };

  function openHowToPlay(kind) {
    const meta = GAME_META[kind] || GAME_META.xox;
    const box = openModal(`
      <h2>${meta.emoji} ${esc(t('howToPlayTitle', { game: t(meta.nameKey) }))}</h2>
      <p class="sub-label" style="text-align:left; margin:-4px 0 12px">${esc(t(meta.descKey))}</p>
      <div class="demo">
        <div class="g-seats demo-seats"></div>
        <div class="demo-board"></div>
        <div class="demo-tip"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost js-replay" hidden>${esc(t('demoReplay'))}</button>
        <button class="btn btn-primary js-close">${esc(t('gotIt'))}</button>
      </div>`);
    $('.js-close', box).onclick = closeModal;

    const boards = { xox: xoxBoard, connect4: c4Board, dots: dotsBoard, truths: truthsBoard };
    const seatsEl = $('.demo-seats', box);
    const boardEl = $('.demo-board', box);
    const tipEl = $('.demo-tip', box);
    const replay = $('.js-replay', box);
    let timer = null;

    const paint = (state, tip) => {
      seatsEl.innerHTML = [DEMO_A, DEMO_B]
        .map((p, i) => {
          const live = !state.over && state.turn === i;
          return `<span class="g-seat ${live ? 'live' : ''}">
            <span class="g-disc p${i + 1}"></span>${p.avatar} ${esc(p.name)}
            <b>${state.scores[i]}</b></span>`;
        })
        .join('');
      // drawn as a spectator sees it, so nothing invites a tap
      boardEl.innerHTML = boards[kind](state, -1, false);
      tipEl.textContent = tip;
    };

    function run() {
      clearTimeout(timer);
      replay.hidden = true;
      const G = window.CTGames;
      if (!G) {
        tipEl.textContent = t('demoUnavailable');
        return;
      }
      const state = G.newGameState(kind);
      G.seatOf(state, DEMO_A);
      G.seatOf(state, DEMO_B);
      paint(state, t('demoStart'));

      const { steps, speed } = DEMOS[kind];
      let n = 0;
      const tick = () => {
        // the modal may be long gone by now
        if (!document.body.contains(boardEl)) return;
        if (n >= steps.length) {
          replay.hidden = false;
          return;
        }
        const step = steps[n++];
        if (step.move) {
          const move = step.truthsWrite
            ? { statements: [t('demoTruth1'), t('demoLie'), t('demoTruth2')], lie: 1 }
            : step.move;
          G.applyMove(state, state.turn, move);
        }
        const who = state.over
          ? [DEMO_A, DEMO_B][state.over.winner === 'draw' ? 0 : state.over.winner]
          : [DEMO_A, DEMO_B][state.turn === 0 ? 1 : 0];
        let tip;
        if (state.over) {
          // dots wins on a count, so say the count — extra keys are simply
          // not present in the other games' strings
          const [a, bx] = state.over.boxes || [];
          tip = state.over.winner === 'draw'
            ? t('gameDrawMsg')
            : t('demoWins', {
                name: who.name,
                how: t(DEMO_HOW[kind], { a: Math.max(a, bx), b: Math.min(a, bx) }),
              });
        } else if (step.tip) {
          tip = t(step.tip, { name: who.name });
        } else if (state.again) {
          tip = t('demoBox', { name: who.name });
        } else {
          tip = t('demoPlays', { name: who.name });
        }
        paint(state, tip);

        if (state.over) {
          confetti();
          replay.hidden = false;
          return;
        }
        // linger on the good bits so a box closing actually registers
        timer = setTimeout(tick, state.again ? Math.max(speed, 650) : speed);
      };
      timer = setTimeout(tick, 900);
    }

    replay.onclick = run;
    run();
  }

  function wireGameBoard(kind, body, s, myTurn, move) {
    if (!myTurn) return;
    if (kind === 'xox') {
      $$('.g-cell:not([disabled])', body).forEach((b) => (b.onclick = () => move({ cell: Number(b.dataset.cell) })));
    }
    if (kind === 'connect4') {
      $$('.g-col:not([disabled])', body).forEach((b) => (b.onclick = () => move({ col: Number(b.dataset.col) })));
    }
    if (kind === 'dots') {
      $$('.g-edge:not([disabled])', body).forEach(
        (b) => (b.onclick = () => move({ dir: b.dataset.dir, i: Number(b.dataset.i) }))
      );
    }
    if (kind === 'truths') {
      const send3 = $('.js-tsend', body);
      if (send3) {
        send3.onclick = () => {
          const statements = $$('.js-stmt', body).map((el) => el.value.trim());
          if (statements.some((v) => !v)) return $$('.js-stmt', body).find((el) => !el.value.trim())?.focus();
          const lie = Number($$('.js-lie', body).find((el) => el.checked)?.value ?? 2);
          move({ statements, lie });
        };
      }
      $$('.g-tstmt:not([disabled])', body).forEach(
        (b) => (b.onclick = () => move({ guess: Number(b.dataset.guess) }))
      );
    }
  }

  // ---- money pot
  /**
   * Every goal costs its own amount and they are paid off in order. Cards made
   * before multi-goal existed carry a single flat goal — read them as a
   * one-step ladder so nothing about them changes.
   */
  function goalsOf(card) {
    const cfg = card.config || {};
    if (Array.isArray(cfg.goals) && cfg.goals.length) return cfg.goals;
    if (cfg.goal) return [{ amount: cfg.goal, title: '', photo: cfg.photo }];
    return [];
  }

  /**
   * Pour the pot into the goals one after another: the first goal takes what it
   * costs, only the leftover spills into the next. A goal further down the list
   * stays at 0 until the ones before it are fully paid.
   */
  function fillGoals(goals, total) {
    let left = total;
    return goals.map((g) => {
      const got = Math.max(0, Math.min(left, g.amount));
      left -= got;
      return { ...g, got, done: g.amount > 0 && got >= g.amount };
    });
  }

  function renderMoneyBody(body, card, opts = {}) {
    const total = card.state.total || 0;
    const cur = card.config.cur || '₺';
    const goals = goalsOf(card);
    const rungs = fillGoals(goals, total);
    const needAll = goals.reduce((s, g) => s + g.amount, 0);
    const doneCount = rungs.filter((r) => r.done).length;
    const allDone = rungs.length > 0 && doneCount === rungs.length;
    // what we're saving for right now — and how far along that one goal is
    const active = rungs.find((r) => !r.done) || rungs[rungs.length - 1];
    const goal = active?.amount || 0;
    const pct = goal ? ((active?.got || 0) / goal) * 100 : 0;

    const milestones = goal
      ? `<div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, pct)}%"></div></div>
         <div class="milestones">${[25, 50, 75, 100]
           .map((m) => `<div class="milestone ${pct >= m ? 'reached' : ''}">
             <span class="ms-star">${pct >= m ? '⭐' : '☆'}</span>${lang === 'tr' ? '%' + m : m + '%'}
           </div>`)
           .join('')}</div>
         <div class="sub-label">${allDone
           ? esc(goals.length > 1 ? t('allGoalsDone') : t('moneyReached'))
           : `${esc(t('moneyLeft', { n: fmtNum(goal - (active?.got || 0)) + cur }))} · ${esc(
               goals.length > 1 && active.title
                 ? t('nextGoal', { name: active.title, n: fmtNum(goal) + cur })
                 : t('goal', { n: fmtNum(goal) + cur })
             )}`}</div>`
      : '';

    // The ladder only appears once there is more than one rung — single-goal
    // cards keep exactly the look they had.
    const strip = goals.length > 1
      ? `<div class="goal-head">${esc(t('goalsTitle'))} · ${esc(t('goalsDone', { done: doneCount, total: goals.length }))} · ${esc(
           t('goalsPot', { have: fmtNum(total) + cur, need: fmtNum(needAll) + cur })
         )}</div>
         <div class="goal-strip">
           ${rungs
             .map((r, i) => {
               const isActive = r === active && !r.done;
               const fill = r.amount ? Math.max(0, Math.min(100, (r.got / r.amount) * 100)) : 0;
               return `<div class="goal-step ${r.done ? 'done' : ''} ${isActive ? 'active' : ''}" data-i="${i}">
                 <div class="gs-photo">
                   ${r.photo ? `<img src="${esc(r.photo)}" alt="" loading="lazy">` : '<span class="gs-blank">💰</span>'}
                   <span class="gs-star">${r.done ? '⭐' : '☆'}</span>
                 </div>
                 <span class="gs-name">${esc(r.title || `${i + 1}. ${t('goalWord')}`)}</span>
                 <span class="gs-amt">${r.done
                   ? fmtNum(r.amount)
                   : `${fmtNum(r.got)}<b>/</b>${fmtNum(r.amount)}`}${esc(cur)}</span>
                 <span class="gs-bar"><i style="width:${fill}%"></i></span>
               </div>`;
             })
             .join('')}
         </div>`
      : '';

    const log = (card.state.log || []).slice(0, 4)
      .map((e) => `<div><span class="${e.a > 0 ? 'm-in' : 'm-out'}">${e.a > 0 ? '+' : '−'}${fmtNum(Math.abs(e.a))}${esc(cur)}</span> — ${esc(e.by)}</div>`)
      .join('');

    const race = renderRace(card.state.by, cur);
    const heroPhoto = goals.length > 1 ? '' : goals[0]?.photo || card.config.photo;

    body.innerHTML = `
      ${heroPhoto ? `<img class="money-photo" src="${esc(heroPhoto)}" alt="">` : ''}
      <div class="money-total">${fmtNum(total)}<small>${esc(cur)}</small></div>
      ${milestones}
      ${strip}
      ${race}
      <div class="money-form">
        <input type="number" inputmode="numeric" class="money-input js-amt" placeholder="${esc(t('amountPh'))}">
        <button class="round-btn plus js-madd">+</button>
        <button class="round-btn minus js-msub">−</button>
      </div>
      ${log ? `<div class="money-log">${log}</div>` : ''}`;

    const photoEl = $('.money-photo', body);
    if (photoEl) photoEl.onclick = () => openLightbox(heroPhoto);

    $$('.goal-step', body).forEach((step) => {
      const g = goals[Number(step.dataset.i)];
      if (g?.photo) step.onclick = () => openLightbox(g.photo);
    });

    // keep the rung you're working on in view
    const activeStep = $('.goal-step.active', body) || $('.goal-step.done:last-of-type', body);
    if (activeStep) {
      activeStep.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

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

  // Who put in what. Always on the card — the whole point of a shared pot is
  // seeing it fill up together, and hiding that behind a tap kills the feeling.
  const RACER_COLORS = ['#ffb86b', '#8be9c9', '#ff9eb5', '#b7a4ff', '#9fd8ff', '#ffe08a'];
  const LEGACY_GREY = '#8d86a8'; // the pre-tracking remainder isn't a person

  /** Stable colour per person, nudged along when two would collide. */
  function assignColors(racers) {
    const used = new Set();
    const out = {};
    for (const r of racers) {
      if (r.key === 'legacy:earlier') {
        out[r.key] = LEGACY_GREY;
        continue;
      }
      let h = 0;
      for (let i = 0; i < r.key.length; i++) h = (h * 31 + r.key.charCodeAt(i)) >>> 0;
      let idx = h % RACER_COLORS.length;
      for (let n = 0; n < RACER_COLORS.length && used.has(idx); n++) {
        idx = (idx + 1) % RACER_COLORS.length;
      }
      used.add(idx);
      out[r.key] = RACER_COLORS[idx];
    }
    return out;
  }

  function renderRace(by, cur) {
    const racers = Object.entries(by || {})
      .map(([k, v]) => ({ key: k, name: v.name || '?', avatar: v.avatar || '🐻', net: v.net || 0 }))
      .filter((r) => r.net > 0)
      .sort((a, b) => b.net - a.net);
    if (!racers.length) return '';

    const sum = racers.reduce((n, r) => n + r.net, 0);
    const people = racers.filter((r) => r.key !== 'legacy:earlier');
    const lead = people[0]?.net ?? 0;
    // a real tie shouldn't crown just one of them
    const crowned = people.filter((r) => r.net === lead).length === 1;
    const colors = assignColors(racers);

    return `
      <div class="race">
        <div class="race-label">${esc(t('contributions'))}</div>
        <div class="race-bar">
          ${racers
            .map(
              (r) => `<span class="race-seg" title="${esc(r.name)}"
                style="width:${(r.net / sum) * 100}%; background:${colors[r.key]}"></span>`
            )
            .join('')}
        </div>
        <div class="race-legend">
          ${racers
            .map(
              (r) => `<div class="racer">
                <span class="racer-dot" style="background:${colors[r.key]}"></span>
                <span class="racer-av">${esc(r.avatar)}</span>
                <span class="racer-name">${esc(r.name)}${crowned && r === people[0] ? ' 👑' : ''}</span>
                <span class="racer-amt">${fmtNum(r.net)}${esc(cur)}</span>
                <span class="racer-pct">%${Math.round((r.net / sum) * 100)}</span>
              </div>`
            )
            .join('')}
        </div>
      </div>`;
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

  /* A small conversation attached to a card. Notes have had one for a while;
     games use the same thing so you can talk while you play. */
  function commentsHtml(card, placeholderKey = 'commentPh') {
    const comments = card.state.comments || [];
    const me = myKey();
    return `
      ${comments.length
        ? `<div class="note-comments">
            ${comments
              .map(
                (c) => `<div class="ncom" data-id="${esc(c.id)}">
                  <span class="ncom-av">${esc(c.avatar || '🐻')}</span>
                  <div class="ncom-body">
                    <b>${esc(c.by)}</b>
                    <span>${esc(c.text)}</span>
                  </div>
                  ${c.key === me ? '<button class="ncom-del icon-btn">✕</button>' : ''}
                </div>`
              )
              .join('')}
          </div>`
        : ''}
      <form class="ncom-add">
        <input type="text" maxlength="300" class="js-ncom" placeholder="${esc(t(placeholderKey))}" autocomplete="off">
        <button type="submit" class="small-btn accent">💬</button>
      </form>`;
  }

  function wireComments(body, card) {
    $$('.ncom-del', body).forEach((btn) => {
      btn.onclick = () =>
        send({ t: 'card:comment', id: card.id, op: 'remove', commentId: btn.closest('.ncom').dataset.id });
    });
    $('.ncom-add', body).addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('.js-ncom', body);
      const value = input.value.trim();
      if (!value) return;
      send({ t: 'card:comment', id: card.id, text: value });
      input.value = '';
    });
    const list = $('.note-comments', body);
    if (list) list.scrollTop = list.scrollHeight;
  }

  // ---- sticky note
  function renderNoteBody(body, card) {
    const text = card.state.text || '';

    body.innerHTML = `
      <div class="note-paper">
        <div class="note-scroll">${text
          ? esc(text)
          : `<span class="note-empty">${esc(t('noteEmpty'))}</span>`}</div>
        ${text && card.state.author ? `<span class="note-author">— ${esc(card.state.author)}</span>` : ''}
      </div>
      ${commentsHtml(card)}`;

    // tapping the paper edits the note, but not while scrolling through it
    const paper = $('.note-paper', body);
    let downY = null;
    paper.addEventListener('pointerdown', (e) => (downY = e.clientY));
    paper.addEventListener('pointerup', (e) => {
      if (downY !== null && Math.abs(e.clientY - downY) < 8) openNoteEditor(card);
      downY = null;
    });

    wireComments(body, card);
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
      <h3 class="pack-head">${esc(t('gamesTitle'))}</h3>
      <div class="type-grid">
        ${Object.entries(GAME_META)
          .map(
            ([game, meta]) => `
          <button class="type-btn game-btn" data-game="${game}">
            <span class="t-emoji">${meta.emoji}</span>
            <span class="t-name">${esc(t(meta.nameKey))}</span>
            <span class="t-desc">${esc(t(meta.descKey))}</span>
          </button>`
          )
          .join('')}
      </div>
      <h3 class="pack-head">${esc(t('orSingleCard'))}</h3>
      <div class="type-grid">
        ${Object.entries(TYPE_META)
          .filter(([type]) => type !== 'game') // it has its own section above
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
    $$('.type-btn[data-type]', box).forEach((btn) => {
      btn.onclick = () => openCardModal(btn.dataset.type, null);
    });
    $$('.game-btn', box).forEach((btn) => {
      btn.onclick = () => openCardModal('game', null, btn.dataset.game);
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

      // collected first, sent last-to-first: each new card lands on top, so
      // reversing puts the pack on the board in the order written here
      const batch = [];
      const add = (card) => batch.push(card);

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
      batch.reverse().forEach((card) => send({ t: 'card:add', card }));
      closeModal();
    };

    setTimeout(() => $('#pk-name', box)?.focus(), 60);
  }

  function openCardModal(type, existing, gameKind) {
    const isEdit = !!existing;
    const meta = TYPE_META[type];
    // the four games share one card type, so which one it is comes either
    // from the picker or from the card being edited
    const game = type === 'game' ? existing?.config?.game || gameKind || 'xox' : null;
    let emoji = existing?.emoji || (game ? GAME_META[game].emoji : meta.emoji);

    const today = new Date();
    const toDateInput = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    let extraFields = '';
    if (type === 'game') {
      extraFields = `<p class="sub-label" style="text-align:left; margin:-2px 0 10px">
        ${esc(t(GAME_META[game].descKey))}</p>`;
    }
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
          <label>${esc(t('fieldCurrency'))}</label>
          <div class="emoji-row">
            ${curs.map((c) => `<button type="button" class="emoji-opt cur-opt ${c === curNow ? 'selected' : ''}" data-c="${c}">${c}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>${esc(t('fieldMoneyGoal'))}</label>
          <p class="sub-label" style="text-align:left; margin:-2px 0 10px">${esc(t('multiGoalHint'))}</p>
          <div class="goal-rows js-goalrows"></div>
          <button type="button" class="small-btn js-addgoal">➕ ${esc(t('addGoal'))}</button>
        </div>`;
    }

    const headEmoji = game ? GAME_META[game].emoji : meta.emoji;
    const headName = game ? t(GAME_META[game].nameKey) : t(meta.nameKey);
    // a game arrives already named, so you can just hit create
    const titleValue = existing?.title || (game ? t(GAME_META[game].nameKey) : '');

    const box = openModal(`
      <h2>${headEmoji} ${esc(isEdit ? t('editCardTitle') : headName)}</h2>
      <div class="field">
        <label>${esc(t('fieldTitle'))}</label>
        <input id="cf-title" type="text" maxlength="60" placeholder="${esc(t('fieldTitlePh'))}"
          value="${esc(titleValue)}" autocomplete="off">
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
    $$('.cur-opt', box).forEach((btn) => {
      btn.onclick = () => {
        cur = btn.dataset.c;
        $$('.cur-opt', box).forEach((b) => b.classList.toggle('selected', b === btn));
      };
    });
    // ---- goal ladder editor (money cards)
    const goalRows = $('.js-goalrows', box);
    let goalDraft = [];
    if (goalRows) {
      goalDraft = (goalsOf({ config: existing?.config || {} }) || []).map((g) => ({
        amount: g.amount,
        title: g.title || '',
        photo: g.photo || '',
        file: null,
      }));
      if (!goalDraft.length) goalDraft.push({ amount: '', title: '', photo: '', file: null });

      const thumbOf = (g) =>
        g.preview || g.photo
          ? `<img src="${esc(g.preview || g.photo)}" alt="">`
          : '<span>📷</span>';

      /* Repaint one thumbnail instead of the whole list. A shrink or an
         upload finishing must not tear down the row someone is typing in. */
      const paintPhoto = (i) => {
        const cell = $(`.goal-row[data-i="${i}"] .js-grphoto`, goalRows);
        if (!cell) return;
        const g = goalDraft[i];
        cell.innerHTML = thumbOf(g);
        cell.classList.toggle('busy', !!g.busy);
        cell.classList.toggle('failed', !!g.failed);
      };

      /* Shrink and upload the moment a photo is picked, not at save time.
         By the time the amounts are typed the file is already on the server,
         so "Create" has nothing left to wait for. */
      const startUpload = (i, picked) => {
        const g = goalDraft[i];
        if (g.preview) URL.revokeObjectURL(g.preview);
        // the thumbnail appears now, straight off the picked file — shrinking
        // first would leave an empty square for a second on a phone
        Object.assign(g, {
          preview: URL.createObjectURL(picked),
          photo: '',
          busy: true,
          failed: false,
        });
        paintPhoto(i);

        g.upload = (async () => {
          const blob = await queueProcess(picked);
          // swap in the small copy so the full-size decode can be released
          const old = g.preview;
          g.preview = URL.createObjectURL(blob);
          paintPhoto(i);
          if (old) URL.revokeObjectURL(old);
          const url = await uploadBlob(blob);
          g.photo = url;
          return url;
        })();

        g.upload
          .catch(() => { g.failed = true; })
          .finally(() => { g.busy = false; paintPhoto(i); });
      };

      const drawGoals = () => {
        goalRows.innerHTML = goalDraft
          .map(
            (g, i) => `
            <div class="goal-row" data-i="${i}">
              <div class="gr-photo js-grphoto${g.busy ? ' busy' : ''}${g.failed ? ' failed' : ''}">
                ${thumbOf(g)}
              </div>
              <input type="file" class="js-grfile" accept="image/*" hidden>
              <div class="gr-fields">
                <input type="text" class="js-grtitle" maxlength="40"
                  placeholder="${esc(t('goalNamePh'))}" value="${esc(g.title)}" autocomplete="off">
                <input type="number" inputmode="numeric" min="1" class="js-gramount"
                  placeholder="${esc(t('goalAmount'))}" value="${g.amount || ''}">
              </div>
              ${goalDraft.length > 1
                ? `<button type="button" class="icon-btn js-grdel" title="${esc(t('removeGoal'))}">✕</button>`
                : ''}
            </div>`
          )
          .join('');

        $$('.goal-row', goalRows).forEach((row) => {
          const i = Number(row.dataset.i);
          const file = $('.js-grfile', row);
          $('.js-grphoto', row).onclick = () => file.click();
          file.onchange = () => {
            const picked = file.files[0];
            if (picked) startUpload(i, picked);
          };
          $('.js-grtitle', row).oninput = (e) => (goalDraft[i].title = e.target.value);
          $('.js-gramount', row).oninput = (e) => (goalDraft[i].amount = e.target.value);
          const del = $('.js-grdel', row);
          if (del) {
            del.onclick = () => {
              const [gone] = goalDraft.splice(i, 1);
              if (gone?.preview) URL.revokeObjectURL(gone.preview);
              drawGoals();
            };
          }
        });
      };

      drawGoals();
      $('.js-addgoal', box).onclick = (e) => {
        if (goalDraft.length >= MAX_GOALS) return;
        goalDraft.push({ amount: '', title: '', photo: '', upload: null });
        drawGoals();
        if (goalDraft.length >= MAX_GOALS) e.currentTarget.disabled = true;
      };
    }

    const backBtn = $('.js-back', box);
    if (backBtn) backBtn.onclick = () => openTypePicker();
    $('.js-cancel', box).onclick = closeModal;

    $('.js-save', box).onclick = () => {
      const title = $('#cf-title', box).value.trim();
      if (!title) return $('#cf-title', box).focus();
      const config = {};
      let job = null; // photos still in flight when the card is saved
      if (type === 'game') config.game = game;
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
        config.cur = cur;
        const filled = goalDraft.filter((g) => Math.round(Number(g.amount)) > 0);
        // the order you wrote them in is the order they get paid off
        config.goals = filled.map((g) => ({
          amount: Math.round(Number(g.amount)),
          title: g.title.trim(),
          ...(g.photo ? { photo: g.photo } : {}),
        }));

        // Photos have been uploading since they were picked, but one picked a
        // second ago may still be in flight. Don't hold the card hostage to
        // it: put the card on the board now and slot the pictures in as they
        // land.
        if (filled.some((g) => g.busy)) job = { drafts: filled };
      }
      if (isEdit) {
        send({ t: 'card:edit', id: existing.id, title, emoji, config });
        if (job) attachPhotosLater(existing.id, job);
      } else {
        const ref = job ? 'r' + Math.random().toString(36).slice(2, 10) : undefined;
        if (ref) photoJobs.set(ref, job);
        send({ t: 'card:add', card: { type, title, emoji, config }, ...(ref ? { ref } : {}) });
      }
      closeModal();
    };

    setTimeout(() => $('#cf-title', box)?.focus(), 60);
  }

  /* Cards saved while one of their photos was still uploading, keyed by the
     ref the server echoes back so a quick second save can't steal the first
     one's pictures. */
  const photoJobs = new Map();

  /**
   * Finish the job the save button refused to wait for: once every photo has
   * landed, edit the card to point at them. Only the goals are sent, and they
   * are re-read off the card first, so a name or amount someone changed in
   * the meantime survives.
   */
  async function attachPhotosLater(cardId, job) {
    if (!job) return;
    await Promise.allSettled(job.drafts.map((g) => g.upload));
    if (job.drafts.some((g) => g.failed)) toast(t('photoFailed'));

    const card = cards.get(cardId);
    if (!card) return;
    const current = goalsOf(card);
    const goals = current.map((g, i) => {
      const photo = job.drafts[i]?.photo;
      return photo && photo !== g.photo ? { ...g, photo } : g;
    });
    if (goals.every((g, i) => g === current[i])) return; // nothing landed
    send({ t: 'card:edit', id: cardId, config: { ...card.config, goals } });
  }

  // ------------------------------------------------------------ photos
  /**
   * Shrink a picked photo to something worth sending. A phone hands over a
   * 12-megapixel file, so this is the most expensive thing the app ever does.
   * Decode it once — the decode dwarfs everything else, so never do it twice
   * to "measure first" — draw it down, encode.
   *
   * Deliberately a plain <canvas>: OffscreenCanvas looks like the right tool
   * and benchmarks fine in isolation, but inside the live app its
   * convertToBlob() gets starved behind other work and takes seconds where
   * toBlob() takes a tenth of one.
   */
  const MAX_EDGE = 1280;

  async function processImage(file) {
    if (file.type === 'image/gif') {
      if (file.size > 6 * 1024 * 1024) throw new Error('too-big');
      return file;
    }

    const bmp = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) throw new Error('encode-failed');
      return blob;
    } finally {
      bmp.close?.();
    }
  }

  /* Pick four photos in a row and four full-size decodes would fight over the
     same phone. One at a time, in the background, in pick order. */
  let photoQueue = Promise.resolve();
  function queueProcess(file) {
    const mine = photoQueue.then(() => processImage(file), () => processImage(file));
    photoQueue = mine.catch(() => {});
    return mine;
  }

  async function uploadBlob(blob) {
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

  const uploadPhoto = async (file) => uploadBlob(await processImage(file));

  function openLightbox(url) {
    openModal(`<img class="lightbox-img" src="${esc(url)}" alt="">`);
  }

  // ------------------------------------------------------------ chat
  function updateChatBadge() {
    const badge = $('#chat-badge');
    badge.hidden = chatUnread === 0;
    badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
  }

  /** Yours if your account wrote it — or, for guests and messages older than
      accounts, if this browser did. */
  const isMine = (m) => (m.userId ? m.userId === auth?.user?.id : m.cid === myCid);

  function chatMsgEl(m) {
    const el = document.createElement('div');
    el.className = 'msg' + (isMine(m) ? ' mine' : '');
    el.dataset.at = m.createdAt;
    const time = new Date(m.createdAt).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    el.innerHTML = `
      <div class="msg-meta">${esc(m.avatar || '')} ${esc(m.author)} · ${time}</div>
      <div class="msg-bubble">${esc(m.text)}${m.photo ? `<img class="msg-photo" src="${esc(m.photo)}" alt="" loading="lazy">` : ''}</div>
      <div class="msg-seen"></div>`;
    const img = $('.msg-photo', el);
    if (img) img.onclick = () => openLightbox(m.photo);
    return el;
  }

  /** Read receipts sit under the newest message each person has actually seen. */
  function renderSeen() {
    const mine = $$('#chat-list .msg.mine');
    $$('#chat-list .msg-seen').forEach((el) => {
      el.textContent = '';
      el.title = '';
    });
    if (!mine.length) return;

    for (const watcher of seenList) {
      // your own receipt, filed under your account or — as a guest, or before
      // the server folded the two together — under this device
      if (watcher.person === myKey() || watcher.person === myCid) continue;
      // the last message of mine they have seen
      let target = null;
      for (const el of mine) {
        if (Number(el.dataset.at) <= watcher.at) target = el;
      }
      if (!target) continue;
      const slot = $('.msg-seen', target);
      slot.textContent = `${slot.textContent} ${watcher.avatar}`.trim();
      slot.title = t('seenBy', { name: watcher.name });
    }

    // Nobody has read the last thing you said yet. Say so, rather than
    // showing nothing at all — otherwise "not read" and "receipts are broken"
    // look identical.
    const last = mine[mine.length - 1];
    const slot = $('.msg-seen', last);
    if (!slot.textContent) {
      slot.innerHTML = '<span class="tick">✓</span>';
      slot.title = t('sent');
    }
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
    renderSeen();
    markSeen();
  }

  function appendChatMsg(m) {
    const list = $('#chat-list');
    $('.chat-empty', list)?.remove();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
    list.appendChild(chatMsgEl(m));
    if (nearBottom || isMine(m)) list.scrollTop = list.scrollHeight;
    renderSeen();
    markSeen();
  }

  /** Only claim to have seen things while the chat is actually open and on screen. */
  function markSeen() {
    if (!chatOpen || document.hidden || !chatMsgs.length) return;
    const newest = chatMsgs[chatMsgs.length - 1].createdAt;
    if (newest <= lastSeenSent) return;
    lastSeenSent = newest;
    send({ t: 'chat:seen', at: newest });
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
      markSeen();
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
          body: JSON.stringify({ room: room.code, cid: myCid, lang, sub: sub.toJSON() }),
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
    initReorder();

    if (!localStorage.getItem('ct:toured')) showTour(0);
    $('#replay-tour').onclick = () => showTour(0);

    // frost and tighten the header once the board scrolls under it
    const header = $('#room-header');
    const onScroll = () => header.classList.toggle('stuck', scrollY > 12);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

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
