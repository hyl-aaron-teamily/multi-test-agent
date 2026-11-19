// Draft store (W2-1 §3.7 "confirmation = execution"): a draft is saved with a content hash and the hash of
// the Issue file it came from. Runs reuse the saved draft while the Issue file is unchanged (no model call),
// so what the user confirmed is exactly what runs; approved plans carry the draft hash.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Draft } from './planner';

export const PLANS_DIR = resolve('platform/plans');
/** Unit tests point AUTOTEST_DRAFTS_DIR at committed fixtures (issue/__fixtures__/drafts): redrafting (W3-1 R4) replaces the live drafts. */
export const DRAFTS_DIR = resolve(process.env.AUTOTEST_DRAFTS_DIR ?? join(PLANS_DIR, 'drafts'));

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

/** Pure: the version a draft with `hash` gets after `prev` (a saved draft without a version counts as v1). */
export const nextVersion = (prev: Pick<Draft, 'hash' | 'version'> | undefined, hash: string): number => (!prev ? 1 : prev.hash === hash ? (prev.version ?? 1) : (prev.version ?? 1) + 1);

export async function saveDraft(d: Draft, issueText: string, env: string): Promise<Draft> {
  d.hash = draftHash(d);
  d.issueHash = sha(issueText);
  d.env = env;
  // Plan ids carry the draft version: the same content keeps its version, new content gets the next one.
  const f = join(DRAFTS_DIR, `${d.issue.id}.json`);
  const prev = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Draft & RecordCarry) : undefined;
  d.version = nextVersion(prev, d.hash);
  // W3-6 §5: the version is the record's rev; history and side chat stay with the Issue across deliveries.
  const r = d as Draft & RecordCarry;
  const same = !!prev && prev.version === d.version;
  r.rev = d.version;
  r.chat = r.chat ?? prev?.chat ?? [];
  const prevRevs = prev?.revs ?? (prev ? [{ rev: prev.version ?? 1, source: 'model', at: new Date(0).toISOString(), paths: [], reason: '迁移：W3-6 之前的草稿', snapshot: { status: prev.status, reason: prev.reason, envelope: prev.envelope } }] : []);
  r.revs = same ? prevRevs : [...prevRevs, { rev: d.version, source: prev ? (d.planVersion && d.planVersion > 1 ? 'model' : 'redesign') : 'model', at: new Date().toISOString(), paths: [], reason: prev ? (d.planVersion && d.planVersion > 1 ? `模型修订（计划 v${d.planVersion}）` : '重新设计') : '首次设计', snapshot: { status: d.status, reason: d.reason, envelope: d.envelope } }];
  await mkdir(DRAFTS_DIR, { recursive: true });
  await writeFile(join(DRAFTS_DIR, `${d.issue.id}.json`), JSON.stringify(d, null, 2));
  return d;
}

/** Record fields carried in the draft file (issue/record.ts owns their meaning). */
type RecordCarry = { rev?: number; revs?: { rev: number; source: string; at: string; paths: string[]; reason: string; snapshot: unknown }[]; chat?: unknown[] };

/** Write a plan record as it is (issue/record.ts made rev, hash and history). */
export async function saveRecord(d: Draft, dir = DRAFTS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${d.issue.id}.json`), JSON.stringify(d, null, 2));
}

/** Warm-up gate feedback (W2-1 §6.1): runs that ended 计划不可执行 are appended to the saved draft they ran
 *  from (same content hash), so the next confirmation sheet / plan view shows them. The draft hash does not
 *  cover this field. Returns how many were written (0 when the saved draft is another version or missing). */
export async function recordWarmupFailures(issueId: string, hash: string | undefined, failures: { planId: string; at: string; detail: string }[], dir = DRAFTS_DIR): Promise<number> {
  if (!failures.length || !hash) return 0;
  const f = join(dir, `${issueId}.json`);
  if (!existsSync(f)) return 0;
  const d = JSON.parse(readFileSync(f, 'utf8')) as Draft;
  if (d.hash !== hash) return 0;
  d.warmupFailures = [...(d.warmupFailures ?? []), ...failures];
  await writeFile(f, JSON.stringify(d, null, 2));
  return failures.length;
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
