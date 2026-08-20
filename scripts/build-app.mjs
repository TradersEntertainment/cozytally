/* Assemble the folder the native app ships with.

   The point of copying rather than pointing at a URL: an app that carries its
   own copy opens instantly, works on a plane, and is not "a website in a
   wrapper" — which is the thing App Store review sends back under 4.2. The
   only thing the server is asked for after this is data.

   The one line that changes is config.js, which is how the bundle knows where
   its server is. Everything else is byte-for-byte the web app, so there is no
   second copy of the code to keep in step. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'public');
const out = path.join(root, 'www');

/* The server this app talks to. Baked into the build, so changing it later
   means shipping a new version — which is why it is a real address here rather
   than something to remember at the Mac. Override it to build against a local
   server, or after moving to another domain. */
const DEFAULT_API = 'https://cetele.up.railway.app';
const API = (process.env.CT_API_BASE || DEFAULT_API).replace(/\/$/, '');

/* The service worker is the web version's way of carrying the app; here the
   app is already on the phone, so it has nothing to do. Leaving it in would
   put a second, slightly different copy of the shell in front of the first. */
const SKIP = new Set(['sw.js']);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(src)) {
  if (SKIP.has(name)) continue;
  fs.cpSync(path.join(src, name), path.join(out, name), { recursive: true });
  n++;
}

fs.writeFileSync(
  path.join(out, 'config.js'),
  `/* Written by scripts/build-app.mjs — see README. */\nwindow.CT_API = '${API}';\n`
);

// nothing in the bundle is fetched over the network, so the cache-busting
// stamp the server injects has no job here
const index = path.join(out, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replaceAll('?v=dev', ''));

console.log(`www/ hazır — ${n} girdi, sunucu: ${API}${API === DEFAULT_API ? ' (varsayılan)' : ''}`);
