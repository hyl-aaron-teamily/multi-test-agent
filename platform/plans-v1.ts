// Plan objects (W2-3 §6.1): id `<Issue>/<sub>:<surface>@v<draft version>`, the frozen TestPlan an approval
// binds to, its content hash, and the version facts it was approved under (SKILL / profile / App / Issue).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileKey } from '../drivers/factory';
import { canonical, DRAFTS_DIR, sha } from '../issue/drafts';
import { issuePath } from '../issue/paths';
import { applyApproval, type Draft } from '../issue/planner';
import { profilePath } from '../skills/profile';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import { CodedError } from './lifecycle/status';
import type { Surface, TestPlan } from './schema/test-plan';

export interface PlanRef {
  issue: string;
  sub: string;
  surface: Surface;
  version: number;
}

export const planIdOf = (r: PlanRef) => `${r.issue}/${r.sub}:${r.surface}@v${r.version}`;

export function parsePlanId(id: string): PlanRef {
  const m = id.match(/^([\w-]+)\/([\w]+):(android-app|android-web|mobile-web|desktop-web)@v(\d+)$/);
  if (!m) throw new CodedError('BAD_INPUT', `plan id「${id}」格式应为 <Issue>/<子用例>:<端>@v<版本>`, '用 `autotest issue show <id>` 查看计划 id');
  return { issue: m[1], sub: m[2], surface: m[3] as Surface, version: Number(m[4]) };
}

/** The saved draft of an Issue (no model call), if any. */
export function savedDraft(issue: string): Draft | undefined {
  const f = join(DRAFTS_DIR, `${issue}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Draft) : undefined;
}

/** Plan ids a draft offers: each sub-case on its default surface and on each substitution alternative. */
export function planIdsOf(d: Draft): string[] {
  const v = d.version ?? 1;
  return d.subcases.flatMap((s) => [...new Set([s.surface, ...(s.substitution?.alternatives ?? [])])].map((surface) => planIdOf({ issue: d.issue.id, sub: s.sub, surface, version: v })));
}

/** Pure: content hash of a frozen plan (confirmation time excluded). */
export function planHash(p: TestPlan): string {
  return sha(canonical({ ...p, provenance: { ...p.provenance, confirmedAt: undefined } }));
}

export interface ResolvedPlan {
  id: string;
  ref: PlanRef;
  draft: Draft;
  plan: TestPlan;
  hash: string;
}

/** Plan id → the frozen plan of the current draft. Unknown → 41; another draft version → 32. */
export function resolvePlan(id: string): ResolvedPlan {
  const ref = parsePlanId(id);
  const d = savedDraft(ref.issue);
  if (!d) throw new CodedError('NOT_FOUND', `Issue ${ref.issue} 还没有草稿`, `先执行 autotest draft create ${ref.issue}`);
  if ((d.version ?? 1) !== ref.version) throw new CodedError('PLAN_STALE', `计划 ${id} 已被草稿 v${d.version ?? 1} 取代`, `用 ${planIdOf({ ...ref, version: d.version ?? 1 })}`);
  if (d.status !== 'plannable') throw new CodedError('PLAN_NOT_EXECUTABLE', `Issue ${ref.issue} 的草稿状态为 ${d.status}：${d.reason}`);
  const sc = d.subcases.find((s) => s.sub === ref.sub);
  if (!sc) throw new CodedError('NOT_FOUND', `草稿里没有子用例 ${ref.sub}`, `可选：${d.subcases.map((s) => s.sub).join(', ')}`);
  const allowed = [sc.surface, ...(sc.substitution?.alternatives ?? [])];
  if (!allowed.includes(ref.surface)) throw new CodedError('NOT_FOUND', `子用例 ${ref.sub} 不能在 ${ref.surface} 上执行`, `可选：${allowed.join(', ')}`);
  const plan = applyApproval(d, [{ sub: ref.sub, surface: ref.surface }])[0];
  return { id, ref, draft: d, plan, hash: planHash(plan) };
}

/** What an approval is bound to besides the plan hash (§5.1): any change after approval → 32. */
export interface VersionFacts {
  skillVersion: string;
  profileHash?: string;
  appVersion?: string;
  issueHash?: string;
}

export function versionFacts(p: Pick<TestPlan, 'surface' | 'env' | 'issueRef'>, udid?: string, appVersion?: string): VersionFacts {
  const pf = profilePath(profileKey(p.surface, p.env, udid));
  const issueF = issuePath(p.issueRef);
  return { skillVersion: SKILL_VERSION, profileHash: existsSync(pf) ? sha(readFileSync(pf, 'utf8')) : undefined, appVersion, issueHash: existsSync(issueF) ? sha(readFileSync(issueF, 'utf8')) : undefined };
}

/** Pure: which bound facts changed (empty = still valid). An unknown current value is not a change. */
export function staleFacts(bound: VersionFacts, now: VersionFacts): string[] {
  return (Object.keys(bound) as (keyof VersionFacts)[]).filter((k) => bound[k] !== undefined && now[k] !== undefined && bound[k] !== now[k]).map((k) => `${k}: ${bound[k]} → ${now[k]}`);
}
