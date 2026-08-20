/* App Store screenshots, at the sizes Apple actually asks for.

   Taken from the demo room rather than a mock, so what the listing shows is
   what the app does. Run seed-demo.mjs first and pass it the invite link.

   Run: node scripts/store-shots.mjs <davet-bağı>
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'store-shots');
const invite = process.argv[2];
if (!invite) {
  console.error('Kullanım: node scripts/store-shots.mjs <davet-bağı>\n' +
    'Bağı scripts/seed-demo.mjs veriyor.');
  process.exit(1);
}
const BASE = new URL(invite).origin;

/* The two Apple still requires. Everything else it derives from these. */
const SIZES = [
  { name: '6.9', w: 1290, h: 2796 },
  { name: '6.5', w: 1242, h: 2688 },
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

for (const size of SIZES) {
  /* The device pixel sizes above are what the file must be; the page is laid
     out at the CSS size a phone of that class actually uses, then rendered at
     3x. Laying out at 1290px wide would produce a tablet layout shrunk down. */
  const ctx = await browser.newContext({
    viewport: { width: Math.round(size.w / 3), height: Math.round(size.h / 3) },
    deviceScaleFactor: 3,
    locale: 'tr-TR',
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();

  await page.goto(invite);
  await page.waitForURL(/\/r\//, { timeout: 15000, waitUntil: 'commit' });
  await page.waitForTimeout(1200);
  if (await page.locator('#nick-input').count()) {
    await page.fill('#nick-input', 'Zeynep');
    await page.click('.emoji-opt[data-a="🦊"]').catch(() => {});
    await page.click('.js-go');
  }
  await page.waitForTimeout(900);
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.js-next').count())) break;
    await page.click('.js-next');
    await page.waitForTimeout(250);
  }

  const shot = async (n, label) => {
    await page.waitForTimeout(700);
    const file = path.join(OUT, `${size.name}-${n}-${label}.png`);
    await page.screenshot({ path: file });
    const b = fs.readFileSync(file);
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    console.log(`  ${path.basename(file)} ${w}×${h}${w === size.w && h === size.h ? '' : '  ← ÖLÇÜ TUTMUYOR'}`);
  };

  /* Scroll to a card by name rather than to a pixel: card heights depend on
     what is in them, so a fixed offset lands somewhere different every time
     the demo room changes. */
  const toCard = async (title) => {
    await page.evaluate((t) => {
      const card = [...document.querySelectorAll('#board .card')]
        .find((el) => el.querySelector('.card-title')?.textContent.includes(t));
      if (card) card.scrollIntoView({ block: 'center' });
    }, title);
    await page.waitForTimeout(500);
  };

  console.log(`${size.name}"`);
  await page.evaluate(() => scrollTo(0, 0));
  await shot(1, 'pano');

  await toCard('Tatil fonu');
  await shot(2, 'kumbara');

  await toCard('Pamuk');
  await shot(3, 'evcil');

  await page.click('#fab-chat').catch(() => {});
  await shot(4, 'sohbet');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.goto(BASE + '/');
  await page.waitForTimeout(1200);
  await shot(5, 'karsilama');

  await ctx.close();
}

await browser.close();
console.log(`\n${OUT} hazır.`);
