// Evidence review: before a check-based hit counts as a reproduction, the recorded evidence — frames of the
// screen recording around the flagged round (or the round-end screenshots when there is no video) — goes to
// the vision model together with the Issue's expected / actual result. The hit stands only when the frames
// show the phenomenon the Issue describes; otherwise it is dismissed as a false alarm of the automated check.
// (1329 s2: the jump landed on the right message; the reference comparison failed because the quoted bubble
// wrapped onto two lines in the narrow viewport and was briefly highlighted.)
// Runs offline on the incident bundle, after the round — never inside the action loop.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { visionConfigured, visionJson } from '../issue/llm';
import type { NormalizedIssue } from '../issue/parse';
import { type ReplayFile, type VideoSeg, videoTimeOf } from './bundle';
import type { CoordOp } from './recording-driver';

export type EvidenceVerdict = 'consistent' | 'inconsistent' | 'unverified';

export interface FrameWindow {
  label: string;
  /** Strip start (s into the recording), end, spacing, frame count. */
  sec: number;
  toSec: number;
  step: number;
  count: number;
}

/** The fields of incident.json the review reads. */
export interface IncidentMeta {
  triggeredAt: string;
  detail: string;
  issue?: string;
  plan?: string;
  title?: string;
  surface?: string;
  video?: VideoSeg[];
  videoMerged?: string;
  videoSeconds?: number;
  /** Preset cases keep a trimmed clip: it starts this many seconds into the original recording. */
  clipStartSec?: number;
}

export interface Vote {
  consistent: boolean | null;
  observed: string;
  reason: string;
}

export interface EvidenceReview {
  verdict: EvidenceVerdict;
  observed: string;
  reason: string;
  votes: Vote[];
  frames: { label: string; sec?: number; file: string }[];
  source: 'video' | 'screenshots' | 'none';
  at: string;
}

const FRAME_WIDTH = 480;
const ff = () => process.env.FFMPEG_PATH || 'ffmpeg';

/** Ops that are the action under test (not the restore steps after the checkpoint, not pauses). */
const isMain = (o: CoordOp) => !(o.label ?? '').startsWith('after:') && !['wait', 'idle'].includes(o.op);

/** Pure: which stretches of the recording to show. Per round (the flagged one, and the one before as the
 *  normal-looking reference): from 2.5 s before its action to 4 s after (or until the restore steps begin),
 *  as a strip of frames every `step` s. A strip rather than single instants: the recording is variable
 *  frame rate and the app's reaction time varies, so op times only place the action to within ~1.5 s. */
export function pickWindows(replay: ReplayFile, meta: IncidentMeta, step = 0.75): FrameWindow[] {
  const segs = meta.video;
  if (!segs?.length) return [];
  // Ops and segment starts are both host times; the clip offset re-bases a trimmed preset recording.
  const t = (ms: number) => videoTimeOf(segs, ms) - (meta.clipStartSec ?? 0);
  const end = (meta.videoSeconds ?? Number.POSITIVE_INFINITY) - 0.05;
  const what = (o: CoordOp) => {
    const tgt = o.label?.startsWith('target.') ? replay.targets.find((x) => x.id === o.label!.slice(7))?.chosen : undefined;
    return `${o.op}${o.label ? ` ${o.label}` : ''}${tgt ? ` (${tgt})` : ''}`;
  };
  const out: FrameWindow[] = [];
  for (const r of replay.rounds.filter((x) => x.round >= replay.incidentRound - 1 && x.round <= replay.incidentRound)) {
    const main = r.ops.filter(isMain);
    if (!main.length) continue;
    const first = main[0];
    const last = main[main.length - 1];
    const restoreAt = r.ops.find((o) => o.at > last.at && (o.label ?? '').startsWith('after:'))?.at;
    const from = Math.max(0, t(first.at) - 2.5);
    const to = Math.min(end, t(last.at + last.durationMs) + 4, restoreAt !== undefined ? t(restoreAt) - 0.1 : Number.POSITIVE_INFINITY);
    if (to - from < step) continue;
    const count = Math.min(10, Math.floor((to - from) / step) + 1);
    const actionFrame = Math.min(count, Math.max(1, Math.round((t(first.at) - from) / step) + 1));
    const tag = r.round === replay.incidentRound ? 'the FLAGGED round' : 'the previous round (looked normal to the check — reference)';
    const did = main.length === 1 ? what(first) : main.map(what).join(' → ');
    out.push({
      label: `Strip of ${count} frames, left to right one every ${step} s, from ${tag} ${r.round}. The user action "${did}" happens at about frame ${actionFrame} (timing ±1.5 s): frames before it show the screen before the action, frames after it the result.`,
      sec: Math.round(from * 100) / 100,
      toSec: Math.round(to * 100) / 100,
      step,
      count,
    });
  }
  return out;
}

/** A strip of `count` frames from `sec`, one every `step` s, side by side. */
export function videoStrip(file: string, w: FrameWindow, width = 200): Buffer | undefined {
  const r = spawnSync(ff(), ['-loglevel', 'error', '-ss', w.sec.toFixed(2), '-i', file, '-t', (w.count * w.step).toFixed(2), '-vf', `fps=1/${w.step},scale=${width}:-2,tile=${w.count}x1:padding=8:color=white`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return r.status === 0 && r.stdout?.length ? r.stdout : undefined;
}

/** One video frame, scaled to FRAME_WIDTH. */
export function videoFrame(file: string, sec: number, width = FRAME_WIDTH): Buffer | undefined {
  const r = spawnSync(ff(), ['-loglevel', 'error', '-ss', sec.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return r.status === 0 && r.stdout?.length ? r.stdout : undefined;
}

/** A PNG scaled to FRAME_WIDTH (screenshots are full device resolution). */
export function scalePng(png: Buffer, width = FRAME_WIDTH): Buffer {
  const r = spawnSync(ff(), ['-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return r.status === 0 && r.stdout?.length ? r.stdout : png;
}

/** Round-end checkpoint screenshots of the bundle (steps/round-R-step-S.png), oldest first, scaled. */
function stepShots(dir: string): { round: number; png: Buffer }[] {
  const steps = join(dir, 'steps');
  if (!existsSync(steps)) return [];
  return readdirSync(steps)
    .map((f) => ({ f, m: f.match(/^round-(\d+)-step-(\d+)\.png$/) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => ({ round: Number(x.m![1]), png: scalePng(readFileSync(join(steps, x.f))) }));
}

/** Frames of an incident bundle: from the recording when there is one, else its round-end screenshots. */
export function collectFrames(dir: string): { source: EvidenceReview['source']; frames: { label: string; sec?: number; png: Buffer }[] } {
  const meta: IncidentMeta = JSON.parse(readFileSync(join(dir, 'incident.json'), 'utf8'));
  const video = meta.videoMerged ? join(dir, 'video', meta.videoMerged) : undefined;
  const shots = stepShots(dir);
  if (video && existsSync(video) && existsSync(join(dir, 'replay.json'))) {
    const replay: ReplayFile = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
    const frames: { label: string; sec?: number; png: Buffer }[] = pickWindows(replay, meta)
      .map((w) => ({ label: w.label, sec: w.sec, png: videoStrip(video, w) }))
      .filter((f): f is { label: string; sec: number; png: Buffer } => !!f.png);
    // The exact screen the automated check judged (full resolution, scaled): the end state of the flagged round.
    const flagged = shots.at(-1);
    if (frames.length && flagged) frames.push({ label: `The screenshot the automated check judged at the end of the flagged round ${flagged.round}.`, png: flagged.png });
    if (frames.length) return { source: 'video', frames };
  }
  if (shots.length) return { source: 'screenshots', frames: shots.slice(-4).map((x, i, all) => ({ label: `End of round ${x.round} (checkpoint screenshot${i === all.length - 1 ? ', the flagged round' : ''}).`, png: x.png })) };
  return { source: 'none', frames: [] };
}

export const REVIEW_SYSTEM = `You review evidence from an automated black-box UI test before a bug is reported as reproduced.
You get the Issue (summary, expected result, actual result), the sub-case under test, what the automated check flagged, and images of the screen in time order: strips of recording frames around the user action (each strip says where the action falls) and the screenshot the check judged.
Decide whether the frames show the phenomenon that the Issue's ACTUAL RESULT describes for this sub-case.
Rules:
- Judge only what is visible. The automated check compares pixels with a reference and can be wrong; its claim is not evidence.
- Rendering differences that leave the same content on screen are NOT the phenomenon: text wrapping onto more lines in a narrow bubble, a temporary highlight or tint, a slightly different scroll offset, loading placeholders, status-bar changes, the keyboard.
- If the action led somewhere unrelated to the Issue (another app, a web page, a different screen than the sub-case is about), that is not the phenomenon either.
- If the frames cannot tell, answer null.
Reply with JSON only: {"consistent": true | false | null, "observed": "<what the frames show, 1-2 sentences>", "reason": "<why it does / does not match the Issue's actual result>"}`;

export function reviewPrompt(issue: Pick<NormalizedIssue, 'id' | 'summary' | 'expected' | 'actual'>, subcase: string, flagged: string): string {
  return [
    `Issue #${issue.id}`,
    `Summary: ${issue.summary}`,
    `Expected result: ${issue.expected}`,
    `Actual result (the phenomenon to look for): ${issue.actual}`,
    `Sub-case under test: ${subcase}`,
    `The automated check flagged: ${flagged}`,
    'Images follow in time order.',
  ].join('\n');
}

/** Pure: majority of the non-null votes; a tie or no decided vote is unverified. */
export function tally(votes: Vote[]): EvidenceVerdict {
  const yes = votes.filter((v) => v.consistent === true).length;
  const no = votes.filter((v) => v.consistent === false).length;
  return yes > no ? 'consistent' : no > yes ? 'inconsistent' : 'unverified';
}

const asVote = (x: any): Vote | undefined =>
  x && typeof x === 'object' && 'consistent' in x ? { consistent: x.consistent === true ? true : x.consistent === false ? false : null, observed: String(x.observed ?? ''), reason: String(x.reason ?? '') } : undefined;

/** Review one incident bundle against the Issue. Writes review/ (frames, review.json, review.md) into it. */
export async function reviewIncident(dir: string, issue: Pick<NormalizedIssue, 'id' | 'summary' | 'expected' | 'actual'>, o: { subcase?: string; votes?: number; log?: (s: string) => void } = {}): Promise<EvidenceReview> {
  const log = o.log ?? ((s: string) => console.log(`[evidence] ${s}`));
  const meta: IncidentMeta = JSON.parse(readFileSync(join(dir, 'incident.json'), 'utf8'));
  const { source, frames } = collectFrames(dir);
  const outDir = join(dir, 'review');
  await mkdir(outDir, { recursive: true });
  const files = frames.map((f, i) => ({ label: f.label, sec: f.sec, file: `review/frame-${i + 1}.png` }));
  for (let i = 0; i < frames.length; i++) await writeFile(join(dir, files[i].file), frames[i].png);
  const review: EvidenceReview = { verdict: 'unverified', observed: '', reason: '', votes: [], frames: files, source, at: new Date().toISOString() };
  if (!frames.length) review.reason = 'no recording or screenshots in the bundle';
  else if (!visionConfigured()) review.reason = 'vision model not configured';
  else {
    const prompt = reviewPrompt(issue, o.subcase ?? meta.title ?? meta.plan ?? '', meta.detail);
    const parts = [prompt, ...frames.map((f, i) => ({ label: `Image ${i + 1}: ${f.label}`, png: f.png }))];
    const n = o.votes ?? 3;
    // Independent answers, majority wins; stop once a side has the majority.
    for (let i = 0; i < n; i++) {
      const v = asVote(await visionJson(REVIEW_SYSTEM, parts));
      if (v) review.votes.push(v);
      const yes = review.votes.filter((x) => x.consistent === true).length;
      const no = review.votes.filter((x) => x.consistent === false).length;
      if (yes > n / 2 || no > n / 2) break;
    }
    review.verdict = tally(review.votes);
    const lead = review.votes.find((v) => (review.verdict === 'consistent' ? v.consistent === true : review.verdict === 'inconsistent' ? v.consistent === false : true));
    review.observed = lead?.observed ?? '';
    review.reason = lead?.reason ?? (review.votes.length ? 'votes split' : 'vision call failed');
  }
  await writeFile(join(outDir, 'review.json'), JSON.stringify(review, null, 2));
  await writeFile(join(outDir, 'review.md'), reviewMarkdown(review, issue.id));
  log(`${dir}: ${review.verdict} (${review.votes.map((v) => String(v.consistent)).join('/') || '-'}) — ${review.observed || review.reason}`);
  return review;
}

export const VERDICT_TEXT: Record<EvidenceVerdict, string> = { consistent: '证据符合 Issue 描述', inconsistent: '证据不符合 Issue 描述（自动检查误报）', unverified: '未能复核' };

export function reviewMarkdown(r: EvidenceReview, issueId?: string): string {
  return [
    `# 证据复核${issueId ? ` — Issue ${issueId}` : ''}`,
    '',
    `- 结论：**${VERDICT_TEXT[r.verdict]}**`,
    `- 画面所见：${r.observed || '-'}`,
    `- 理由：${r.reason || '-'}`,
    `- 来源：${r.source === 'video' ? '录屏抽帧' : r.source === 'screenshots' ? '检查点截图' : '无'}；投票：${r.votes.map((v) => (v.consistent === null ? '无法判断' : v.consistent ? '符合' : '不符')).join(' / ') || '-'}`,
    '',
    ...r.frames.map((f, i) => `${i + 1}. ${f.label}${f.sec !== undefined ? `（${f.sec.toFixed(1)} s）` : ''}\n\n   ![](${f.file.replace(/^review\//, '')})`),
    '',
  ].join('\n');
}
