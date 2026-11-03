// Exploration finding → Issue draft (§5.3, K2): the quick tier found it, the pro tier (capability ②) reproduces
// it. The Issue uses the sample Issues' sections, so the usual classify → contract → plan path takes it; the
// steps are the path the agent took, in plain words; the evidence is the incident bundle and its review.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentResult, Finding } from './run';

const PLATFORM: Record<string, string> = { 'android-app': 'Android / Teamily mobile app', 'android-web': 'Android / phone browser (Teamily web)', 'mobile-web': 'Web / mobile browser', 'desktop-web': 'Web / desktop browser (Edge)' };

/** Pure: one agent step ("tap #54 \"发现\"") in plain words. */
export function stepWords(s: string): string {
  const m = s.match(/^(tap|longPress) #\d+ "(.*)"$/);
  if (m) return `${m[1] === 'tap' ? '点' : '长按'}「${m[2]}」`;
  const c = s.match(/^(tap|longPress) \((\d+),(\d+)\)\s*(.*)$/);
  if (c) return `${c[1] === 'tap' ? '点' : '长按'}屏幕位置 (${c[2]}, ${c[3]})${c[4] ? `（${c[4]}）` : ''}`;
  const t = s.match(/^type #\d+ "(.*)" "(.*)"$/);
  if (t) return `在「${t[1]}」里输入 "${t[2]}"`;
  const w = s.match(/^swipe (up|down|left|right)$/);
  if (w) return { up: '上滑', down: '下滑', left: '左滑', right: '右滑' }[w[1] as 'up']!;
  const wait = s.match(/^wait (\d+)ms$/);
  if (wait) return `等待 ${Math.round(Number(wait[1]) / 100) / 10} 秒`;
  if (s === 'back') return '返回';
  if (s === 'launch') return '重新打开 App';
  return s;
}

/** Pure: the Issue markdown of a finding. */
export function findingIssue(r: AgentResult, f: Finding): string {
  const steps = ['打开 Teamily，登录后停在首页', ...f.path.map(stepWords), '观察当前界面'];
  return [
    `## Summary`,
    `[探索发现] ${f.description}（${r.surface}，探索第 ${f.step} 步）`,
    '',
    `## Steps to reproduce`,
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `## Expected result`,
    '应用可以正常使用：没有闪退、报错、白屏、卡住或显示错乱。',
    '',
    `## Actual result`,
    f.description,
    '',
    `## Severity`,
    `- **Level**: ${f.source === 'hard' ? 'High' : 'Medium'}`,
    `- **Frequency**: Intermittent`,
    '',
    `## Environment`,
    `- **Platform / OS / Browser**: ${PLATFORM[r.surface] ?? r.surface}`,
    '',
    `## Additional context`,
    `- **Feature area**: 探索（${r.mode === 'explore' ? 'AI 探索' : '自然语言任务'}：${r.goal}）`,
    `- Source: ${f.source === 'hard' ? `driver event (${f.kind})` : `agent report, evidence review ${f.review ?? 'unverified'}`}; seen once in exploration.`,
    `- Incident bundle: ${f.incident}`,
    `- Exploration run: ${r.runDir}`,
    '',
  ].join('\n');
}

/** Write the Issue of finding `n` to issues/explore/<id>.md; returns its id. */
export async function writeFindingIssue(r: AgentResult, n: number): Promise<{ id: string; file: string }> {
  const f = r.findings.find((x) => x.n === n);
  if (!f) throw new Error(`no finding #${n} in ${r.runDir}`);
  const stamp = r.startedAt.replace(/[-:TZ.]/g, '').slice(0, 14);
  const id = `explore-${stamp}-${n}`;
  const dir = resolve('issues', 'explore');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  await writeFile(file, findingIssue(r, f));
  return { id, file };
}
