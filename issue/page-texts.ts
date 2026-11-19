// W3-7 §8.2 — texts seen on real pages (W3-4 page records, skills/teamily/pages.local.json) for plan design:
//   the block catalog gets a section 「真实页面上的文字」 (at most 40 per page, with source and date);
//   R13: a text check on a fixed page (baseline / afterCheck / expect) whose text was never seen on any page
//   gets a warning (not an error) — the model guessed the screen text (W3-1 §0.3 class A).
import type { PagesFile } from '../engine/pages';
import { readPages } from '../engine/pages';
import type { TestPlan } from '../platform/schema/test-plan';

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Pure: a page's own texts, most seen first — not user content (seen once, long, addresses, digits only). */
export function pageTexts(f: PagesFile, max = 40): { lang: string; page: string; name: string; last: string; seen: number; texts: string[] }[] {
  const out: ReturnType<typeof pageTexts> = [];
  for (const [lang, pages] of Object.entries(f.pages))
    for (const [id, p] of Object.entries(pages)) {
      const min = Math.max(2, Math.ceil(p.seen * 0.2));
      const texts = Object.values(p.texts)
        .filter((c) => c.n >= min && c.v.length <= 40 && !/@|https?:\/\//.test(c.v) && /\p{L}/u.test(c.v))
        .sort((a, b) => b.n - a.n)
        .slice(0, max)
        .map((c) => c.v);
      if (texts.length) out.push({ lang, page: id, name: p.name, last: p.last.slice(0, 10), seen: p.seen, texts });
    }
  return out;
}

/** The catalog section (empty when nothing has been recorded yet). */
export function pageTextsSection(f: PagesFile = readPages()): string {
  const ps = pageTexts(f);
  if (!ps.length) return '';
  return [
    '## 真实页面上的文字（页面实录，执行端在真机 / 模拟器上读到的）',
    '基线、复位和 expect 里针对固定页面的文字检查，只能用这里出现过的文字，或者计划自己构造的文字（{token}）；不要凭印象写屏幕文字。',
    ...ps.map((p) => `- ${p.page}（${p.name}，${p.lang}，见过 ${p.seen} 次，最近 ${p.last}）：${p.texts.map((t) => `「${t}」`).join(' ')}`),
    '',
  ].join('\n');
}

/** Pure: R13 — text checks of fixed pages whose text no page record has seen (warnings, never errors). */
export function pageTextWarnings(plan: Pick<TestPlan, 'baseline' | 'afterCheck' | 'actions' | 'prepare'>, f: PagesFile = readPages()): string[] {
  const all = Object.values(f.pages).flatMap((ps) => Object.values(ps).flatMap((p) => Object.values(p.texts).map((c) => fold(c.v))));
  if (!all.length) return [];
  const seen = (t: string) => {
    const x = fold(t);
    return all.some((s) => s === x || s.includes(x));
  };
  const out: string[] = [];
  const look = (at: string, k: { kind?: string; match?: object } | undefined) => {
    const m = k?.match as { contains?: string; exact?: string } | undefined;
    const t = k?.kind === 'text' ? (m?.contains ?? m?.exact) : undefined;
    if (t && !/\{token\}|\{round\}/.test(t) && !seen(t)) out.push(`R13 ${at}: 「${t}」不在页面实录里（没在真实页面上见过，可能是凭印象写的）`);
  };
  plan.baseline.forEach((k, i) => look(`baseline[${i}]`, k));
  for (const key of ['actions', 'afterCheck', 'prepare'] as const) plan[key].forEach((a, i) => look(`${key}[${i}].expect`, a.expect?.check));
  return out;
}
