// Draft store (W2-1 §3.7 "confirmation = execution"): a draft is saved with a content hash and the hash of
// the Issue file it came from. Runs reuse the saved draft while the Issue file is unchanged (no model call),
// so what the user confirmed is exactly what runs; approved plans carry the draft hash.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Draft } from './planner';

export const PLANS_DIR = resolve('platform/plans');
export const DRAFTS_DIR = join(PLANS_DIR, 'drafts');

export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Pure: canonical JSON (sorted keys) so the hash does not depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Pure: content hash of what the user confirms (classification, contracts, sub-cases and their plans). */
export function draftHash(d: Draft): string {
  return sha(canonical({ issue: d.issue.id, classification: d.classification.category, status: d.status, contracts: d.contracts, subcases: d.subcases.map((s) => ({ sub: s.sub, surface: s.surface, substitution: s.substitution, plan: s.plan, contract: s.contract })) }));
}

export async function saveDraft(d: Draft, issueText: string, env: string): Promise<Draft> {
  d.hash = draftHash(d);
  d.issueHash = sha(issueText);
  d.env = env;
  await mkdir(DRAFTS_DIR, { recursive: true });
  await writeFile(join(DRAFTS_DIR, `${d.issue.id}.json`), JSON.stringify(d, null, 2));
  return d;
}

/** The saved draft, if it was made from this exact Issue text for this env and is intact. */
export function loadSavedDraft(id: string, issueText: string, env: string, dir = DRAFTS_DIR): Draft | undefined {
  const f = join(dir, `${id}.json`);
  if (!existsSync(f)) return undefined;
  const d = JSON.parse(readFileSync(f, 'utf8')) as Draft;
  if (!d.hash || d.issueHash !== sha(issueText) || d.env !== env) return undefined;
  if (draftHash(d) !== d.hash) return undefined; // edited by hand → draft again
  return d;
}
