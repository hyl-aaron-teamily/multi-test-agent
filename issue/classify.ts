// Pre-execution classification (W3-1 K4): rules read the structured fields only — Frequency and the
// platforms — plus reviewed manual overrides (platform/issue-overrides.yaml). The object, trigger and
// phenomenon are read from the Issue text by the model when it designs the case (issue/author.ts); keyword
// categories (feature / suspected-misuse / server-side …) no longer decide a plan's skeleton.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { PreCategory, Surface } from '../platform/schema/test-plan';
import type { NormalizedIssue } from './parse';

export interface Classification {
  category: PreCategory;
  /** Execution surfaces available for the platforms the Issue names (before substitution). */
  surfaces: Surface[];
  reason: string;
  /** Strong = a structured field or a manual override decided it. */
  strength: 'strong' | 'weak';
  by: 'rules' | 'model';
  /** feature that also needs a second account (manual override only). */
  partialMultiAccount?: boolean;
  /** deferred: the precondition library id that cannot be established (manual override). */
  blockedBy?: string;
}

export const AVAILABLE: Surface[] = ['android-app', 'mobile-web', 'desktop-web'];

/** Issue platform → our surfaces. ios has no direct surface (substitution needed). */
export function surfacesFor(platforms: string[]): Surface[] {
  const s = new Set<Surface>();
  for (const p of platforms) {
    if (p === 'android') s.add('android-app');
    if (p === 'web' || p === 'desktop') s.add('desktop-web');
  }
  return [...s];
}

const OVERRIDES_FILE = resolve(process.env.ISSUE_OVERRIDES_FILE ?? 'platform/issue-overrides.yaml');

/** Manual overrides (platform/issue-overrides.yaml): an explicit, reviewed decision beats the rules. */
export function overrideFor(id: string, file = OVERRIDES_FILE): { category: PreCategory; reason: string; precondition?: string } | undefined {
  if (!existsSync(file)) return undefined;
  const o = ((yaml.load(readFileSync(file, 'utf8')) ?? {}) as Record<string, { category?: PreCategory; reason?: string; precondition?: string }>)[id];
  return o?.category ? { category: o.category, reason: String(o.reason ?? 'manual override'), precondition: o.precondition } : undefined;
}

/** Pure (apart from the override file): Frequency → always / intermittent; an empty Issue is not executable. */
export function classifyRules(i: NormalizedIssue): Classification {
  const surfaces = surfacesFor(i.platforms);
  const ov = overrideFor(i.id);
  if (ov) return { category: ov.category, surfaces, reason: ov.reason, strength: 'strong', by: 'rules', ...(ov.precondition ? { blockedBy: ov.precondition } : {}) };
  const mk = (category: PreCategory, reason: string, strength: 'strong' | 'weak' = 'strong'): Classification => ({ category, surfaces, reason, strength, by: 'rules' });
  if (i.empty) return mk('not-executable', 'Issue 文档为空：没有摘要和复现步骤，无可观察现象');
  const f = i.frequency.toLowerCase();
  if (/always|必现|100%|every time/.test(f)) return mk('bug-always', `Frequency: ${i.frequency}`);
  if (f.trim()) return mk('bug-intermittent', `Frequency: ${i.frequency}`);
  return mk('bug-intermittent', '频率未声明，按偶现处理', 'weak');
}

/** Kept async for callers; no model call (K4). */
export async function classify(i: NormalizedIssue): Promise<Classification> {
  return classifyRules(i);
}
