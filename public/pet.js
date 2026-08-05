/* A pet the two of you keep between you.
 *
 * The rules live here and only here, the same way the games do, and for the
 * same reason: the server is the one that decides what a state becomes, and
 * the browser only draws it. The difference is that a pet changes on its own
 * — it gets hungry while nobody is looking — so nothing is stored as a level
 * that has to be ticked down by a timer. Everything is stored as "when did
 * this last happen", and how the creature is doing right now is worked out
 * from the clock. That way it is right after an hour, after a night, and
 * after a server restart, without anything having been running.
 *
 * Shared between server.js and the browser; keep it free of both.
 */

export const KINDS = ['cat', 'dog', 'bunny', 'fox', 'bear', 'panda', 'penguin', 'dragon'];
export const isKind = (k) => KINDS.includes(k);

const HOUR = 3600000;

/** How long each need takes to go from full to empty, left alone. */
export const DRAIN = {
  food: 12 * HOUR,
  joy: 18 * HOUR,
  energy: 10 * HOUR,
};

/** Playing is fun and tiring; this is how much energy a round of it costs. */
const PLAY_COST = 0.18;
/** A cuddle is free, but it only goes so far on its own. */
const PET_JOY = 0.12;
const PET_COOLDOWN = 60000;

export const ACTIONS = ['feed', 'play', 'rest', 'pet'];

export function newPetState(kind, name, now) {
  return {
    kind: isKind(kind) ? kind : 'cat',
    name: String(name || '').slice(0, 24),
    born: now,
    // "topped up at" rather than "is this full" — see the note at the top
    fedAt: now,
    playedAt: now,
    restedAt: now,
    xp: 0,
    care: 0,
    last: null,
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Where each need stands right now, 0..1. */
export function needs(state, now) {
  return {
    food: clamp01(1 - (now - (state.fedAt || 0)) / DRAIN.food),
    joy: clamp01(1 - (now - (state.playedAt || 0)) / DRAIN.joy),
    energy: clamp01(1 - (now - (state.restedAt || 0)) / DRAIN.energy),
  };
}

/**
 * What the creature is doing about it. One word, because a pet that is
 * hungry and tired and bored at once should look like one thing, not three —
 * and the thing it needs most is the one worth showing.
 */
export function mood(state, now) {
  const n = needs(state, now);
  if (n.food < 0.2) return 'hungry';
  if (n.energy < 0.2) return 'sleepy';
  if (n.joy < 0.2) return 'bored';
  if (n.food > 0.7 && n.joy > 0.7 && n.energy > 0.7) return 'happy';
  return 'ok';
}

/* The bond grows on looking after it, and each level costs a little more than
   the last — so a first level arrives the same evening and a tenth takes a
   while, which is the shape people expect. */
export const levelOf = (xp) => Math.floor((Math.sqrt(1 + (8 * (xp || 0)) / 5) - 1) / 2) + 1;
export const xpForLevel = (lvl) => (5 * (lvl - 1) * lvl) / 2;

export function bond(state) {
  const xp = state.xp || 0;
  const level = levelOf(xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return { level, xp, into: xp - from, span: Math.max(1, to - from) };
}

/** What a given action is worth, and what it is allowed to do. */
const GAIN = { feed: 3, play: 3, rest: 2, pet: 1 };

/**
 * Do something for the pet. Mutates in place and returns what happened, or
 * null when there was nothing to do — a full creature refuses another meal,
 * which is the only way this can be turned down.
 */
export function act(state, action, now, who) {
  if (!ACTIONS.includes(action)) return null;
  const before = needs(state, now);

  if (action === 'feed') {
    if (before.food > 0.92) return null; // it isn't hungry
    state.fedAt = now;
  } else if (action === 'rest') {
    if (before.energy > 0.92) return null; // it isn't tired
    state.restedAt = now;
  } else if (action === 'play') {
    if (before.energy < 0.15) return null; // too tired to play
    state.playedAt = now;
    /* And it costs a nap's worth of energy. Everything here is "when was this
       last topped up", so spending energy means moving that moment further
       into the past — not closer to now. */
    state.restedAt = (state.restedAt || now) - DRAIN.energy * PLAY_COST;
  } else if (action === 'pet') {
    // a cuddle is always welcome, but not on a loop
    if (state.last?.act === 'pet' && now - state.last.at < PET_COOLDOWN) return null;
    state.playedAt = Math.min(now, (state.playedAt || now) + DRAIN.joy * PET_JOY);
  }

  state.xp = (state.xp || 0) + GAIN[action];
  state.care = (state.care || 0) + 1;
  state.last = { act: action, at: now, by: who?.name || '', avatar: who?.avatar || '' };
  return { action, mood: mood(state, now), needs: needs(state, now) };
}
