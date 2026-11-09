// Intent contracts after W3-1: a model-authored plan carries its own (author.ts#contractOf, built from
// audit.understanding). What is left here is the explicit deferral of an Issue whose precondition the black
// box cannot establish (manual override: multi-account / deferred), and the surface check of an observation.
import { OBSERVATIONS } from '../engine/observe';
import type { IssueContract } from '../platform/schema/contract';
import type { Surface } from '../platform/schema/test-plan';
import { preconditionById } from '../skills/teamily/preconditions';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import type { NormalizedIssue } from './parse';

/** Deferred Issues (second account / storage the robot cannot fill): a contract that says which
 *  precondition cannot be established, so the deferral is explicit. */
export function deferredContract(i: NormalizedIssue, kind: 'multi-account' | 'deferred', blockedBy?: string): IssueContract {
  const spec = preconditionById(blockedBy ?? (kind === 'multi-account' ? 'second-account' : 'browser-storage-full'))!;
  return {
    issueRef: i.id,
    sub: 'main',
    preconditions: [{ id: 'logged-in', text: '已登录', establish: 'executor' }, { id: spec.id, text: spec.meaning, establish: 'unconstructible' }],
    trigger: { semantics: 'unmapped', text: i.summary.slice(0, 300), params: {} },
    observable: { observation: 'unmapped', text: i.expected.slice(0, 600), phenomenon: (i.actual || i.summary).slice(0, 800) },
    provenance: { by: 'rules', skillVersion: SKILL_VERSION },
  };
}

/** Pure: can the contract's observation be used on this surface at all? */
export function observationUsable(contract: IssueContract, surface: Surface): boolean {
  const o = OBSERVATIONS[contract.observable.observation];
  return !o || o.usable.includes(surface);
}
