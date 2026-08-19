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

const API = (process.env.CT_API_BASE || '').replace(/\/$/, '');
if (!API) {
  console.error(
    'CT_API_BASE is not set — the app would be built not knowing which server\n' +
      'to talk to, and it would look like it had simply failed to load.\n\n' +
      '  CT_API_BASE=https://your-domain npm run build:app\n\n' +
      'This address is baked into the build, so changing it later means shipping\n' +
      'a new version. Set it to the address it will really have.'
  );
  process.exit(1);
}

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

console.log(`www/ hazır — ${n} girdi, sunucu: ${API}`);
