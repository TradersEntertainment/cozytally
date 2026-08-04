/* Turn-based mini games.

   The rules live here and only here: the server is the referee, and the
   browser only draws whatever state it is handed and asks for a move. That
   way a tampered client can't put a piece somewhere it doesn't belong, and
   the two of you can never disagree about the board.

   Every game shares the same frame so the card can treat them alike:

     players  [{ key, name, avatar }]   up to two, filled as people play
     turn     0 | 1                      whose seat it is
     scores   [n, n]                     rounds won, kept across games
     round    n
     over     null | { winner: 0 | 1 | 'draw', ... }

   Anything past that is the game's own business. Nothing in here touches
   the database or the socket — pure functions over a state object. */

export const GAMES = {
  xox: { emoji: '⭕', titleKey: 'gameXox' },
  connect4: { emoji: '🔵', titleKey: 'gameConnect4' },
  dots: { emoji: '⬜', titleKey: 'gameDots' },
  truths: { emoji: '🤥', titleKey: 'gameTruths' },
};

export const isGame = (g) => Object.prototype.hasOwnProperty.call(GAMES, g);

const C4_COLS = 7;
const C4_ROWS = 6;
const DOTS_N = 5; // dots per side, so 4×4 = 16 boxes

/** the empty board for a fresh round, keeping seats and scores */
function freshBoard(game) {
  if (game === 'xox') return { board: Array(9).fill(0), last: -1, line: null };
  if (game === 'connect4') {
    return { board: Array(C4_COLS * C4_ROWS).fill(0), last: -1, line: null };
  }
  if (game === 'dots') {
    return {
      h: Array(DOTS_N * (DOTS_N - 1)).fill(0),
      v: Array((DOTS_N - 1) * DOTS_N).fill(0),
      boxes: Array((DOTS_N - 1) * (DOTS_N - 1)).fill(0),
      last: null,
    };
  }
  // truths: the writer of the round makes up the statements
  return { phase: 'writing', statements: [], lie: -1, guess: -1 };
}

export function newGameState(game) {
  return {
    game,
    players: [],
    turn: 0,
    scores: [0, 0],
    round: 1,
    over: null,
    ...freshBoard(game),
  };
}

/** Start the next round. The loser — or in truths, the other person — goes first. */
export function nextRound(state) {
  const game = state.game;
  const prev = state.over;
  state.round = (state.round || 1) + 1;
  state.over = null;
  Object.assign(state, freshBoard(game));
  if (game === 'truths') {
    // the turn already sits with whoever just guessed, and it is their go to
    // make something up — so leave it exactly where it is
  } else if (prev && prev.winner === 0) {
    state.turn = 1; // the one who lost opens
  } else if (prev && prev.winner === 1) {
    state.turn = 0;
  } else {
    state.turn = state.round % 2 === 0 ? 1 : 0;
  }
  return state;
}

/** Sit someone down if there is room. Returns their seat, or -1 as a spectator. */
export function seatOf(state, person) {
  const at = state.players.findIndex((p) => p.key === person.key);
  if (at >= 0) {
    state.players[at].name = person.name;
    state.players[at].avatar = person.avatar;
    return at;
  }
  if (state.players.length >= 2) return -1;
  state.players.push({ key: person.key, name: person.name, avatar: person.avatar });
  return state.players.length - 1;
}

// ---------------------------------------------------------------- xox
const XOX_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function xoxMove(state, seat, move) {
  const cell = Number(move?.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return false;
  if (state.board[cell]) return false;
  state.board[cell] = seat + 1;
  state.last = cell;

  const mark = seat + 1;
  const line = XOX_LINES.find((l) => l.every((i) => state.board[i] === mark));
  if (line) state.over = { winner: seat, line };
  else if (state.board.every(Boolean)) state.over = { winner: 'draw' };
  return true;
}

// ---------------------------------------------------------------- connect 4
const c4At = (b, r, c) => (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS ? 0 : b[r * C4_COLS + c]);

function c4Line(board, row, col, mark) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [row * C4_COLS + col];
    for (const sign of [1, -1]) {
      for (let step = 1; step < 4; step++) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (c4At(board, r, c) !== mark) break;
        line.push(r * C4_COLS + c);
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b);
  }
  return null;
}

function connect4Move(state, seat, move) {
  const col = Number(move?.col);
  if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return false;
  // fall to the lowest free cell in the column
  let row = -1;
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (!state.board[r * C4_COLS + col]) {
      row = r;
      break;
    }
  }
  if (row < 0) return false; // column is full

  const mark = seat + 1;
  const at = row * C4_COLS + col;
  state.board[at] = mark;
  state.last = at;

  const line = c4Line(state.board, row, col, mark);
  if (line) state.over = { winner: seat, line };
  else if (state.board.every(Boolean)) state.over = { winner: 'draw' };
  return true;
}

// ---------------------------------------------------------------- dots & boxes
const hIndex = (r, c) => r * (DOTS_N - 1) + c;
const vIndex = (r, c) => r * DOTS_N + c;
const boxIndex = (r, c) => r * (DOTS_N - 1) + c;

const boxClosed = (s, r, c) =>
  s.h[hIndex(r, c)] && s.h[hIndex(r + 1, c)] && s.v[vIndex(r, c)] && s.v[vIndex(r, c + 1)];

/** Returns false for an illegal move, otherwise true; sets state.again when
    the mover closed a box and so keeps the turn. */
function dotsMove(state, seat, move) {
  const dir = move?.dir === 'v' ? 'v' : move?.dir === 'h' ? 'h' : null;
  const i = Number(move?.i);
  if (!dir || !Number.isInteger(i) || i < 0 || i >= state[dir].length) return false;
  if (state[dir][i]) return false;

  state[dir][i] = seat + 1;
  state.last = { dir, i };

  // which boxes did that edge close?
  let closed = 0;
  for (let r = 0; r < DOTS_N - 1; r++) {
    for (let c = 0; c < DOTS_N - 1; c++) {
      const b = boxIndex(r, c);
      if (state.boxes[b] || !boxClosed(state, r, c)) continue;
      state.boxes[b] = seat + 1;
      closed++;
    }
  }
  state.again = closed > 0; // closing a box earns another go

  if (state.boxes.every(Boolean)) {
    const mine = state.boxes.filter((b) => b === 1).length;
    const theirs = state.boxes.filter((b) => b === 2).length;
    state.over = { winner: mine === theirs ? 'draw' : mine > theirs ? 0 : 1, boxes: [mine, theirs] };
  }
  return true;
}

// ---------------------------------------------------------------- two truths
function truthsMove(state, seat, move) {
  if (state.phase === 'writing') {
    const lines = Array.isArray(move?.statements) ? move.statements : [];
    const cleaned = lines.slice(0, 3).map((s) => String(s ?? '').trim().slice(0, 120));
    if (cleaned.length !== 3 || cleaned.some((s) => !s)) return false;
    const lie = Number(move?.lie);
    if (!Number.isInteger(lie) || lie < 0 || lie > 2) return false;
    state.statements = cleaned;
    state.lie = lie;
    state.phase = 'guessing';
    return true;
  }
  if (state.phase === 'guessing') {
    const guess = Number(move?.guess);
    if (!Number.isInteger(guess) || guess < 0 || guess > 2) return false;
    state.guess = guess;
    state.phase = 'done';
    // guessing right beats the writer; being fooled hands them the point
    state.over = { winner: guess === state.lie ? seat : seat === 0 ? 1 : 0, lie: state.lie, guess };
    return true;
  }
  return false;
}

/**
 * Play one move. Returns what happened so the caller can decide who to tell:
 *   { ok, passed }  passed = the turn moved to the other person
 * The state object is mutated in place only when ok is true.
 */
export function applyMove(state, seat, move) {
  if (state.over) return { ok: false };
  if (seat !== 0 && seat !== 1) return { ok: false };
  // the turn is the only gate that matters: after you play it belongs to the
  // other chair, and you can't sit in two chairs at once
  if (state.turn !== seat) return { ok: false };

  state.again = false;
  const before = state.turn;
  const ok = {
    xox: xoxMove,
    connect4: connect4Move,
    dots: dotsMove,
    truths: truthsMove,
  }[state.game]?.(state, seat, move);
  if (!ok) return { ok: false };

  if (!state.over && !state.again) state.turn = seat === 0 ? 1 : 0;
  if (state.over && state.over.winner !== 'draw') state.scores[state.over.winner]++;
  return { ok: true, passed: state.turn !== before };
}

/**
 * What the browser is allowed to see. The lie has to stay on the server
 * while it is still being guessed, or anyone could read it straight out of
 * the page.
 */
export function redactGame(state) {
  if (state?.game === 'truths' && state.phase === 'guessing') {
    const { lie, ...rest } = state;
    return rest;
  }
  return state;
}

export const GAME_SIZES = { C4_COLS, C4_ROWS, DOTS_N };
