// Unified problem report: latest explore trace + latest monkey summary → midscene_run/problem-report.md
// Reuses existing evidence (crash scene dirs, Midscene HTML report, monkey.log); only links them.
//
//   pnpm report:problems                       # newest of each
//   pnpm report:problems --trace <file> --monkey <summary.json>
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ExploreTrace } from '../explore/trace';
import type { MonkeySummary } from '../monkey/loop';

const ROOT = resolve('.');
const OUT = resolve('midscene_run/problem-report.md');
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

async function newest(dir: string, filter: (f: string) => boolean): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const files = (await readdir(dir)).filter(filter).sort();
  return files.length ? join(dir, files[files.length - 1]) : undefined;
}

async function readJson<T>(file?: string): Promise<T | undefined> {
  return file ? (JSON.parse(await readFile(file, 'utf8')) as T) : undefined;
}

/** First "Caused by"/exception lines from a crash scene's logcat.txt. */
async function stackSummary(dir: string): Promise<string> {
  const text = await readFile(join(dir, 'logcat.txt'), 'utf8').catch(() => '');
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /FATAL EXCEPTION|ANR in/.test(l));
  return i < 0 ? '(no stack in logcat.txt)' : lines.slice(i, i + 8).join('\n');
}

/** `adb shell am crash` self-checks are not product bugs; say so in the report. */
const injectedNote = (stack: string | undefined) =>
  stack?.includes('CrashedByAdbException') ? '（`am crash` 人为注入的自检崩溃，非产品缺陷）' : '';

export function renderExplore(t: ExploreTrace | undefined, stacks: Record<string, string>): string[] {
  if (!t) return ['## 路径 A 发现的问题', '', '- 未找到探索轨迹（尚未运行 `pnpm explore`）', ''];
  const md: string[] = ['## 路径 A 发现的问题', ''];
  const own = t.crashes.filter((c) => c.matchesPackage);
  own.forEach((c, i) => {
    const step = t.steps.find((s) => s.crashDir === c.dir);
    const idx = step ? t.steps.indexOf(step) : t.steps.length;
    const trail = t.steps.slice(Math.max(0, idx - 4), idx + 1);
    md.push(
      `### 问题 ${i + 1}`,
      `- 类型：${c.keywords.includes('FATAL EXCEPTION') ? '崩溃' : c.keywords.includes('ANR in') ? 'ANR' : '崩溃信号'} (${c.keywords.join(', ')})${injectedNote(stacks[c.dir])}`,
      `- 状态 ID：\`${step?.stateId ?? '?'}\`（指纹来源 ${step?.stateFingerprintSource ?? '?'}，页面 "${step?.stateTitle ?? ''}"）`,
      '- 操作轨迹片段：',
      ...trail.map((s) => `  - #${s.step} [${s.stateTitle || s.stateId}] ${s.action} ${s.element ? `"${s.element.label}"` : ''} → ${s.result}`),
      `- 截图：\`${rel(join(c.dir, 'screenshot.png'))}\``,
      `- logcat 片段：\`${rel(join(c.dir, 'logcat.txt'))}\``,
      `- Midscene 报告：${t.midsceneReport ? `\`${rel(t.midsceneReport)}\`` : '(无)'}`,
      '',
      '```',
      stacks[c.dir] ?? '',
      '```',
      '',
    );
  });
  const anomalies = t.steps.filter((s) => s.result === 'error' || s.result === 'app-exited');
  if (anomalies.length) {
    md.push('### 页面异常 / 操作失败', '');
    for (const s of anomalies) md.push(`- #${s.step} [${s.stateTitle || s.stateId}] ${s.action} "${s.element?.label ?? ''}" → ${s.result}${s.error ? `：${s.error}` : ''}`);
    md.push('');
  }
  if (!own.length && !anomalies.length) md.push(`- 未发现：${t.conclusion}`, '');
  return md;
}

export function renderMonkey(m: MonkeySummary | undefined, stacks: Record<string, string>): string[] {
  if (!m) return ['## 路径 B 发现的问题', '', '- 未找到 Monkey 汇总（尚未运行 `pnpm monkey`）', ''];
  const md: string[] = ['## 路径 B 发现的问题', ''];
  let n = 0;
  for (const r of m.rounds) {
    for (const c of r.correlated.filter((x) => x.logcat)) {
      n++;
      const lc = c.logcat!;
      md.push(
        `### 问题 ${n}`,
        `- 类型：${lc.keywords.includes('ANR in') && !lc.keywords.includes('FATAL EXCEPTION') ? 'ANR' : 'CRASH'} (${lc.keywords.join(', ')})${injectedNote(stacks[lc.dir])}`,
        `- 复现 seed：${r.seed}`,
        `- 复现命令：\`${r.reproduceCommand}\``,
        `- Monkey 日志：${c.monkey ? `\`${rel(r.logPath)}\` 第 ${c.monkey.line} 行 \`${c.monkey.text}\`（event #${c.monkey.eventCount ?? '?'}）` : c.note}`,
        `- logcat 时间：${lc.timestamp}；现场 \`${rel(lc.dir)}\``,
        '',
        '```',
        stacks[lc.dir] ?? lc.firstLine,
        '```',
        '',
      );
    }
  }
  if (!n) md.push(`- 未发现：${m.conclusion}`, ...m.rounds.map((r) => `  - seed=${r.seed} 复现命令：\`${r.reproduceCommand}\``), '');
  return md;
}

export async function buildProblemReport(traceFile?: string, monkeyFile?: string): Promise<string> {
  traceFile ??= await newest(resolve('midscene_run/explore-traces'), (f) => f.endsWith('.json'));
  monkeyFile ??= existsSync(resolve('monkey_run/summary.json')) ? resolve('monkey_run/summary.json') : undefined;
  const t = await readJson<ExploreTrace>(traceFile);
  const m = await readJson<MonkeySummary>(monkeyFile);

  const stacks: Record<string, string> = {};
  const dirs = [...(t?.crashes.map((c) => c.dir) ?? []), ...(m?.rounds.flatMap((r) => r.crashArtifactDirs) ?? [])];
  for (const d of dirs) stacks[d] = await stackSummary(d);

  const pkgs = [...new Set([t?.package, m?.package].filter(Boolean))].join(' / ') || '(none)';
  const aCrashes = t?.crashes.filter((c) => c.matchesPackage).length ?? 0;
  const aAnoms = t?.steps.filter((s) => s.result === 'error' || s.result === 'app-exited').length ?? 0;
  const bCrashes = m?.rounds.reduce((n, r) => n + r.crashesDetected, 0) ?? 0;
  const pending: string[] = [];
  if (t?.truncated) pending.push(`- 路径 A 截断：${t.truncatedReason}`);
  const otherA = t?.crashes.filter((c) => !c.matchesPackage) ?? [];
  if (otherA.length) pending.push(`- 路径 A 期间其它进程崩溃信号 ${otherA.length} 条（非被测包）：${otherA.map((c) => `\`${rel(c.dir)}\``).join(', ')}`);
  for (const r of m?.rounds ?? []) for (const c of r.correlated.filter((x) => !x.logcat)) pending.push(`- seed=${r.seed}: ${c.note} — \`${c.monkey?.text}\``);
  if (!pending.length) pending.push('- 无');

  const md = [
    `# 通用测试问题报告 — ${pkgs}`,
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    '## 概览',
    t
      ? `- 路径 A（AI 探索，${t.package}）：共 ${t.steps.length} 步，覆盖 ${t.stateCount} 个状态，发现 ${aCrashes} 个崩溃/ANR、${aAnoms} 个页面异常/操作失败 — 轨迹 \`${rel(traceFile!)}\``
      : '- 路径 A（AI 探索）：未运行',
    m
      ? `- 路径 B（Monkey，${m.package}）：seed=${m.rounds.map((r) => r.seed).join(',')}，事件数=${m.rounds.map((r) => r.eventsInjected ?? r.eventCount).join(',')}，发现 ${bCrashes} 个崩溃/ANR — 汇总 \`${rel(monkeyFile!)}\``
      : '- 路径 B（Monkey）：未运行',
    '',
    ...renderExplore(t, stacks),
    ...renderMonkey(m, stacks),
    '## 未复现 / 待观察',
    ...pending,
    '',
  ].join('\n');
  await writeFile(OUT, md);
  return OUT;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { trace: { type: 'string' }, monkey: { type: 'string' } } });
  buildProblemReport(values.trace && resolve(values.trace), values.monkey && resolve(values.monkey))
    .then((f) => console.log(`problem report → ${f}`))
    .catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
}
