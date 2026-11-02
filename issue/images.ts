// Issue screenshots for the model (rule B7): the first few image links of an Issue, downloaded with a short
// timeout. GitHub links (the screenshots live in a private repository) use GITHUB_TOKEN when it is set. A link
// that cannot be fetched is skipped; the Issue text is used anyway.
import type { VisionPart } from '../core/model/llm';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_BYTES = 4_000_000;

/** Up to `max` images as vision parts (label + bytes); failures are left out. */
export async function issueImages(urls: string[], max = 3, timeoutMs = 10_000): Promise<VisionPart[]> {
  const out: VisionPart[] = [];
  for (const url of urls.slice(0, max)) {
    try {
      const gh = /^https:\/\/(github\.com|raw\.githubusercontent\.com)\//.test(url) && process.env.GITHUB_TOKEN;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: gh ? { authorization: `Bearer ${gh}` } : undefined });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const ext = (url.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1] ?? 'png').toLowerCase();
      const mime = res.headers.get('content-type')?.startsWith('image/') ? res.headers.get('content-type')! : MIME[ext];
      out.push({ label: `Issue screenshot ${out.length + 1}`, png: buf, mime });
    } catch {
      /* unreachable link: text only */
    }
  }
  return out;
}
