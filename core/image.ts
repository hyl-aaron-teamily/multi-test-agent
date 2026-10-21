// Minimal PNG decode + perceptual hash, no native deps. Covers what Playwright screenshots and
// `adb screencap -p` produce: 8-bit, non-interlaced, colour type 2 (RGB) or 6 (RGBA).
// Used for SKILL reference regions (calibration-time) and checkpoint/deviation comparison (run-time).
import { deflateSync, inflateSync } from 'node:zlib';

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

/** [x, y, w, h] in image pixels. */
export type Box = [number, number, number, number];

export function decodePng(buf: Buffer): Rgba {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported PNG (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

/** Grey value averaged over a cell (box clipped to the image). */
function cellMean(img: Rgba, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0;
  let n = 0;
  const sx = Math.max(1, Math.floor((x1 - x0) / 8));
  const sy = Math.max(1, Math.floor((y1 - y0) / 8));
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += sy) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x += sx) {
      const o = (y * img.width + x) * 4;
      s += img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114;
      n++;
    }
  }
  return n ? s / n : 0;
}

/** 64-bit difference hash (9×8 grid, left/right gradient) of a region, as 16 hex chars. */
export function dHash(img: Rgba, box: Box = [0, 0, img.width, img.height]): string {
  const [bx, by, bw, bh] = box;
  let bits = '';
  for (let r = 0; r < 8; r++) {
    const y0 = by + Math.floor((r * bh) / 8);
    const y1 = by + Math.floor(((r + 1) * bh) / 8);
    const row: number[] = [];
    for (let c = 0; c < 9; c++) row.push(cellMean(img, bx + Math.floor((c * bw) / 9), y0, bx + Math.floor(((c + 1) * bw) / 9), y1));
    for (let c = 0; c < 8; c++) bits += row[c] > row[c + 1] + 2 ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Mean grey of a region (cheap "is it blank / did it change" signal alongside the hash). */
export function meanGrey(img: Rgba, box: Box = [0, 0, img.width, img.height]): number {
  return cellMean(img, box[0], box[1], box[0] + box[2], box[1] + box[3]);
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

/** Encode RGBA as PNG (filter 0, default deflate). */
export function encodePng(img: Rgba): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(raw, y * (img.width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Draw a 3px rectangle outline in place (annotation images for human review). */
export function drawBox(img: Rgba, box: Box, rgb: [number, number, number] = [255, 0, 0]): void {
  const [bx, by, bw, bh] = box.map(Math.round);
  for (let t = 0; t < 3; t++) {
    for (let x = bx; x < bx + bw; x++) for (const y of [by + t, by + bh - 1 - t]) put(img, x, y, rgb);
    for (let y = by; y < by + bh; y++) for (const x of [bx + t, bx + bw - 1 - t]) put(img, x, y, rgb);
  }
}

function put(img: Rgba, x: number, y: number, [r, g, b]: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = r;
  img.data[o + 1] = g;
  img.data[o + 2] = b;
  img.data[o + 3] = 255;
}

/** Scale a box between coordinate spaces (e.g. CSS px → screenshot px at deviceScaleFactor). */
export function scaleBox(b: Box, f: number): Box {
  return [b[0] * f, b[1] * f, b[2] * f, b[3] * f].map(Math.round) as Box;
}

/** Pixels in `box` whose RGB differs by more than `tol` (sum of channel deltas). Same-size images only. */
export function pixelDiff(a: Rgba, b: Rgba, box: Box = [0, 0, a.width, a.height], tol = 60): number {
  let n = 0;
  const [bx, by, bw, bh] = box.map(Math.round);
  for (let y = Math.max(0, by); y < Math.min(a.height, b.height, by + bh); y++) {
    for (let x = Math.max(0, bx); x < Math.min(a.width, b.width, bx + bw); x++) {
      const o = (y * a.width + x) * 4;
      if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) > tol) n++;
    }
  }
  return n;
}

/**
 * Fraction (0..1) of the reference region's "ink" pixels (text / icons: clearly darker than the region's
 * background) that are NOT also ink at the same place in `img` shifted by `dy`. Background pixels are
 * ignored, so a blank area never matches a region that contains text. Returns 1 if the shifted window
 * leaves the image or the region has no ink.
 */
export function regionDiffFraction(img: Rgba, ref: Rgba, box: Box, dy = 0): number {
  const [bx, by] = box.map(Math.round);
  // Clamp rounding overflow (CSS box × DPR can end a pixel past the image).
  const bw = Math.min(Math.round(box[2]), ref.width - bx, img.width - bx);
  const bh = Math.min(Math.round(box[3]), ref.height - by, img.height - by - Math.max(0, dy));
  if (by + dy < 0 || by + bh + dy > img.height || bx < 0 || bx + bw > Math.min(img.width, ref.width) || by < 0 || by + bh > ref.height) return 1;
  const grey = (im: Rgba, x: number, y: number) => {
    const o = (y * im.width + x) * 4;
    return im.data[o] * 0.299 + im.data[o + 1] * 0.587 + im.data[o + 2] * 0.114;
  };
  // Background level = region median-ish (mean of samples); ink = 60 grey levels darker.
  let sum = 0;
  let cnt = 0;
  for (let y = by; y < by + bh; y += 2) for (let x = bx; x < bx + bw; x += 2) (sum += grey(ref, x, y)), cnt++;
  const bg = sum / Math.max(1, cnt);
  let ink = 0;
  let miss = 0;
  for (let y = by; y < by + bh; y += 2) {
    for (let x = bx; x < bx + bw; x += 2) {
      const r = grey(ref, x, y);
      if (r > bg - 60) continue;
      ink++;
      if (grey(img, x, y + dy) > r + 60) miss++;
    }
  }
  return ink >= 10 ? miss / ink : 1;
}
