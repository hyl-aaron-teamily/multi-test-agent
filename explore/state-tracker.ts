// UI state fingerprint + per-state explored-element bookkeeping for the explorer.
// Fingerprint: prefer the AI-extracted page title (+ resumed activity from dumpsys); fall back to
// md5(screenshot) first 12 chars + element type distribution when the AI answer is empty/unstable.
// Only node:crypto is used for hashing (no image-hash dependency, per milestone-3 constraint).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AndroidAgent } from '@midscene/android';
import { adb, screencap } from '../core/adb';
import { elementKey, type InteractiveElement } from './page-observer';

export type FingerprintSource = 'ai' | 'screenshot-hash';

export interface CapturedState {
  stateId: string;
  source: FingerprintSource;
  title: string;
  activity: string;
  screenshot: Buffer;
}

const md5 = (data: string | Buffer) => createHash('md5').update(data).digest('hex');

/** Resumed activity (e.g. `ai.teamily.mobile/.MainActivity`), '' if unknown. */
export async function currentActivity(udid?: string): Promise<string> {
  const out = await adb(['shell', 'dumpsys', 'activity', 'activities'], udid).catch(() => '');
  const line = out.split('\n').find((l) => /topResumedActivity|mResumedActivity/.test(l)) ?? '';
  return line.match(/\s(\S+\/\S+)/)?.[1]?.replace(/\}$/, '') ?? '';
}

/** A title is usable as identity if it is short, non-empty and not a generic "unknown". Pure. */
export function isStableTitle(title: string): boolean {
  const t = title.trim();
  return t.length > 0 && t.length <= 40 && !/^(unknown|none|n\/a|null|未知)$/i.test(t);
}

export function screenshotFingerprint(png: Buffer, elements: InteractiveElement[] = []): string {
  const dist = new Map<string, number>();
  for (const e of elements) dist.set(e.type, (dist.get(e.type) ?? 0) + 1);
  const d = [...dist].sort().map(([k, v]) => `${k}${v}`).join('');
  return `s-${md5(png).slice(0, 12)}${d ? `-${d}` : ''}`;
}

export async function captureState(
  udid: string | undefined,
  agent: AndroidAgent,
  elements: InteractiveElement[] = [],
): Promise<CapturedState> {
  const [screenshot, activity] = await Promise.all([screencap(udid), currentActivity(udid)]);
  let title = '';
  try {
    title = String(
      (await agent.aiString(
        'The title or the most identifying heading of the current page in under 6 words (e.g. "Profile", "Agent list"). ' +
          'Ignore dynamic content like time, counters or message previews.',
      )) ?? '',
    ).trim();
  } catch {
    title = '';
  }
  if (isStableTitle(title)) {
    return { stateId: `a-${md5(`${activity}|${title.toLowerCase()}`).slice(0, 12)}`, source: 'ai', title, activity, screenshot };
  }
  return { stateId: screenshotFingerprint(screenshot, elements), source: 'screenshot-hash', title, activity, screenshot };
}

/** In-memory record of which element was tried in which state. Optional JSON persistence. */
export class StateTracker {
  private readonly explored = new Map<string, Set<string>>();
  readonly titles = new Map<string, string>();

  constructor(private readonly persistFile?: string) {}

  static async load(persistFile?: string): Promise<StateTracker> {
    const t = new StateTracker(persistFile);
    if (persistFile && existsSync(persistFile)) {
      const data = JSON.parse(await readFile(persistFile, 'utf8')) as Record<string, string[]>;
      for (const [k, v] of Object.entries(data)) t.explored.set(k, new Set(v));
    }
    return t;
  }

  see(stateId: string, title: string): void {
    if (!this.explored.has(stateId)) this.explored.set(stateId, new Set());
    if (title) this.titles.set(stateId, title);
  }

  markExplored(stateId: string, key: string): void {
    this.see(stateId, '');
    this.explored.get(stateId)!.add(key);
  }

  unexplored(stateId: string, elements: InteractiveElement[]): InteractiveElement[] {
    const done = this.explored.get(stateId) ?? new Set();
    return elements.filter((e) => !done.has(elementKey(e)));
  }

  hasUnexplored(stateId: string, elements: InteractiveElement[]): boolean {
    return this.unexplored(stateId, elements).length > 0;
  }

  get stateCount(): number {
    return this.explored.size;
  }

  async save(): Promise<void> {
    if (!this.persistFile) return;
    await mkdir(dirname(resolve(this.persistFile)), { recursive: true });
    const obj = Object.fromEntries([...this.explored].map(([k, v]) => [k, [...v]]));
    await writeFile(this.persistFile, JSON.stringify(obj, null, 2));
  }
}
