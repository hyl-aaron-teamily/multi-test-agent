// Issue screenshots for the model (rule B7): the first few image links of an Issue. Since W3-1 P8 they are
// downloaded at import into issues/assets/<id>/ and the links rewritten to those files (relative to issues/),
// so local paths are read from disk. Remaining https links are fetched with a short timeout (GitHub links with
// GITHUB_TOKEN). A link that cannot be read is reported through `onSkip` and left out; the text is used anyway.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { VisionPart } from '../core/model/llm';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_BYTES = 4_000_000;

/** Pure: a non-URL image reference → its file (relative links are relative to issues/). */
export const localImagePath = (ref: string, base = resolve('issues')) => (isAbsolute(ref) ? ref : resolve(base, ref.replace(/^\.\//, '')));

/** Up to `max` images as vision parts (label + bytes); failures are left out (and reported). */
export async function issueImages(urls: string[], max = 3, timeoutMs = 10_000, onSkip: (url: string, why: string) => void = (u, w) => console.warn(`[images] skipped ${u.slice(0, 120)}: ${w}`)): Promise<VisionPart[]> {
  const out: VisionPart[] = [];
  for (const url of urls.slice(0, max)) {
    try {
      let buf: Buffer;
      let type: string | null = null;
      if (!/^https?:\/\//.test(url)) {
        const f = localImagePath(url);
        if (!existsSync(f)) throw new Error('local file missing');
        buf = readFileSync(f);
      } else {
        const gh = /^https:\/\/(github\.com|raw\.githubusercontent\.com)\//.test(url) && process.env.GITHUB_TOKEN;
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: gh ? { authorization: `Bearer ${gh}` } : undefined });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        type = res.headers.get('content-type');
      }
      if (!buf.length || buf.length > MAX_BYTES) throw new Error(buf.length ? 'larger than 4 MB' : 'empty');
      const ext = (url.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1] ?? 'png').toLowerCase();
      out.push({ label: `Issue screenshot ${out.length + 1}`, png: buf, mime: type?.startsWith('image/') ? type : MIME[ext] });
    } catch (e) {
      onSkip(url, (e as Error).message.split('\n')[0]);
    }
  }
  return out;
}
