#!/usr/bin/env node
/* Bank marks for the debt card.

   A bank is recognised by its mark, not by its name in small type, and the
   mark people actually know is the one on their phone's home screen. So these
   come from the App Store's own artwork: square by construction, drawn for a
   small rounded tile, and the same picture the person already taps every week.

   Fetched once and committed, not pulled at runtime: a browser asking Apple
   for a picture every time a debt card paints would tell Apple what the card
   is about, and would leave the card blank on a train.

   Run: node scripts/bank-logos.mjs
   Writes: public/banks/<key>.png (128×128)

   The marks belong to the banks. They are used here the way a statement
   envelope uses them — to say which of your own accounts a line is about. */

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'banks');
const SIZE = 128;

/* [key, what to search for, a fragment that has to appear in the app's name
   or its seller — the search alone will happily hand back a rival's app] */
const WANTED = [
  ['ziraat', 'Ziraat Mobil', 'ziraat'],
  ['isbank', 'İşCep', 'is bankasi'],
  ['garanti', 'Garanti BBVA Mobile', 'garanti'],
  ['akbank', 'Akbank Mobil', 'akbank'],
  ['yapikredi', 'Yapı Kredi Mobile', 'yapi'],
  ['vakifbank', 'VakıfBank Mobil', 'vakif'],
  ['halkbank', 'Halkbank Mobil', 'halk'],
  ['qnb', 'QNB Mobil', 'qnb'],
  ['enpara', 'Enpara.com Cep Şubesi', 'enpara'],
  ['denizbank', 'MobilDeniz', 'deniz'],
  ['teb', 'CEPTETEB', 'teb'],
  ['ing', 'ING Mobil Türkiye', 'ing'],
  ['kuveytturk', 'Kuveyt Türk Mobil', 'kuveyt'],
  ['albaraka', 'Albaraka Mobil', 'albaraka'],
  ['turkiyefinans', 'Türkiye Finans Mobil', 'turkiye finans'],
  ['sekerbank', 'Şekerbank Mobil', 'sekerbank'],
  ['fibabanka', 'Fibabanka Mobil', 'fiba'],
  ['odeabank', 'Odeabank Mobil', 'odea'],
  ['anadolubank', 'Anadolubank Mobil', 'anadolubank'],
  ['burgan', 'Burgan Bank Mobil', 'burgan'],
  ['hsbc', 'HSBC Türkiye', 'hsbc'],
  ['papara', 'Papara', 'papara'],
  ['getirfinans', 'Getir Finans', 'getir'],
  ['tosla', 'Tosla', 'tosla'],
  ['nkolay', 'N Kolay', 'kolay'],
];

const fold = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function lookup(term) {
  const url =
    'https://itunes.apple.com/search?country=tr&entity=software&limit=12&term=' +
    encodeURIComponent(term);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('arama ' + res.status);
  return (await res.json()).results || [];
}

await fs.mkdir(OUT, { recursive: true });
const report = [];

for (const [key, term, must] of WANTED) {
  try {
    const hits = await lookup(term);
    const want = fold(must);
    const hit = hits.find(
      (r) => fold(r.trackName).includes(want) || fold(r.sellerName).includes(want)
    );
    if (!hit) {
      report.push([key, '—', 'eşleşme yok']);
      continue;
    }
    const art = String(hit.artworkUrl512 || hit.artworkUrl100 || '').replace(
      /\/\d+x\d+bb\.(jpg|png)$/,
      `/${SIZE}x${SIZE}bb.png`
    );
    if (!art) {
      report.push([key, hit.trackName, 'görsel yok']);
      continue;
    }
    const img = await fetch(art, { signal: AbortSignal.timeout(20000) });
    if (!img.ok) throw new Error('görsel ' + img.status);
    const buf = Buffer.from(await img.arrayBuffer());
    // a PNG and nothing else: this goes straight into the page
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      report.push([key, hit.trackName, 'PNG değil']);
      continue;
    }
    await fs.writeFile(path.join(OUT, key + '.png'), buf);
    report.push([key, `${hit.trackName} — ${hit.sellerName}`, `${(buf.length / 1024).toFixed(1)} KB`]);
  } catch (err) {
    report.push([key, '—', err.message]);
  }
  // the search endpoint is public and unauthenticated; do not hammer it
  await new Promise((r) => setTimeout(r, 400));
}

const pad = Math.max(...report.map((r) => r[0].length));
for (const [key, what, note] of report) {
  console.log(`${key.padEnd(pad)}  ${note.padEnd(10)}  ${what}`);
}
const bad = report.filter((r) => !/KB$/.test(r[2]));
console.log(`\n${report.length - bad.length}/${report.length} indi`);
if (bad.length) process.exitCode = 1;
