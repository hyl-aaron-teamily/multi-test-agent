// issues/*.md → NormalizedIssue. English sections first; the Chinese mirror (## 摘要 …) is kept as context.
// Unknown sections are skipped. Screenshots are never handed to the model.

export interface NormalizedIssue {
  id: string;
  title: string;
  severity: string;
  frequency: string;
  /** Lower-case platform tokens found in Environment: ios | android | web | desktop | macos | windows. */
  platforms: string[];
  summary: string;
  steps: string[];
  expected: string;
  actual: string;
  featureArea: string;
  context: string;
  environment: string;
  empty: boolean;
}

const sectionRe = /^##\s+(.+?)\s*$/gm;

/** Pure: split markdown into `## heading` → body (first occurrence wins, so the English half is used). */
export function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const heads = [...md.matchAll(sectionRe)];
  heads.forEach((h, i) => {
    const key = h[1].trim().toLowerCase();
    const body = md.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : md.length).trim();
    if (!out.has(key)) out.set(key, body);
  });
  return out;
}

const field = (body: string, name: string) => body.match(new RegExp(`\\*\\*${name}[^*]*\\*\\*\\s*:?\\s*(.+)`, 'i'))?.[1]?.trim() ?? '';

const UNVERIFIED = /unconfirmed|not verified|needs confirmation|worth checking|please (check|confirm)|not specified/;

export function detectPlatforms(env: string): string[] {
  // Clauses the reporter marks as unverified do not count ("Android / web unconfirmed", "macOS worth checking").
  const t = env
    .toLowerCase()
    .replace(/\([^)]*\)/g, (m) => (UNVERIFIED.test(m) ? '' : m))
    .split(/[;.\n]|—/)
    .filter((c) => !UNVERIFIED.test(c))
    .join(' ; ');
  const out: string[] = [];
  if (/\bios\b|iphone|ipad/.test(t)) out.push('ios');
  if (/android/.test(t)) out.push('android');
  if (/\bweb\b|browser|chromium|chrome|teamily\.ai/.test(t)) out.push('web');
  if (/desktop|macos|mac os|windows/.test(t)) out.push('desktop');
  if (/all clients/.test(t)) for (const p of ['ios', 'android', 'web', 'desktop']) if (!out.includes(p)) out.push(p);
  return out;
}

export function parseIssue(id: string, md: string): NormalizedIssue {
  const s = sections(md);
  const get = (...keys: string[]) => keys.map((k) => s.get(k)).find((v) => v !== undefined) ?? '';
  const summary = get('summary', '摘要');
  const sev = get('severity');
  const env = get('environment');
  const ctx = get('additional context', '补充信息');
  const stepsRaw = get('steps to reproduce', '复现步骤');
  const steps = stepsRaw
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean);
  const platformLine = field(env, 'Platform') || env;
  const title = summary.split(/(?<=[.。])\s/)[0]?.slice(0, 160) ?? '';
  return {
    id,
    title,
    severity: field(sev, 'Level'),
    frequency: field(sev, 'Frequency'),
    platforms: detectPlatforms(platformLine),
    summary,
    steps,
    expected: get('expected result', '预期结果'),
    actual: get('actual result', '实际结果'),
    featureArea: field(ctx, 'Feature area'),
    context: ctx.slice(0, 4000),
    environment: env,
    empty: !summary.trim() && !steps.length,
  };
}
