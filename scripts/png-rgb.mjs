/* Strip the alpha channel out of a PNG.

   Apple refuses an App Store icon that carries one — even fully opaque, the
   channel's presence is the rejection. Chromium always writes RGBA, and there
   is no image library here, so the conversion is done by hand: inflate the
   pixels, undo the row filters, drop every fourth byte, and write the file
   back out as plain RGB.

   Only what this needs is implemented: 8-bit RGBA, non-interlaced, which is
   what a screenshot always is. Anything else is refused rather than quietly
   mangled. */
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunks(buf) {
  const out = [];
  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    out.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + len) });
    at += len + 12;
  }
  return out;
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Undo one scanline's filter, in place, given the row above it. */
function unfilter(type, row, prev, bpp) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= bpp && prev ? prev[i - bpp] : 0;
    if (type === 1) row[i] = (row[i] + a) & 0xff;
    else if (type === 2) row[i] = (row[i] + b) & 0xff;
    else if (type === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
    else if (type === 4) row[i] = (row[i] + paeth(a, b, c)) & 0xff;
    else if (type !== 0) throw new Error('unknown filter ' + type);
  }
}

export function dropAlpha(png) {
  if (!png.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const parts = chunks(png);
  const ihdr = parts.find((c) => c.type === 'IHDR').data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  if (colour === 2) return png; // already what we want
  if (depth !== 8 || colour !== 6 || ihdr[12] !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${ihdr[12]})`);
  }

  const raw = zlib.inflateSync(Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const out = Buffer.alloc(h * (1 + w * 3));
  const rgb = new Array(h);
  let prev = null;
  for (let y = 0; y < h; y++) {
    const at = y * (1 + w * 4);
    const row = Buffer.from(raw.subarray(at + 1, at + 1 + w * 4));
    unfilter(raw[at], row, prev, 4);
    prev = row;
    rgb[y] = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      rgb[y][x * 3] = row[x * 4];
      rgb[y][x * 3 + 1] = row[x * 4 + 1];
      rgb[y][x * 3 + 2] = row[x * 4 + 2];
    }
  }

  /* Filter each row before deflate. Writing everything unfiltered is correct
     but enormous on the sort of image this is used for — a launch screen is
     mostly a smooth gradient, where each row is nearly its neighbour and Up
     leaves a field of zeros. Choosing per row by the usual sum-of-absolutes
     heuristic costs one pass and roughly halves the file. */
  for (let y = 0; y < h; y++) {
    const cur = rgb[y];
    const above = y ? rgb[y - 1] : null;
    let flat = 0;
    let up = 0;
    for (let i = 0; i < cur.length; i++) {
      flat += cur[i] < 128 ? cur[i] : 256 - cur[i];
      const d = (cur[i] - (above ? above[i] : 0)) & 0xff;
      up += d < 128 ? d : 256 - d;
    }
    const useUp = above && up < flat;
    const dst = y * (1 + w * 3);
    out[dst] = useUp ? 2 : 0;
    for (let i = 0; i < cur.length; i++) {
      out[dst + 1 + i] = useUp ? (cur[i] - above[i]) & 0xff : cur[i];
    }
  }

  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2; // truecolour, no alpha
  return Buffer.concat([
    SIG,
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
