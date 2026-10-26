// SKILL profile: calibrated coordinates of fixed UI elements + reference regions, per execution surface.
// Plans reference element ids only; the executor resolves ids → points through the profile of its surface.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Box } from '../core/image';
import type { Surface } from '../platform/accounts/types';

export const SKILL_DIR = resolve('skills/teamily');

export type SelfCheck = 'pass' | 'fail' | 'pending';

export interface ElementCal {
  page: string;
  /** [x, y, w, h] in surface coordinates (CSS px for web, device px for Android). */
  box: Box;
  selfCheck: SelfCheck;
  /** What the self-check observed (or why it failed). */
  note?: string;
  /** Text fingerprint recorded at calibration (W2-1 self-heal): accessibility text / desc / class, or page text. */
  fingerprint?: { text?: string; desc?: string; cls?: string };
}

export interface PageRef {
  /** Path relative to the skill dir. */
  image: string;
  /** Stable sub-regions; checkpoints compare these. */
  regions: Record<string, Box>;
  hashes: Record<string, string>;
  greys: Record<string, number>;
}

export interface Profile {
  surface: Surface;
  /** Profile key: desktop-web | mobile-web | android-<udid>. */
  name: string;
  skillVersion: string;
  env: 'test' | 'prod';
  calibratedAt: string;
  viewport: { width: number; height: number };
  /** mobile-web: Playwright device descriptor name. android-app: package. */
  device?: string;
  packageName?: string;
  elements: Record<string, ElementCal>;
  refs: Record<string, PageRef>;
  /** Failed self-checks awaiting human review (annotated images under refs/). */
  reviewQueue: { element: string; image: string; reason: string }[];
}

export class SkillStaleError extends Error {
  constructor(
    readonly page: string,
    detail: string,
  ) {
    super(`SKILL 失效 @ 页面 ${page}: ${detail} — 请重新标定 (pnpm autotest skill calibrate)`);
    this.name = 'SkillStaleError';
  }
}

export function profilePath(name: string, dir = SKILL_DIR): string {
  return join(dir, 'profiles', `${name}.json`);
}

export function loadProfile(name: string, dir = SKILL_DIR): Profile | undefined {
  const f = profilePath(name, dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Profile) : undefined;
}

export async function saveProfile(p: Profile, dir = SKILL_DIR): Promise<string> {
  const f = profilePath(p.name, dir);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(p, null, 2));
  return f;
}

export function center(b: Box): { x: number; y: number } {
  return { x: Math.round(b[0] + b[2] / 2), y: Math.round(b[1] + b[3] / 2) };
}

/** Element id → tap point. Throws if the element is not calibrated (or failed self-check and was never reviewed). */
export function pointOf(p: Profile, id: string): { x: number; y: number } {
  const e = p.elements[id];
  if (!e) throw new Error(`element ${id} not calibrated in profile ${p.name}`);
  if (e.selfCheck === 'fail') throw new Error(`element ${id} failed calibration self-check in ${p.name} (${e.note ?? 'see reviewQueue'})`);
  return center(e.box);
}
