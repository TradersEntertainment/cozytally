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
  hangman: { emoji: '🔤', titleKey: 'gameHangman' },
  code: { emoji: '🔢', titleKey: 'gameCode' },
  chain: { emoji: '🔗', titleKey: 'gameChain' },
  rps: { emoji: '✊', titleKey: 'gameRps' },
  closest: { emoji: '🎯', titleKey: 'gameClosest' },
  mangala: { emoji: '🌰', titleKey: 'gameMangala' },
  battle: { emoji: '🚢', titleKey: 'gameBattle' },
  truths: { emoji: '🤥', titleKey: 'gameTruths' },
};

export const isGame = (g) => Object.prototype.hasOwnProperty.call(GAMES, g);

/* Games that keep their own door rather than being locked to state.turn.
   Rock-paper-scissors and Closest have no turn at all — you both answer at
   once, and the usual gate would lock one of you out. Battleship does have a
   turn, but only in its second half: while the fleets are being laid out you
   are both busy, so it opens its own door and closes it again once the
   shooting starts. */
const SELF_GATED = new Set(['rps', 'closest', 'battle']);
/** ...and of those, the two with no turn to hand over at all. */
const TURNLESS = new Set(['rps', 'closest']);

const C4_COLS = 7;
const C4_ROWS = 6;
const DOTS_N = 5; // dots per side, so 4×4 = 16 boxes
const RV_N = 8; // reversi is 8×8, like the real thing
export const HANGMAN_LIVES = 6;
export const CODE_LEN = 4;
export const CODE_TRIES = 10;
const RPS_TARGET = 3; // best of five
export const CLOSEST_ROUND = 10; // questions per round

/** Turkish needs its own casing: i→İ and ı→I, which plain toUpperCase gets wrong. */
export const trUpper = (s) => String(s ?? '').toLocaleUpperCase('tr');
const TR_LETTERS = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ';
export const TR_ALPHABET = [...TR_LETTERS];
const isTurkishWord = (w) => w.length > 0 && [...w].every((c) => TR_LETTERS.includes(c));

/** the empty board for a fresh round, keeping seats and scores */
function freshBoard(game, opts = {}) {
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
    /* The house rules are agreed when the card is made and carried in the
       state so the rules and both screens all read the same ones. */
    return {
      words: [],
      gaveUp: -1,
      dict: opts.dict === 'tr' ? 'tr' : 'free',
      limit: Number(opts.limit) || 0,
      deadline: 0,
      timedOut: -1,
    };
  }
  if (game === 'rps') {
    return { picks: [null, null], wins: [0, 0], history: [], reveal: null };
  }
  if (game === 'battle') {
    return {
      phase: 'placing',
      fleets: [btDeal(), btDeal()],
      ready: [false, false],
      // shots[s] is what s has fired at the OTHER sea: 0 nothing, 1 miss, 2 hit
      shots: [Array(BT_N * BT_N).fill(0), Array(BT_N * BT_N).fill(0)],
      sunk: [[], []], // which of each fleet has gone down
      last: -1,
      sank: -1,
    };
  }
  if (game === 'mangala') {
    // twelve holes of four, and two empty treasuries at 6 and 13
    const pits = Array(14).fill(4);
    pits[6] = 0;
    pits[13] = 0;
    return { pits, from: -1, sow: 0, last: -1, took: [], swept: -1 };
  }
  if (game === 'closest') {
    /* The questions are dealt in by whoever starts the round — the server, so
       the answers never sit in a browser. See questions.js, which lives
       outside public/ for exactly that reason. */
    return {
      qs: (opts.questions || []).slice(0, CLOSEST_ROUND),
      at: 0,
      guesses: [null, null],
      reveal: null,
      wins: [0, 0],
      history: [],
    };
  }
  // truths: the writer of the round makes up the statements
  return { phase: 'writing', statements: [], lie: -1, guess: -1 };
}

export function newGameState(game, opts = {}) {
  return {
    game,
    players: [],
    turn: 0,
    scores: [0, 0],
    round: 1,
    over: null,
    ...freshBoard(game, opts),
  };
}

/** Games where one person sets a puzzle and the other solves it. After a
    round the roles swap, which happens by itself: the turn is already sitting
    with the solver, and next round setting is their job. */
const PUZZLE_GAMES = new Set(['truths', 'hangman', 'code']);

/** Start the next round. The loser goes first, so a thrashing evens out. */
export function nextRound(state, opts = {}) {
  const game = state.game;
  const prev = state.over;
  state.round = (state.round || 1) + 1;
  state.over = null;
  Object.assign(state, freshBoard(game, opts));
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
/* A space is a word break, not a letter: "SU BÖREĞİ" is two words on two
   lines and nobody has to guess the gap. Everything else about the word —
   which letters are in it, when it is solved — ignores the spaces. */
const hangmanLetters = (word) => [...word].filter((c) => c !== ' ');

function hangmanMove(state, seat, move) {
  if (state.phase === 'writing') {
    const word = trUpper(move?.word).replace(/\s+/g, ' ').trim();
    const letters = hangmanLetters(word);
    if (letters.length < 3 || word.length > 24) return false;
    if (!letters.every((c) => TR_LETTERS.includes(c))) return false;
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

  if (hangmanLetters(state.word).every((c) => state.guessed.includes(c))) {
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

/* Whether a word is in the dictionary is the server's call, so the list is
   handed in at boot from words.js — which lives outside public/. In a browser
   this is never set, and dictionary mode simply doesn't second-guess the
   referee. */
let dictHas = null;
export const useDictionary = (fn) => {
  dictHas = fn;
};

/** Why a word bounced, so the card can say something better than nothing. */
export const CHAIN_REASONS = { letters: 1, letter: 2, repeat: 3, dict: 4 };

function chainMove(state, seat, move) {
  if (move?.giveUp) {
    state.gaveUp = seat;
    state.over = { winner: seat === 0 ? 1 : 0, length: state.words.length };
    return true;
  }
  const word = trUpper(move?.word).replace(/\s+/g, '');
  if (word.length < 2 || word.length > 24 || !isTurkishWord(word)) {
    state.why = CHAIN_REASONS.letters;
    return false;
  }
  if (state.words.some((w) => w.text === word)) {
    state.why = CHAIN_REASONS.repeat;
    return false;
  }
  const prev = state.words[state.words.length - 1];
  if (prev && word[0] !== chainLetter(prev.text)) {
    state.why = CHAIN_REASONS.letter;
    return false;
  }
  if (state.dict === 'tr' && dictHas && !dictHas(word)) {
    state.why = CHAIN_REASONS.dict;
    return false;
  }

  state.why = 0;
  state.words.push({ text: word, by: seat });
  return true;
}

/** The clock ran out on whoever's turn it is. Server-only — this is not a
    move, so nothing a browser sends can reach it. */
export function chainTimeout(state) {
  if (state.game !== 'chain' || state.over) return false;
  const loser = state.turn;
  state.timedOut = loser;
  state.over = { winner: loser === 0 ? 1 : 0, length: state.words.length, timeout: true };
  state.scores[state.over.winner]++;
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

// ---------------------------------------------------------------- closest guess
/** Distance is all that matters, so a wild guess is never worse than a blank. */
function closestScore(state) {
  const q = state.qs[state.at];
  const [a, b] = state.guesses;
  const da = Math.abs(a - q.a);
  const db = Math.abs(b - q.a);
  const winner = da === db ? 'draw' : da < db ? 0 : 1;
  state.reveal = { answer: q.a, guesses: [a, b], winner };
  state.history.push(winner);
  if (winner !== 'draw') state.wins[winner]++;
}

function closestMove(state, seat, move) {
  if (state.reveal) {
    // the answer is on screen; either of you can move it along
    if (!move?.next) return false;
    if (state.at + 1 >= state.qs.length) return false;
    state.at++;
    state.reveal = null;
    state.guesses = [null, null];
    return true;
  }
  if (!state.qs.length) return false;
  if (state.guesses[seat] !== null) return false; // no changing your answer

  const guess = Number(move?.guess);
  if (!Number.isFinite(guess) || guess < 0 || guess > 1e15) return false;
  state.guesses[seat] = guess;
  if (state.guesses[0] === null || state.guesses[1] === null) return true;

  closestScore(state);
  if (state.at + 1 >= state.qs.length) {
    const [x, y] = state.wins;
    state.over = { winner: x === y ? 'draw' : x > y ? 0 : 1, wins: [x, y] };
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

/* ---------------------------------------------------------------- mangala
 *
 * The Turkish sowing game. Fourteen holes in a ring: 0-5 belong to the first
 * player and 7-12 to the second, with each one's treasury sitting at the end
 * of their own row (6 and 13). Stones travel anticlockwise — which on a board
 * drawn this way means simply "the next index" — and you sow past your own
 * treasury but never into theirs, which is what makes the ring fourteen holes
 * long for one of you and thirteen for the other.
 *
 * Rules are the Ata Sporları Federasyonu ones. Two of them are what make this
 * Turkish rather than any other mancala: you leave one stone behind in the
 * hole you emptied, and whoever clears their own side FIRST takes everything
 * still sitting on the other side. That second one is worth reading twice —
 * running out is how you win, not how you lose.
 */
const MG_STORE = [6, 13];
/** the hole facing this one across the board */
const mgAcross = (i) => 12 - i;
const mgOwns = (i, seat) => (seat === 0 ? i >= 0 && i <= 5 : i >= 7 && i <= 12);
const mgSide = (seat) => (seat === 0 ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12]);

/**
 * The holes one move drops a stone into, in the order they get one.
 *
 * Pure arithmetic over "which hole, how many stones, whose turn" — it never
 * looks at the board. That matters: the browser has to replay the sowing
 * after the fact, when the hole it started from has already been emptied.
 * The move below walks this same list, so what you watch is what happened.
 */
export function mangalaPath(from, count, seat) {
  if (!(count > 0)) return [];
  const theirs = MG_STORE[seat === 0 ? 1 : 0];
  // a lone stone simply moves along; any more and one of them stays home
  const drop = count === 1 ? 1 : count - 1;
  const path = [];
  let i = from;
  while (path.length < drop) {
    i = (i + 1) % 14;
    if (i === theirs) continue;
    path.push(i);
  }
  return path;
}

function mangalaMove(state, seat, move) {
  const from = Number(move?.pit);
  if (!Number.isInteger(from) || !mgOwns(from, seat)) return false;
  const pits = state.pits;
  if (!pits[from]) return false; // nothing to pick up

  const sow = pits[from];
  const path = mangalaPath(from, sow, seat);
  pits[from] = sow === 1 ? 0 : 1; // the one left behind
  for (const i of path) pits[i]++;

  const last = path[path.length - 1];
  const mine = MG_STORE[seat];
  state.from = from;
  state.sow = sow; // what was in hand, so the board can replay the journey
  state.last = last;
  state.took = [];
  state.swept = -1;

  if (last === mine) {
    state.again = true; // home in one — go again
  } else if (mgOwns(last, seat === 0 ? 1 : 0) && pits[last] % 2 === 0) {
    // landing on their side and evening the hole out takes all of it
    pits[mine] += pits[last];
    pits[last] = 0;
    state.took = [last];
  } else if (mgOwns(last, seat) && pits[last] === 1 && pits[mgAcross(last)] > 0) {
    // your last stone found one of your own holes empty: it and everything
    // facing it are yours
    const across = mgAcross(last);
    pits[mine] += pits[across] + 1;
    pits[across] = 0;
    pits[last] = 0;
    state.took = [last, across];
  }

  const empty = [0, 1].map((s) => mgSide(s).every((i) => !pits[i]));
  if (empty[0] || empty[1]) {
    /* Whoever's side is bare takes whatever is left on the other. It reads
       oddly the first time — you are rewarded for running out — but it is the
       rule, and it turns the endgame into a race rather than a stall. */
    const done = empty[0] ? 0 : 1;
    let swept = 0;
    for (const i of mgSide(done === 0 ? 1 : 0)) {
      swept += pits[i];
      pits[i] = 0;
    }
    pits[MG_STORE[done]] += swept;
    state.swept = swept ? done : -1;
    state.again = false;
    const [a, b] = [pits[6], pits[13]];
    state.over = { winner: a === b ? 'draw' : a > b ? 0 : 1, stones: [a, b] };
  }
  return true;
}

/* ---------------------------------------------------------------- battleship
 *
 * The only game here where the two of you are looking at genuinely different
 * pictures: my fleet is mine to know and yours is yours, and neither of us
 * may see the other's until we have shot it. Every other secret in this file
 * is a secret from both browsers at once — a word nobody has guessed, a hand
 * nobody has opened — and could be held back with one rule for everyone.
 * This one cannot, which is why redactGame learned to ask who is asking.
 *
 * Laying out is done by dealing rather than dragging: you take a fleet,
 * reshuffle it as often as you like, and say when you are happy. On a phone
 * that is a better game than nudging four rectangles around a grid, and the
 * arrangement you end up with is no less yours for having been offered.
 */
export const BT_N = 7; // a 7×7 sea; 8×8 makes for a long hunt on a phone
export const BT_FLEET = [4, 3, 2, 2];
const btAt = (r, c) => r * BT_N + c;

/** Lay a fleet down at random, never touching, never overlapping. */
function btDeal() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const taken = new Set(); // hulls and the water around them
    const hull = new Set();
    const ships = [];
    let ok = true;
    for (const len of BT_FLEET) {
      let placed = false;
      for (let go = 0; go < 200 && !placed; go++) {
        const down = Math.random() < 0.5;
        const r = Math.floor(Math.random() * (down ? BT_N - len + 1 : BT_N));
        const c = Math.floor(Math.random() * (down ? BT_N : BT_N - len + 1));
        const cells = Array.from({ length: len }, (_, k) => (down ? btAt(r + k, c) : btAt(r, c + k)));
        if (cells.some((i) => taken.has(i))) continue;
        cells.forEach((i) => hull.add(i));
        /* Ships may not touch, not even corner to corner — otherwise two of
           them read as one long one and the hunt stops making sense. */
        for (const i of cells) {
          const rr = Math.floor(i / BT_N);
          const cc = i % BT_N;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nr = rr + dr;
              const nc = cc + dc;
              if (nr >= 0 && nr < BT_N && nc >= 0 && nc < BT_N) taken.add(btAt(nr, nc));
            }
          }
        }
        ships.push({ len, cells });
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  return []; // unreachable with this fleet on this board, but never loop forever
}

const btSunk = (ship, shots) => ship.cells.every((i) => shots[i] === 2);

function battleMove(state, seat, move) {
  const other = seat === 0 ? 1 : 0;

  if (state.phase === 'placing') {
    if (state.ready[seat]) return false; // you already said you were happy
    if (move?.shuffle) {
      state.fleets[seat] = btDeal();
      return true;
    }
    if (!move?.ready) return false;
    state.ready[seat] = true;
    if (state.ready[0] && state.ready[1]) {
      state.phase = 'firing';
      state.turn = seat === 0 ? 1 : 0; // whoever finished first has been waiting
    }
    return true;
  }

  if (state.turn !== seat) return false; // the gate this game keeps itself
  const cell = Number(move?.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell >= BT_N * BT_N) return false;
  const shots = state.shots[seat];
  if (shots[cell]) return false; // no shooting the same water twice

  const hit = state.fleets[other].find((sh) => sh.cells.includes(cell));
  shots[cell] = hit ? 2 : 1;
  state.last = cell;
  state.sank = -1;

  if (!hit) {
    state.turn = other; // a miss is what ends your go
    return true;
  }
  state.again = true; // a hit earns another shot
  const which = state.fleets[other].indexOf(hit);
  if (btSunk(hit, shots)) {
    state.sunk[other].push(which);
    state.sank = hit.len;
  }
  if (state.sunk[other].length === state.fleets[other].length) {
    state.again = false;
    state.over = { winner: seat, left: state.fleets[seat].length - state.sunk[seat].length };
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
  if (!SELF_GATED.has(state.game) && state.turn !== seat) return { ok: false };

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
    closest: closestMove,
    mangala: mangalaMove,
    battle: battleMove,
    truths: truthsMove,
  }[state.game]?.(state, seat, move);
  if (!ok) return { ok: false };

  if (!state.over && !state.again && !SELF_GATED.has(state.game)) {
    state.turn = seat === 0 ? 1 : 0;
  }
  if (state.over && state.over.winner !== 'draw') state.scores[state.over.winner]++;
  /* Whether the nudge belongs to the other person now. Anything with a turn
     answers that by whether the turn moved; the two games without one hand it
     over the moment you have answered and they have not. */
  const passed = TURNLESS.has(state.game)
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
export function redactGame(state, forKey) {
  if (!state) return state;

  if (state.game === 'battle') {
    /* The one game where the two of you are owed different pictures, so this
       is the one place that has to know who is asking. Your own fleet comes
       through whole; theirs arrives as bare hull lengths — enough to know
       what is still out there, nothing about where. A ship you have sunk is
       yours to see, and once it is over so is everything. Someone watching
       from a third chair is told no more than the wrecks. */
    const players = state.players || [];
    const sat = players.findIndex((p) => p.key === forKey);
    /* Chairs are taken by playing, so the second person has not got one yet
       when the card first reaches them — and laying out a fleet you cannot
       see would be a poor game. The chair they would take is the one the
       browser would seat them in, and the fleet waiting in it belongs to
       nobody until they do. Once both chairs are full this closes, and
       anyone else watching is back to seeing only the wrecks. */
    const me = sat >= 0 ? sat : players.length < 2 ? players.length : -1;
    const done = !!state.over;
    return {
      ...state,
      fleets: state.fleets.map((fleet, s) =>
        fleet.map((ship, i) =>
          done || s === me || state.sunk[s].includes(i) ? ship : { len: ship.len })),
    };
  }

  if (state.game === 'truths' && state.phase === 'guessing') {
    const { lie, ...rest } = state;
    return rest;
  }

  if (state.game === 'hangman' && state.phase !== 'done') {
    const { word, ...rest } = state;
    // the shape of the word and the letters found so far — never the word
    return {
      ...rest,
      // a space stays a space, so the shape of the phrase is visible from the
      // start; every other letter is null until somebody finds it
      mask: [...(word || '')].map((c) => (c === ' ' || state.guessed.includes(c) ? c : null)),
      misses: state.guessed.filter((c) => !(word || '').includes(c)),
    };
  }

  if (state.game === 'code' && state.phase !== 'done') {
    const { secret, ...rest } = state;
    return rest; // the scored guesses are enough to play from
  }

  if (state.game === 'closest') {
    const { qs, guesses, ...rest } = state;
    const q = qs[state.at];
    return {
      ...rest,
      // the question, never the answer — and never what the other one wrote
      q: q ? { tr: q.tr, en: q.en, u: q.u } : null,
      total: qs.length,
      chosen: [guesses[0] !== null, guesses[1] !== null],
    };
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
