// SKILL profile = runtime locate cache (refactor P3, replaces offline calibration). Plans reference element ids
// only; the executor resolves ids → points through the profile of its surface. Elements and reference regions
// are located on the live screen the first time they are needed outside the loop (SkillResolver,
// executor/skill-resolver.ts) and cached per surface@env@appVersion@resolution under
// platform/state/skill-cache/ — an app update or another screen size starts a fresh cache by itself.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Box } from '../core/image';
import type { Surface } from '../platform/accounts/types';
import { stateRoot } from '../platform/lifecycle/store';

export interface ElementCal {
  page: string;
  /** [x, y, w, h] in surface coordinates (CSS px for web, device px for Android). */
  box: Box;
  /** What was found there (accessibility text / desc / class): the pre-tap check compares against it. */
  fingerprint?: { text?: string; desc?: string; cls?: string };
  /** How it was located: ① text, ② ranked, ③ vision, rule = SKILL finder over the screen nodes. */
  tier?: string;
  at?: string;
}

export interface RegionRef {
  box: Box;
  /** Screenshot the region was captured from (file name in the cache dir). */
  image: string;
  at?: string;
}

export interface Profile {
  surface: Surface;
  /** Cache key: <surface>@<env>@<appVersion>@<width>x<height>. */
  name: string;
  skillVersion: string;
  env: 'test' | 'prod';
  appVersion?: string;
  viewport: { width: number; height: number };
  /** android-app / android-web: package of the app under test (the browser for android-web). */
  packageName?: string;
  elements: Record<string, ElementCal>;
  /** page → region → reference. */
  refs: Record<string, Record<string, RegionRef>>;
  /** Runtime only (never saved): locates what is missing. Absent = cache-only (tests, replay). */
  resolver?: SkillResolverLike;
}

/** What checks / nodes / surfaces need from the resolver (implemented in executor/skill-resolver.ts). */
export interface SkillResolverLike {
  /** True inside the loop: nothing is located there, a missing element is an error. */
  inLoop: boolean;
  /** Make sure the element is in the cache (locate it on the current screen when it is not). False = not found. */
  element(id: string): Promise<boolean>;
  /** Capture the reference region `page/region` from the current screen when its anchors are there. */
  region(key: string): Promise<boolean>;
  /** The cached element / region no longer matches the screen: locate it again (rulesOnly: never vision). */
  refresh(key: string, o?: { rulesOnly?: boolean }): Promise<boolean>;
}

export class SkillStaleError extends Error {
  constructor(
    readonly page: string,
    detail: string,
  ) {
    super(`SKILL 失效 @ 页面 ${page}: ${detail}（SKILL 里的识别规则认不出当前界面，需要更新 skills/teamily/finders.ts）`);
    this.name = 'SkillStaleError';
  }
}

export const cacheRoot = () => join(stateRoot(), 'skill-cache');
export const cacheKey = (surface: Surface, env: string, appVersion: string | undefined, vp: { width: number; height: number }) => `${surface}@${env}@${appVersion ?? 'web'}@${vp.width}x${vp.height}`;
export const cacheDir = (key: string) => join(cacheRoot(), key.replace(/[^\w.@-]/g, '_'));

/** The cached profile for this key, or an empty one. */
export function loadCache(base: Omit<Profile, 'elements' | 'refs' | 'name'>, name: string): Profile {
  const f = join(cacheDir(name), 'profile.json');
  const empty: Profile = { ...base, name, elements: {}, refs: {} };
  if (!existsSync(f)) return empty;
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Profile;
    return { ...empty, elements: p.elements ?? {}, refs: p.refs ?? {} };
  } catch {
    return empty;
  }
}

export async function saveCache(p: Profile): Promise<void> {
  const dir = cacheDir(p.name);
  await mkdir(dir, { recursive: true });
  const { resolver: _r, ...data } = p;
  await writeFile(join(dir, 'profile.json'), JSON.stringify(data, null, 2));
}

export const refImagePath = (p: Pick<Profile, 'name'>, image: string) => join(cacheDir(p.name), image);

export function center(b: Box): { x: number; y: number } {
  return { x: Math.round(b[0] + b[2] / 2), y: Math.round(b[1] + b[3] / 2) };
}

/** Element id → tap point. Throws when the element is not in the cache (the resolver puts it there first). */
export function pointOf(p: Profile, id: string): { x: number; y: number } {
  const e = p.elements[id];
  if (!e) throw new Error(`element ${id} not located on ${p.surface}${p.resolver?.inLoop ? '（循环内不定位：预热轮没有用到它）' : ''}`);
  return center(e.box);
}

/** Resolve (outside the loop) then return the point. */
export async function pointFor(p: Profile, id: string): Promise<{ x: number; y: number }> {
  if (!p.elements[id] && p.resolver && !p.resolver.inLoop) await p.resolver.element(id);
  return pointOf(p, id);
}

/** Is the element there (located now when it is not cached)? Loop: cache only. */
export async function hasElement(p: Profile, id: string): Promise<boolean> {
  if (p.elements[id]) return true;
  if (!p.resolver || p.resolver.inLoop) return false;
  return p.resolver.element(id);
}
