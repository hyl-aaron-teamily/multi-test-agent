// Issue → intent contract (stage 1, understanding) and contract → plan coverage (W2-1 §5.3).
// Rules give the strong signals (the trigger pattern a sub-case text selects, crash words); the LLM fills a
// contract only where no specific pattern applies, and may only use library ids (or 'unmapped').
// suspectedMechanism is a guess: shown in the confirmation, never executed or judged.
import { chatJson, modelConfigured } from '../core/model/llm';
import { observationOf, OBSERVATIONS } from '../executor/observe';
import { loadConversations } from '../platform/conversations';
import { type IssueContract, IssueContractZ } from '../platform/schema/contract';
import type { Category, Surface, TestPlan } from '../platform/schema/test-plan';
import { GENERIC_PATTERN, PATTERNS, patternById, patternForText } from '../skills/teamily/patterns';
import { PRECONDITIONS, preconditionById } from '../skills/teamily/preconditions';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import type { NormalizedIssue } from './parse';

const CRASH_WORDS = /crash|闪退|崩溃|anr|not responding|无响应|白屏|freez|卡死/i;

/** Default params a pattern needs from the environment (allow-listed conversation for constructions). */
export function patternParams(patternId: string): Record<string, unknown> {
  if (patternById(patternId)?.needs.some((n) => preconditionById(n)?.establish === 'construct')) return { conversation: loadConversations().construct.allow[0] ?? '' };
  return {};
}

/** Pure (apart from the allow list): rule contract of a (sub-)case. */
export function rulesContract(i: NormalizedIssue, sub: string, text: string, category: Category): IssueContract {
  const p = patternForText(text, category);
  const specific = p.id !== GENERIC_PATTERN;
  const pre = [{ id: 'logged-in', text: '已登录', establish: 'executor' as const }];
  for (const n of specific ? p.needs : []) {
    const spec = preconditionById(n);
    if (spec) pre.push({ id: spec.id, text: spec.meaning, establish: spec.establish as any });
  }
  const observation = specific ? p.observation : CRASH_WORDS.test(`${i.summary} ${i.actual}`) ? 'crash' : 'unmapped';
  return {
    issueRef: i.id,
    sub,
    preconditions: pre,
    trigger: { semantics: specific ? p.trigger : 'unmapped', text: text.slice(0, 300), pattern: specific ? p.id : undefined, params: specific ? patternParams(p.id) : {} },
    observable: { observation, text: i.expected.slice(0, 600), phenomenon: (i.actual || i.summary).slice(0, 800) },
    provenance: { by: 'rules', skillVersion: SKILL_VERSION },
  };
}

const CONTRACT_SYSTEM = () => `You turn a bug report into an intent CONTRACT for a black-box UI test robot of the Teamily IM app.
Separate the phenomenon from guesses. Reply ONE JSON object:
{"preconditions":[{"id":"<precondition id or unmapped>","text":"<as the issue states it>","establish":"executor|existing-data|construct|unconstructible"}],
 "trigger":{"semantics":"<trigger id or unmapped>","text":"<what is done, how often>","pattern":"<pattern id or omit>","params":{}},
 "observable":{"observation":"<observation id or unmapped>","text":"<expected normal behaviour>","phenomenon":"<the abnormal phenomenon as reported>"},
 "suspectedMechanism":"<optional guess, may be empty>"}
Use ONLY these ids.
Preconditions: ${PRECONDITIONS.map((p) => `${p.id} (${p.meaning}; ${p.establish})`).join('; ')}.
Patterns (trigger → observation): ${PATTERNS.filter((p) => p.id !== GENERIC_PATTERN).map((p) => `${p.id}: trigger ${p.trigger}, observes ${p.observation}, needs ${p.needs.join('+') || '-'}`).join('; ')}.
Observations: ${Object.entries(OBSERVATIONS).map(([k, v]) => `${k} (${v.meaning})`).join('; ')}.
If no pattern fits, omit "pattern" and use trigger semantics "unmapped". Never invent ids.`;

/** Stage 1 by the model (validated: unknown ids become 'unmapped', unknown patterns are dropped). */
export async function modelContract(i: NormalizedIssue, sub: string, text: string, category: Category): Promise<IssueContract | undefined> {
  if (!modelConfigured()) return undefined;
  const ans = (await chatJson(CONTRACT_SYSTEM(), `Category: ${category}\nIssue ${i.id} (${sub}): ${text}\nSteps:\n${i.steps.join('\n')}\nExpected: ${i.expected.slice(0, 1500)}\nActual: ${i.actual.slice(0, 1500)}`)) as Partial<IssueContract> | undefined;
  if (!ans || typeof ans !== 'object') return undefined;
  const pre = (ans.preconditions ?? []).map((p) => {
    const spec = preconditionById(String(p?.id));
    return { id: spec ? spec.id : 'unmapped', text: String(p?.text ?? ''), establish: spec ? spec.establish : (['executor', 'existing-data', 'construct', 'unconstructible'].includes(String(p?.establish)) ? p!.establish : 'unconstructible') };
  });
  const pat = ans.trigger?.pattern && patternById(String(ans.trigger.pattern));
  const usable = pat && pat.id !== GENERIC_PATTERN && pat.categories.includes(category) ? pat : undefined;
  const obs = String(ans.observable?.observation ?? '');
  const c = IssueContractZ.safeParse({
    issueRef: i.id,
    sub,
    preconditions: pre.length ? pre : [{ id: 'logged-in', text: '已登录', establish: 'executor' }],
    trigger: { semantics: usable ? usable.trigger : String(ans.trigger?.semantics ?? 'unmapped').slice(0, 60), text: String(ans.trigger?.text ?? text).slice(0, 300), pattern: usable?.id, params: usable ? patternParams(usable.id) : {} },
    observable: { observation: usable ? usable.observation : OBSERVATIONS[obs] ? obs : 'unmapped', text: String(ans.observable?.text ?? i.expected).slice(0, 600), phenomenon: String(ans.observable?.phenomenon ?? i.actual).slice(0, 800) },
    suspectedMechanism: ans.suspectedMechanism ? String(ans.suspectedMechanism).slice(0, 300) : undefined,
    provenance: { by: 'model', skillVersion: SKILL_VERSION, model: process.env.ISSUE_PLANNER_MODEL ?? process.env.MIDSCENE_MODEL_NAME },
  });
  return c.success ? c.data : undefined;
}

/** Stage 1: rules where a specific pattern applies (validated on devices), the model otherwise, rules as fallback. */
export async function contractFor(i: NormalizedIssue, sub: string, text: string, category: Category, useModel = true): Promise<IssueContract> {
  const rc = rulesContract(i, sub, text, category);
  if (rc.trigger.pattern || !useModel) return rc;
  return (await modelContract(i, sub, text, category)) ?? rc;
}

/** Pure: does the plan observe the contract's postcondition? */
export function coverageOf(plan: Pick<TestPlan, 'checks' | 'acceptance'>, contract: IssueContract): 'covered' | 'not-covered' {
  const want = contract.observable.observation;
  if (want === 'unmapped') return 'not-covered';
  const have = new Set([...plan.checks, ...(plan.acceptance ?? []).map((a) => a.check)].map(observationOf));
  if (want === 'region' && have.has('element')) return 'covered';
  return have.has(want) ? 'covered' : 'not-covered';
}

/** Pure: can the contract's observation be used on this surface at all? */
export function observationUsable(contract: IssueContract, surface: Surface): boolean {
  const o = OBSERVATIONS[contract.observable.observation];
  return !o || o.usable.includes(surface);
}
