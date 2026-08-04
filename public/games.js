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
  reversi: { emoji: '⚫', titleKey: 'gameReversi' },
  hangman: { emoji: '🎈', titleKey: 'gameHangman' },
  code: { emoji: '🔢', titleKey: 'gameCode' },
  chain: { emoji: '🔗', titleKey: 'gameChain' },
  rps: { emoji: '✊', titleKey: 'gameRps' },
  truths: { emoji: '🤥', titleKey: 'gameTruths' },
};

export const isGame = (g) => Object.prototype.hasOwnProperty.call(GAMES, g);

/* Rock-paper-scissors is the odd one out: both people choose at once and
   nothing is revealed until the second choice lands, so the usual "is it
   your turn" gate would lock one of them out. */
const SIMULTANEOUS = new Set(['rps']);

const C4_COLS = 7;
const C4_ROWS = 6;
const DOTS_N = 5; // dots per side, so 4×4 = 16 boxes
const RV_N = 8; // reversi is 8×8, like the real thing
export const HANGMAN_LIVES = 6;
export const CODE_LEN = 4;
export const CODE_TRIES = 10;
const RPS_TARGET = 3; // best of five

/** Turkish needs its own casing: i→İ and ı→I, which plain toUpperCase gets wrong. */
export const trUpper = (s) => String(s ?? '').toLocaleUpperCase('tr');
const TR_LETTERS = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ';
export const TR_ALPHABET = [...TR_LETTERS];
const isTurkishWord = (w) => w.length > 0 && [...w].every((c) => TR_LETTERS.includes(c));

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
  if (game === 'reversi') {
    const board = Array(RV_N * RV_N).fill(0);
    // the four in the middle that every game opens with
    const m = RV_N / 2;
    board[rv(m - 1, m - 1)] = 2;
    board[rv(m, m)] = 2;
    board[rv(m - 1, m)] = 1;
    board[rv(m, m - 1)] = 1;
    return { board, last: -1, flipped: [], passed: false };
  }
  if (game === 'hangman') {
    return { phase: 'writing', word: '', guessed: [], wrong: 0 };
  }
  if (game === 'code') {
    return { phase: 'writing', secret: '', tries: [] };
  }
  if (game === 'chain') {
    return { words: [], gaveUp: -1 };
  }
  if (game === 'rps') {
    return { picks: [null, null], wins: [0, 0], history: [], reveal: null };
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

/** Games where one person sets a puzzle and the other solves it. After a
    round the roles swap, which happens by itself: the turn is already sitting
    with the solver, and next round setting is their job. */
const PUZZLE_GAMES = new Set(['truths', 'hangman', 'code']);

/** Start the next round. The loser goes first, so a thrashing evens out. */
export function nextRound(state) {
  const game = state.game;
  const prev = state.over;
  state.round = (state.round || 1) + 1;
  state.over = null;
  Object.assign(state, freshBoard(game));
  if (PUZZLE_GAMES.has(game)) {
    // leave the turn exactly where it is — see PUZZLE_GAMES
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

// ---------------------------------------------------------------- reversi
const rv = (r, c) => r * RV_N + c;
const RV_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** Every disc this move would turn over, or [] if it isn't a legal move. */
function rvGains(board, at, mark) {
  if (board[at]) return [];
  const row = Math.floor(at / RV_N);
  const col = at % RV_N;
  const gains = [];
  for (const [dr, dc] of RV_DIRS) {
    const run = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < RV_N && c >= 0 && c < RV_N && board[rv(r, c)] === 3 - mark) {
      run.push(rv(r, c));
      r += dr;
      c += dc;
    }
    // the run only counts if one of your own discs closes it off
    if (run.length && r >= 0 && r < RV_N && c >= 0 && c < RV_N && board[rv(r, c)] === mark) {
      gains.push(...run);
    }
  }
  return gains;
}

export const reversiMoves = (board, mark) =>
  board.map((_, i) => i).filter((i) => rvGains(board, i, mark).length > 0);

/** how much a square is worth, for hints and for the walkthrough's play */
export const reversiGains = (board, at, mark) => rvGains(board, at, mark);
export const RV_CORNERS = [0, RV_N - 1, RV_N * (RV_N - 1), RV_N * RV_N - 1];

const rvCount = (board) => [
  board.filter((v) => v === 1).length,
  board.filter((v) => v === 2).length,
];

function rvFinish(state) {
  const [a, b] = rvCount(state.board);
  state.over = { winner: a === b ? 'draw' : a > b ? 0 : 1, boxes: [a, b] };
}

function reversiMove(state, seat, move) {
  const at = Number(move?.at);
  if (!Number.isInteger(at) || at < 0 || at >= RV_N * RV_N) return false;
  const mark = seat + 1;
  const gains = rvGains(state.board, at, mark);
  if (!gains.length) return false;

  state.board[at] = mark;
  for (const i of gains) state.board[i] = mark;
  state.last = at;
  state.flipped = gains;

  // if the next player has nowhere to go the turn bounces back; if neither
  // of you can move, the board is done wherever it stands
  const theirs = reversiMoves(state.board, 3 - mark);
  if (theirs.length) {
    state.passed = false;
    return true;
  }
  const mine = reversiMoves(state.board, mark);
  if (!mine.length) {
    rvFinish(state);
    return true;
  }
  state.passed = true; // they sit this one out
  state.again = true; // which means you go again
  return true;
}

// ---------------------------------------------------------------- hangman
function hangmanMove(state, seat, move) {
  if (state.phase === 'writing') {
    const word = trUpper(move?.word).replace(/\s+/g, '');
    if (word.length < 3 || word.length > 20 || !isTurkishWord(word)) return false;
    state.word = word;
    state.phase = 'guessing';
    return true;
  }
  if (state.phase !== 'guessing') return false;

  const letter = trUpper(move?.letter);
  if (letter.length !== 1 || !TR_LETTERS.includes(letter)) return false;
  if (state.guessed.includes(letter)) return false;

  state.guessed.push(letter);
  const hit = state.word.includes(letter);
  if (!hit) state.wrong++;

  if ([...state.word].every((c) => state.guessed.includes(c))) {
    state.phase = 'done';
    state.over = { winner: seat, word: state.word }; // the guesser got there
  } else if (state.wrong >= HANGMAN_LIVES) {
    state.phase = 'done';
    state.over = { winner: seat === 0 ? 1 : 0, word: state.word }; // the word held
  } else {
    state.again = true; // guessing is one long turn, right or wrong
  }
  return true;
}

// ---------------------------------------------------------------- number code
/** bulls = right digit in the right place, cows = right digit, wrong place */
function scoreCode(secret, guess) {
  let bulls = 0;
  let cows = 0;
  for (let i = 0; i < secret.length; i++) {
    if (guess[i] === secret[i]) bulls++;
    else if (secret.includes(guess[i])) cows++;
  }
  return { bulls, cows };
}

const distinctDigits = (s) =>
  s.length === CODE_LEN && /^\d+$/.test(s) && new Set(s).size === CODE_LEN;

function codeMove(state, seat, move) {
  if (state.phase === 'writing') {
    const secret = String(move?.secret ?? '').trim();
    if (!distinctDigits(secret)) return false;
    state.secret = secret;
    state.phase = 'guessing';
    return true;
  }
  if (state.phase !== 'guessing') return false;

  const guess = String(move?.guess ?? '').trim();
  if (!distinctDigits(guess)) return false;

  const { bulls, cows } = scoreCode(state.secret, guess);
  state.tries.push({ guess, bulls, cows });

  if (bulls === CODE_LEN) {
    state.phase = 'done';
    state.over = { winner: seat, secret: state.secret, tries: state.tries.length };
  } else if (state.tries.length >= CODE_TRIES) {
    state.phase = 'done';
    state.over = { winner: seat === 0 ? 1 : 0, secret: state.secret, tries: state.tries.length };
  } else {
    state.again = true; // keep guessing until you crack it or run out
  }
  return true;
}

// ---------------------------------------------------------------- word chain
/** Turkish words never begin with ğ, so a word ending in one hands over the
    letter before it instead of an impossible turn. */
export function chainLetter(word) {
  const w = trUpper(word);
  for (let i = w.length - 1; i >= 0; i--) {
    if (w[i] !== 'Ğ') return w[i];
  }
  return w[w.length - 1] || '';
}

function chainMove(state, seat, move) {
  if (move?.giveUp) {
    state.gaveUp = seat;
    state.over = { winner: seat === 0 ? 1 : 0, length: state.words.length };
    return true;
  }
  const word = trUpper(move?.word).replace(/\s+/g, '');
  if (word.length < 2 || word.length > 24 || !isTurkishWord(word)) return false;
  if (state.words.some((w) => w.text === word)) return false; // already said
  const prev = state.words[state.words.length - 1];
  if (prev && word[0] !== chainLetter(prev.text)) return false;

  state.words.push({ text: word, by: seat });
  return true;
}

// ---------------------------------------------------------------- rock paper scissors
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function rpsMove(state, seat, move) {
  // a new round starts the moment the last one has been seen
  if (state.reveal) {
    state.reveal = null;
    state.picks = [null, null];
  }
  const pick = String(move?.pick ?? '');
  if (!RPS_BEATS[pick]) return false;
  if (state.picks[seat]) return false; // no changing your mind

  state.picks[seat] = pick;
  if (!state.picks[0] || !state.picks[1]) return true; // still waiting

  const [a, b] = state.picks;
  const winner = a === b ? 'draw' : RPS_BEATS[a] === b ? 0 : 1;
  state.reveal = { picks: [a, b], winner };
  state.history.push(winner);
  if (winner !== 'draw') state.wins[winner]++;

  if (state.wins[0] >= RPS_TARGET || state.wins[1] >= RPS_TARGET) {
    state.over = { winner: state.wins[0] > state.wins[1] ? 0 : 1, wins: [...state.wins] };
  }
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
  // other chair, and you can't sit in two chairs at once. Games where both
  // choose at the same time police themselves instead.
  if (!SIMULTANEOUS.has(state.game) && state.turn !== seat) return { ok: false };

  state.again = false;
  const before = state.turn;
  const ok = {
    xox: xoxMove,
    connect4: connect4Move,
    dots: dotsMove,
    reversi: reversiMove,
    hangman: hangmanMove,
    code: codeMove,
    chain: chainMove,
    rps: rpsMove,
    truths: truthsMove,
  }[state.game]?.(state, seat, move);
  if (!ok) return { ok: false };

  if (!state.over && !state.again && !SIMULTANEOUS.has(state.game)) {
    state.turn = seat === 0 ? 1 : 0;
  }
  if (state.over && state.over.winner !== 'draw') state.scores[state.over.winner]++;
  // in a simultaneous game the nudge belongs to the other person the moment
  // you have chosen and they have not
  const passed = SIMULTANEOUS.has(state.game)
    ? !state.reveal && !state.over
    : state.turn !== before;
  return { ok: true, passed };
}

/**
 * What the browser is allowed to see.
 *
 * Several of these games are only games because one side does not know
 * something. That secret has to stay on the server for as long as it is
 * secret — send it and anyone can read it straight out of the page, and
 * the game is over before it starts.
 */
export function redactGame(state) {
  if (!state) return state;

  if (state.game === 'truths' && state.phase === 'guessing') {
    const { lie, ...rest } = state;
    return rest;
  }

  if (state.game === 'hangman' && state.phase !== 'done') {
    const { word, ...rest } = state;
    // the shape of the word and the letters found so far — never the word
    return {
      ...rest,
      mask: [...(word || '')].map((c) => (state.guessed.includes(c) ? c : null)),
      misses: state.guessed.filter((c) => !(word || '').includes(c)),
    };
  }

  if (state.game === 'code' && state.phase !== 'done') {
    const { secret, ...rest } = state;
    return rest; // the scored guesses are enough to play from
  }

  if (state.game === 'rps') {
    // while a round is live, neither pick is anybody's business but the
    // person who made it — so send only who has and hasn't chosen
    if (!state.reveal) {
      const { picks, ...rest } = state;
      return { ...rest, chosen: [!!picks[0], !!picks[1]] };
    }
    return { ...state, chosen: [true, true] };
  }

  return state;
}

export const GAME_SIZES = { C4_COLS, C4_ROWS, DOTS_N, RV_N };
