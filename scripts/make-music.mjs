#!/usr/bin/env node
/* The music the room can play.

   Four short pieces, generated once and committed. Each is crossfaded onto
   itself so it comes round without a seam, levelled to the same quiet, and
   encoded small enough that choosing one costs about half a megabyte.

   They are made rather than licensed because a room is a place somebody
   leaves open for hours: it needs music with nothing in it that asks to be
   listened to, and nothing in it anybody has to keep paying for.

   Needs: ELEVENLABS_API_KEY in the environment, and ffmpeg on the path.
   The key is never written down here — a key in a repository is a key that
   has been given away.

   Run: ELEVENLABS_API_KEY=... node scripts/make-music.mjs
   Writes: public/music/<key>.mp3
*/

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY = process.env.ELEVENLABS_API_KEY;
const OUT = path.join(process.cwd(), 'public', 'music');
const LENGTH_MS = 45000;
const FADE = 2.5; // seconds of the end folded back over the beginning

const PIECES = [
  ['gece',
   'Gentle lo-fi lullaby for a cosy night. Soft felt piano and a sparse music box melody over a warm pad, slow tempo around 60 BPM, tape warmth, no drums, no vocals, seamless and calm, loopable background music.'],
  ['yildiz',
   'Dreamy ambient for a night sky. Very slow shimmering synth pad with a sparse celesta arpeggio, wide reverb, weightless and spacious, no drums, no vocals, loopable background music.'],
  ['yagmur',
   'Quiet ambient rain. Soft rainfall and distant thunder under a very slow warm synth pad, almost no melody, deeply calm, no drums, no vocals, loopable background ambience.'],
  ['sabah',
   'Warm gentle morning music. Soft nylon string guitar harmonics and a quiet rhodes piano, slow and unhurried, cosy and hopeful, no drums, no vocals, loopable background music.'],
];

if (!KEY) {
  console.error('ELEVENLABS_API_KEY yok. Çalıştırma: ELEVENLABS_API_KEY=... node scripts/make-music.mjs');
  process.exit(1);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-music-'));
await fs.mkdir(OUT, { recursive: true });

const seconds = async (file) => {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return Number(stdout.trim());
};

for (const [name, prompt] of PIECES) {
  process.stdout.write(name.padEnd(10));
  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: LENGTH_MS }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    console.log(`başarısız (${res.status})`);
    continue;
  }
  const raw = path.join(tmp, name + '.mp3');
  await fs.writeFile(raw, Buffer.from(await res.arrayBuffer()));

  /* Decoded to WAV first: the trims below are in seconds, and a VBR mp3's
     duration is a guess until somebody has actually counted the samples. */
  const wav = path.join(tmp, name + '.wav');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ar', '44100', '-ac', '2', wav]);

  const cut = (await seconds(wav)) - FADE;
  const out = path.join(OUT, name + '.mp3');
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-t', String(cut), '-i', wav,
    '-ss', String(cut), '-i', wav,
    // the tail laid over the head: play it on repeat and the join is inaudible
    '-filter_complex',
    `[1:a][0:a]acrossfade=d=${FADE}:c1=tri:c2=tri[x];[x]loudnorm=I=-21:TP=-2:LRA=9[o]`,
    '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '80k', '-ar', '44100', out,
  ]);
  const { size } = await fs.stat(out);
  console.log(`${Math.round(size / 1024)} KB · ${(await seconds(out)).toFixed(1)} sn`);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log('\npublic/music/ hazır');
