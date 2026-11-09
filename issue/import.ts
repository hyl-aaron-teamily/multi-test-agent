// Issue import (W3-1 P6 / P8, K6 / K10): Markdown pasted or uploaded, or fetched from a GitHub Issue link.
// Any format is accepted (the model reads the text as is); the parser only takes a title for the list. The
// id comes from the caller, else the file name / a "#<n>" in the text, else upload-<date>-<sha6>. Same id,
// same content → nothing changes; different content → needs `overwrite` (the old draft is then marked for
// rewrite). Screenshots are downloaded at import into issues/assets/<id>/ (≤ 6, ≤ 4 MB each) and the text
// links rewritten to the local files; a download that fails keeps its link and is listed in the preview.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { CodedError } from '../platform/lifecycle/status';
import { fetchBlob, fetchIssue, issueMarkdown } from './github';
import { imagesOf, parseIssue } from './parse';
import { issuePath, UPLOAD_DIR } from './paths';

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 4_000_000;
export const ASSETS_DIR = () => resolve(process.env.AUTOTEST_ASSETS_DIR ?? 'issues/assets');
const ID_RE = /^[\w-]{1,64}$/;

export interface ImportInput {
  markdown?: string;
  filename?: string;
  id?: string;
  /** GitHub Issue link: fetched instead of `markdown`. */
  url?: string;
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface ImportPreview {
  id: string;
  title: string;
  platforms: string[];
  frequency: string;
  images: { url: string; local?: string; error?: string }[];
  exists: boolean;
  same: boolean;
  file: string;
  source?: string;
}

/** Pure: the id an import gets (explicit → file name number → "#<n>" in the text → upload-<date>-<sha6>). */
export function importId(i: Pick<ImportInput, 'id' | 'filename' | 'markdown'>, today = new Date()): string {
  const pick = i.id?.trim() || i.filename?.match(/(\d{2,})/)?.[1] || i.markdown?.match(/(?:^|\s)#(\d{2,})\b/)?.[1] || `upload-${today.toISOString().slice(0, 10).replace(/-/g, '')}-${createHash('sha256').update(i.markdown ?? '').digest('hex').slice(0, 6)}`;
  if (!ID_RE.test(pick)) throw new CodedError('BAD_INPUT', `Issue id「${pick.slice(0, 80)}」只能是字母、数字、下划线、连字符（1–64 个）`);
  return pick;
}

/** Pure: a title for the list (K6: no format required) — the first heading or line of the Summary, else the first line. */
export function titleOf(md: string): string {
  const body = md.replace(/<!--[\s\S]*?-->/g, '').trim();
  const p = parseIssue('x', body);
  return (body.match(/^#\s+(.+)$/m)?.[1] || p.title || body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') || '').trim().slice(0, 160);
}

type Fetch = typeof fetch;

/** Download one screenshot: github.com/…/blob/… through the contents API; a user-attachments link through the
 *  signed URL in body_html; other https links directly. */
export async function downloadImage(url: string, bodyHtml: string, f: Fetch = fetch): Promise<Buffer> {
  const blob = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/([^?#]+)/);
  if (blob) return fetchBlob(blob[1], blob[2], blob[3], decodeURIComponent(blob[4]), f);
  let target = url;
  if (/github\.com\/user-attachments\/assets\//.test(url)) {
    const key = url.split('/').pop()!.split('?')[0];
    const signed = [...bodyHtml.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).find((u) => u.includes(key) && /[?&](jwt|X-Amz-Signature)=/.test(u));
    if (!signed) throw new Error('user-attachments: no signed URL in body_html (fetch the Issue through the API)');
    target = signed;
  }
  if (!/^https:\/\//.test(target)) throw new Error('only https links are downloaded');
  const res = await f(target, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const EXT = (url: string, buf: Buffer) => (buf.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : buf.subarray(0, 2).toString('hex') === 'ffd8' ? 'jpg' : buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : (url.match(/\.(png|jpe?g|webp)(?:[?#]|$)/i)?.[1] ?? 'png').toLowerCase());

/** Screenshots of `md` → issues/assets/<id>/; returns the rewritten text and what happened to each link. */
export async function localizeImages(md: string, id: string, bodyHtml = '', o: { fetch?: Fetch; dir?: string; write?: boolean } = {}): Promise<{ markdown: string; images: ImportPreview['images'] }> {
  const dir = join(o.dir ?? ASSETS_DIR(), id);
  const urls = imagesOf(md).filter((u) => /^https?:\/\//.test(u));
  const images: ImportPreview['images'] = [];
  let out = md;
  for (const [k, url] of urls.entries()) {
    if (k >= MAX_IMAGES) {
      images.push({ url, error: `超过 ${MAX_IMAGES} 张，未下载` });
      continue;
    }
    try {
      const buf = await downloadImage(url, bodyHtml, o.fetch);
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error(buf.length ? `大于 ${MAX_IMAGE_BYTES / 1e6} MB` : '空文件');
      const file = join(dir, `${k + 1}.${EXT(url, buf)}`);
      if (o.write !== false) {
        await mkdir(dir, { recursive: true });
        await writeFile(file, buf);
      }
      images.push({ url, local: file });
      out = out.split(url).join(relative(resolve('issues'), file).replace(/\\/g, '/'));
    } catch (e) {
      images.push({ url, error: (e as Error).message.split('\n')[0].slice(0, 200) });
    }
  }
  return { markdown: out, images };
}

/** Preview (dryRun) or write an imported Issue. */
export async function importIssue(input: ImportInput, o: { fetch?: Fetch; uploadDir?: string; assetsDir?: string } = {}): Promise<ImportPreview> {
  let md = input.markdown ?? '';
  let bodyHtml = '';
  let source: string | undefined;
  let id = input.id?.trim();
  if (input.url && !md.trim()) {
    const x = await fetchIssue(input.url, o.fetch);
    md = issueMarkdown(x);
    bodyHtml = x.bodyHtml;
    source = x.url;
    id ||= x.id;
  }
  if (!md.trim()) throw new CodedError('BAD_INPUT', 'Issue 内容为空');
  id = importId({ id, filename: input.filename, markdown: md });
  const existing = issuePath(id);
  const exists = existsSync(existing);
  const file = exists ? existing : join(o.uploadDir ?? UPLOAD_DIR(), `${id}.md`);
  const loc = await localizeImages(md, id, bodyHtml, { fetch: o.fetch, dir: o.assetsDir, write: !input.dryRun });
  const text = loc.markdown;
  // "Same" compares what would be written; a re-import of an unchanged Issue writes nothing.
  const strip = (s: string) => s.replace(/<!-- source:[^\n]*-->\n?/, '').replace(/\r\n/g, '\n').trim();
  const same = exists && strip(readFileSync(existing, 'utf8')) === strip(text);
  const p = parseIssue(id, text);
  const preview: ImportPreview = { id, title: titleOf(text), platforms: p.platforms, frequency: p.frequency, images: loc.images, exists, same, file, ...(source ? { source } : {}) };
  if (input.dryRun || same) return preview;
  if (exists && !input.overwrite) throw new CodedError('BAD_INPUT', `Issue ${id} 已存在且内容不同：要覆盖请加 overwrite（覆盖后旧草稿失效）`, `autotest issue import … --overwrite（文件 ${existing}）`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  if (exists) {
    const { markDraftStale } = await import('../platform/invalidate');
    markDraftStale(id, `Issue 文件被导入覆盖（${new Date().toISOString()}）`);
  }
  return preview;
}
