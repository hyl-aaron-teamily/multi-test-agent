// Preset evidence cases: incident bundles frozen under fixtures/evidence/<id>/ with the verdict a correct
// review must reach. `autotest evidence cases` re-runs the vision review on every case and fails when a
// verdict differs — a regression suite for the reviewer itself (prompt, frame choice, model).
//   autotest evidence review   <incidentDir> [--issue <id>] [--subcase "..."]
//   autotest evidence snapshot <incidentDir> --id <case> --expect consistent|inconsistent [--note "..."] [--subcase "..."] [--align-ms N]
//   autotest evidence cases    [--id <case>]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { issuePath } from '../issue/cli';
import { modelCalls } from '../core/model/llm';
import { parseIssue } from '../issue/parse';
import { probeDuration, type ReplayFile } from './bundle';
import { type EvidenceVerdict, type IncidentMeta, pickWindows, reviewIncident, scalePng, VERDICT_TEXT } from './evidence-review';

export const CASES_DIR = resolve('fixtures/evidence');

export interface EvidenceCase {
  id: string;
  issue: string;
  subcase: string;
  expect: Exclude<EvidenceVerdict, 'unverified'>;
  note: string;
  /** Built from frames that did not occur in one run (a control case); says how. */
  synthetic?: string;
  source?: string;
}

const flag = (a: string[], n: string) => (a.includes(`--${n}`) ? a[a.indexOf(`--${n}`) + 1] : undefined);

export function loadIssue(id: string) {
  return parseIssue(id, readFileSync(issuePath(id), 'utf8'));
}

/** Sub-case title of an incident: incident.json (newer bundles) or the run's result.json. */
export function subcaseOf(dir: string, meta: IncidentMeta): string {
  if (meta.title) return meta.title;
  const result = resolve(dir, '..', '..', '..', 'result.json');
  if (existsSync(result)) {
    const r = JSON.parse(readFileSync(result, 'utf8'));
    const hit = (r.results ?? []).find((x: any) => x.planId === meta.plan);
    if (hit?.title) return hit.title;
  }
  return meta.plan ?? '';
}

/** Freeze an incident into a preset case: trimmed + downscaled recording, metadata re-based to the clip. */
export async function snapshotCase(dir: string, c: Omit<EvidenceCase, 'source'>, o: { alignMs?: number } = {}): Promise<string> {
  const meta: IncidentMeta & Record<string, unknown> = JSON.parse(readFileSync(join(dir, 'incident.json'), 'utf8'));
  const replay: ReplayFile = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
  const out = join(CASES_DIR, c.id);
  await mkdir(join(out, 'video'), { recursive: true });
  const slim: IncidentMeta = { triggeredAt: meta.triggeredAt, detail: meta.detail, issue: meta.issue, plan: meta.plan, title: c.subcase, surface: meta.surface };
  if (meta.videoMerged && meta.video?.length) {
    // Bundles recorded before the recorder took the segment start from scrcpy's "Recording started" line
    // are behind by the client start-up time; --align-ms (measured: first visible reaction vs. its op) fixes it.
    const video = meta.video.map((v) => ({ startedAt: v.startedAt + (o.alignMs ?? 0), endedAt: v.endedAt, durationSec: v.durationSec ?? probeDuration(join(dir, 'video', (v as any).name)) }));
    const wins = pickWindows(replay, { ...meta, video });
    const from = Math.max(0, Math.floor((wins[0]?.sec ?? 0) - 1));
    const to = meta.videoSeconds ?? (wins.at(-1)?.toSec ?? 0) + 1;
    const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from), '-to', String(to), '-i', join(dir, 'video', meta.videoMerged), '-an', '-vf', 'scale=480:-2', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(out, 'video', 'merged.mp4')], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg trim failed: ${r.stderr}`);
    Object.assign(slim, { video, clipStartSec: from, videoMerged: 'merged.mp4', videoSeconds: Math.round((to - from) * 100) / 100 });
  }
  const steps = join(dir, 'steps');
  if (existsSync(steps)) {
    await mkdir(join(out, 'steps'), { recursive: true });
    for (const f of readdirSync(steps).filter((x) => x.endsWith('.png')).slice(-4)) await writeFile(join(out, 'steps', f), compactPng(scalePng(readFileSync(join(steps, f)))));
  }
  await writeFile(join(out, 'incident.json'), JSON.stringify(slim, null, 2));
  await writeFile(join(out, 'replay.json'), JSON.stringify({ ...replay, account: undefined, setupOps: [] }, null, 2));
  const kase: EvidenceCase = { ...c, source: dir.replace(/\\/g, '/').replace(/^.*?(midscene_run\/)/, '$1') };
  await writeFile(join(out, 'case.yaml'), yaml.dump(kase, { lineWidth: 120 }));
  return out;
}

/** Fixtures stay small in git: a 128-colour palette PNG (plenty for a chat screenshot at 480 px). */
export function compactPng(png: Buffer): Buffer {
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', 'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return r.status === 0 && r.stdout?.length ? r.stdout : png;
}

export function listCases(): EvidenceCase[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((d) => existsSync(join(CASES_DIR, d, 'case.yaml')))
    .map((d) => yaml.load(readFileSync(join(CASES_DIR, d, 'case.yaml'), 'utf8')) as EvidenceCase);
}

export interface CaseResult {
  id: string;
  expect: EvidenceCase['expect'];
  got: EvidenceVerdict;
  pass: boolean;
  observed: string;
  dir: string;
}

/** Run every preset case on a scratch copy (fixtures stay untouched); report under midscene_run/evidence-cases/. */
export async function runCases(only?: string): Promise<{ results: CaseResult[]; report: string }> {
  const runDir = resolve('midscene_run/evidence-cases', new Date().toISOString().replace(/[:.]/g, '-'));
  const results: CaseResult[] = [];
  const v0 = modelCalls.vision;
  for (const c of listCases().filter((x) => !only || x.id === only)) {
    const work = join(runDir, c.id);
    cpSync(join(CASES_DIR, c.id), work, { recursive: true });
    const r = await reviewIncident(work, loadIssue(c.issue), { subcase: c.subcase });
    results.push({ id: c.id, expect: c.expect, got: r.verdict, pass: r.verdict === c.expect, observed: r.observed || r.reason, dir: work });
  }
  const md = [
    `# 证据复核预置用例 — ${new Date().toISOString()}`,
    '',
    `通过 ${results.filter((r) => r.pass).length}/${results.length}；视觉模型调用 ${modelCalls.vision - v0}`,
    '',
    '| 用例 | 期望 | 实际 | 结果 | 画面所见 |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| [${r.id}](${r.id}/review/review.md) | ${VERDICT_TEXT[r.expect]} | ${VERDICT_TEXT[r.got]} | ${r.pass ? '✅' : '❌'} | ${r.observed.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
    '',
  ].join('\n');
  await mkdir(runDir, { recursive: true });
  const report = join(runDir, 'report.md');
  await writeFile(report, md);
  return { results, report };
}

export async function evidenceCmd(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const dir = rest.find((a) => !a.startsWith('--') && existsSync(a));
  if (sub === 'review') {
    if (!dir) throw new Error('usage: autotest evidence review <incidentDir> [--issue <id>] [--subcase "..."]');
    const meta: IncidentMeta = JSON.parse(readFileSync(join(dir, 'incident.json'), 'utf8'));
    const r = await reviewIncident(dir, loadIssue(flag(rest, 'issue') ?? meta.issue ?? ''), { subcase: flag(rest, 'subcase') ?? subcaseOf(dir, meta) });
    console.log(`[evidence] ${VERDICT_TEXT[r.verdict]} → ${join(dir, 'review', 'review.md')}`);
    return r.verdict === 'unverified' ? 2 : 0;
  }
  if (sub === 'snapshot') {
    const id = flag(rest, 'id');
    const expect = flag(rest, 'expect') as EvidenceCase['expect'];
    if (!dir || !id || !['consistent', 'inconsistent'].includes(expect)) throw new Error('usage: autotest evidence snapshot <incidentDir> --id <case> --expect consistent|inconsistent [--note ..] [--subcase ..]');
    const meta: IncidentMeta = JSON.parse(readFileSync(join(dir, 'incident.json'), 'utf8'));
    const out = await snapshotCase(dir, { id, issue: flag(rest, 'issue') ?? meta.issue ?? '', subcase: flag(rest, 'subcase') ?? subcaseOf(dir, meta), expect, note: flag(rest, 'note') ?? '', synthetic: flag(rest, 'synthetic') }, { alignMs: flag(rest, 'align-ms') ? Number(flag(rest, 'align-ms')) : undefined });
    console.log(`[evidence] case ${id} → ${out}`);
    return 0;
  }
  if (sub === 'cases') {
    const { results, report } = await runCases(flag(rest, 'id'));
    for (const r of results) console.log(`[evidence] ${r.pass ? 'PASS' : 'FAIL'} ${r.id}: expect ${r.expect}, got ${r.got} — ${r.observed}`);
    console.log(`[evidence] ${results.filter((r) => r.pass).length}/${results.length} passed → ${report}`);
    return results.length && results.every((r) => r.pass) ? 0 : 1;
  }
  console.error(`usage: autotest evidence review|snapshot|cases (cases dir: ${basename(CASES_DIR)})`);
  return 2;
}
