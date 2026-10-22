// Unified incident bundle (milestone 5 §D.3), same layout for Android and Web:
//   <run>/incidents/<n>-<kind>/{index.html, incident.json, video/, trace/, logs/, steps/, state/, replay.json}
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, dHash } from '../core/image';
import type { AnomalyKind } from '../drivers/types';
import type { TestPlan } from '../platform/schema/test-plan';
import type { CoordOp } from './recording-driver';
import { viewerHtml } from './viewer';

export type IncidentKind = 'crash' | 'anr' | 'app-exit' | 'check-failed' | 'console-error' | 'page-error' | 'visual-anomaly' | 'watchdog';

export function incidentKind(a: AnomalyKind | 'check-failed' | 'watchdog'): IncidentKind {
  if (a === 'page-crash') return 'page-error';
  if (a === 'left-app') return 'app-exit';
  if (a === 'app-error' || a === 'url-change') return 'visual-anomaly';
  return a as IncidentKind;
}

export interface RoundFrame {
  round: number;
  step: number;
  at: number;
  hash: string;
  png?: Buffer;
}

export interface ReplayFile {
  format: 'coord-v1';
  skillVersion: string;
  surface: TestPlan['surface'];
  profile: string;
  env: TestPlan['env'];
  url?: string;
  packageName?: string;
  account?: string;
  launch: TestPlan['launch'];
  category: TestPlan['category'];
  verdictRule: TestPlan['verdictRule'];
  checks: TestPlan['checks'];
  /** Frozen targets of the original run (for the record; ops already carry coordinates). */
  targets: { id: string; point: { x: number; y: number }; chosen: string }[];
  /** Ops before the loop (login excluded), replayed once. */
  setupOps: CoordOp[];
  /** Loop ops grouped by round, from the first kept round up to the incident. */
  rounds: { round: number; ops: CoordOp[]; endHash?: string }[];
  incidentRound: number;
}

export interface IncidentInput {
  runDir: string;
  n: number;
  kind: IncidentKind;
  at: number;
  detail: string;
  plan: TestPlan;
  step: number;
  round: number;
  action: string;
  env: Record<string, unknown>;
  ops: CoordOp[];
  frames: RoundFrame[];
  replay: ReplayFile;
  videos?: { name: string; startedAt: number; endedAt: number }[];
  traces?: { name: string; startedAt: number; endedAt: number }[];
  logFrom: number;
  logTo: number;
  clockOffsetMs?: number;
  /** Extra files already written into the dir by a recorder (logs/, state/). */
  dir: string;
}

export const incidentDir = (runDir: string, n: number, kind: IncidentKind) => join(runDir, 'incidents', `${n}-${kind}`);

export interface VideoSeg {
  startedAt: number;
  endedAt?: number;
  /** Probed length of the segment (its last frame). Missing in older bundles → wall time. */
  durationSec?: number;
}

/** Host time (ms) → seconds into the merged recording. Segments are concatenated back to back, so a
 *  segment starts at the summed durations of the earlier ones (the wall-clock gaps are not in the video). */
export function videoTimeOf(segs: VideoSeg[], hostMs: number): number {
  let base = 0;
  let k = 0;
  for (let i = 1; i < segs.length && segs[i].startedAt <= hostMs; i++) k = i;
  for (let i = 0; i < k; i++) base += segs[i].durationSec ?? ((segs[i].endedAt ?? segs[i].startedAt) - segs[i].startedAt) / 1000;
  return base + (hostMs - segs[k].startedAt) / 1000;
}

/** ops.srt: one subtitle per op, on the merged recording's timeline. */
export function opsSrt(ops: CoordOp[], segs: VideoSeg[] | number): string {
  const sg: VideoSeg[] = typeof segs === 'number' ? [{ startedAt: segs }] : segs;
  const videoStart = sg[0].startedAt;
  const ts = (ms: number) => {
    const t = Math.max(0, ms);
    const h = Math.floor(t / 3_600_000);
    const m = Math.floor((t % 3_600_000) / 60_000);
    const s = Math.floor((t % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`;
  };
  return ops
    .filter((o) => o.at >= videoStart)
    .map((o, i) => {
      const t = Math.round(videoTimeOf(sg, o.at) * 1000);
      return `${i + 1}\n${ts(t)} --> ${ts(t + Math.max(400, o.durationMs))}\n#${o.step} r${o.round} ${o.op}${o.point ? ` (${o.point.x},${o.point.y})` : ''}${o.value ? ` "${o.value.slice(0, 20)}"` : ''} ${o.label ?? ''}\n`;
    })
    .join('\n');
}

/** Merge mkv/mp4 segments into one mp4 (stream copy). Returns file name or undefined. */
export function mergeVideo(dir: string, names: string[]): string | undefined {
  if (!names.length) return undefined;
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  const list = join(dir, 'video', 'segments.txt');
  writeFileSync(list, names.map((n) => `file '${n}'`).join('\n'));
  const out = join(dir, 'video', 'merged.mp4');
  const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { cwd: join(dir, 'video'), encoding: 'utf8', windowsHide: true });
  return r.status === 0 && existsSync(out) ? 'merged.mp4' : undefined;
}

/** One PNG frame at `sec` (ffmpeg), or undefined. */
export function frameAt(file: string, sec: number): Buffer | undefined {
  if (sec < 0) return undefined;
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-ss', sec.toFixed(2), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return r.status === 0 && r.stdout?.length ? r.stdout : undefined;
}

export function probeDuration(file: string): number | undefined {
  const r = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true });
  const d = Number(r.stdout?.trim());
  return r.status === 0 && Number.isFinite(d) ? d : undefined;
}

export async function writeIncident(i: IncidentInput): Promise<string> {
  const dir = i.dir;
  await mkdir(join(dir, 'steps'), { recursive: true });
  for (const f of i.frames.filter((f) => f.png).slice(-10)) await writeFile(join(dir, 'steps', `round-${f.round}-step-${f.step}.png`), f.png!);
  let merged: string | undefined;
  let videoSec: number | undefined;
  const videoStart = i.videos?.[0]?.startedAt;
  const segs: (VideoSeg & { name: string })[] = (i.videos ?? []).map((v) => ({ ...v, durationSec: probeDuration(join(dir, 'video', v.name)) }));
  if (segs.length) {
    merged = mergeVideo(dir, segs.map((v) => v.name));
    if (merged) videoSec = probeDuration(join(dir, 'video', merged));
    await writeFile(join(dir, 'video', 'ops.srt'), opsSrt(i.ops, segs));
  }
  // Round-end reference frames for replay deviation: from the video when the run took no checkpoint shots.
  if (merged && videoStart) {
    for (const r of i.replay.rounds) {
      if (r.endHash || !r.ops.length) continue;
      const last = r.ops[r.ops.length - 1];
      const t = videoTimeOf(segs, last.at + last.durationMs + 400);
      const png = frameAt(join(dir, 'video', merged), t);
      if (png) r.endHash = dHash(decodePng(png));
    }
  }
  const meta = {
    kind: i.kind,
    triggeredAt: new Date(i.at).toISOString(),
    detail: i.detail,
    plan: i.plan.id,
    issue: i.plan.issueRef,
    surface: i.plan.surface,
    substitution: i.plan.substitution,
    env: i.plan.env,
    step: i.step,
    round: i.round,
    action: i.action,
    window: { from: new Date(i.logFrom).toISOString(), to: new Date(i.logTo).toISOString() },
    clockOffsetMs: i.clockOffsetMs,
    title: i.plan.title,
    video: segs.length ? segs.map((v) => ({ ...v, startedAtIso: new Date(v.startedAt).toISOString(), endedAtIso: new Date(v.endedAt!).toISOString() })) : undefined,
    videoMerged: merged,
    videoSeconds: videoSec,
    videoCoversSecondsBeforeTrigger: segs.length ? Math.round(videoTimeOf(segs, i.at)) : undefined,
    traces: i.traces,
    environment: i.env,
    lastOps: i.ops.slice(-30),
  };
  await writeFile(join(dir, 'incident.json'), JSON.stringify(meta, null, 2));
  await writeFile(join(dir, 'replay.json'), JSON.stringify(i.replay, null, 2));
  await writeFile(join(dir, 'index.html'), viewerHtml(meta, i.ops, dir));
  return dir;
}
