/* The word list for Word Chain's dictionary mode.
 *
 * Like questions.js this lives OUTSIDE public/, because whether a word counts
 * is the server's call and there is no reason to ship 60,000 words to a
 * browser. The list itself is words.txt — one word per line, upper-cased with
 * Turkish rules — read once at boot rather than written out as a JS literal,
 * which would be most of a megabyte of source for no gain.
 *
 * Where it comes from: the headword lists published at
 * github.com/CanNuhlar/Turkce-Kelime-Listesi and
 * github.com/mertemin/turkish-word-list, merged, filtered down to single
 * words of Turkish letters, with circumflexes folded to their plain spelling
 * (rüzgâr → RÜZGAR) so people can type them normally. NOTE: neither source
 * repository states a licence, so if that matters for this deployment the
 * file can be swapped for another list without touching any code.
 *
 * On top of that: every province, the districts and cities people actually
 * name, the countries, and the common Turkish first names — proper nouns that
 * dictionary lists leave out but that everybody plays.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const WORDS = new Set(
  fs
    .readFileSync(path.join(here, 'words.txt'), 'utf8')
    .split('\n')
    .map((w) => w.trim())
    .filter(Boolean)
);
