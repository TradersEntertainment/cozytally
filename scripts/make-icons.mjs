/* The app's icon and launch screen, drawn rather than resized.

   favicon.svg is the real artwork — a night sky, a crescent, and four tally
   marks in the app's own colours — so it is rendered at the size iOS wants
   instead of scaling a 512px PNG up to 1024 and hoping.

   Run: node scripts/make-icons.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { dropAlpha } from './png-rgb.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
const SPLASH = path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset');
const svg = fs.readFileSync(path.join(root, 'public/favicon.svg'), 'utf8');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function shoot(html, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>*{margin:0;padding:0}html,body{width:${w}px;height:${h}px;overflow:hidden}</style>${html}`
  );
  await page.waitForTimeout(120);
  const shot = await page.screenshot({ type: 'png' });
  await page.close();
  return shot;
}

/* The icon fills its square edge to edge. iOS rounds the corners itself, and
   an icon that rounds its own ends up with a visible double corner. */
const flat = svg.replace(/rx="14"/, 'rx="0"');
const icon = dropAlpha(await shoot(`<div style="width:1024px;height:1024px">${flat.replace('<svg', '<svg width="1024" height="1024"')}</div>`, 1024, 1024));
fs.writeFileSync(path.join(ICONS, 'AppIcon-512@2x.png'), icon);

/* The launch screen: one flat colour and the mark in the middle.

   Flat rather than a gradient for two reasons. It is the same colour the
   native shell paints behind the web view (capacitor.config.json), so the
   moment the app takes over there is nothing to see — a gradient that does not
   continue would show as a jump. And a browser dithers its gradients, which
   turns a smooth wash into noise that no amount of filtering will compress:
   the gradient version of this file was 1.4 MB, three times over. */
/* The mark without its own backdrop: the icon carries a rounded square in a
   slightly different dark, and on a flat field that reads as a box behind the
   logo rather than as the logo. */
const SPLASH_BG = '#171233';
const bare = svg
  .replace(/<rect width="64" height="64"[^>]*\/>/, '')
  /* The crescent is a light circle with a second one cut out of it, painted in
     the icon's own dark. On a different dark that cut-out shows as a smudge,
     so it is repainted in whatever the field behind it is. */
  .replaceAll('#191531', SPLASH_BG);
const splashHtml = `
  <div style="width:2732px;height:2732px;background:${SPLASH_BG};
       display:grid;place-items:center">
    <div style="width:760px;height:760px">${bare.replace('<svg', '<svg width="760" height="760"')}</div>
  </div>`;
const splash = dropAlpha(await shoot(splashHtml, 2732, 2732));
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  fs.writeFileSync(path.join(SPLASH, name), splash);
}

await browser.close();

const size = (p) => (fs.statSync(p).size / 1024).toFixed(0) + 'KB';
console.log(`ikon: AppIcon-512@2x.png 1024×1024 ${size(path.join(ICONS, 'AppIcon-512@2x.png'))} (alfa yok)`);
console.log(`açılış: splash-2732x2732*.png ${size(path.join(SPLASH, 'splash-2732x2732.png'))} ×3`);
