// Rule validation of a TestPlan against the SKILL vocabulary and platform limits (milestone 5 §A.5).
import { HARD_LIMITS, type PlannedAction, type TestPlan, TestPlanZ } from '../platform/schema/test-plan';
import { ELEMENTS, NODES, REGIONS } from '../skills/teamily/vocab';

export interface Validation {
  ok: boolean;
  errors: string[];
  plan?: TestPlan;
}

export function validatePlan(raw: unknown): Validation {
  const parsed = TestPlanZ.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const plan = parsed.data;
  const errors: string[] = [];
  const targets = new Set(plan.targets.map((t) => t.id));
  const checkAction = (a: PlannedAction, where: string) => {
    if (a.delayAfterMs > plan.limits.maxIntervalMs) errors.push(`${where}: delayAfterMs ${a.delayAfterMs} > ${plan.limits.maxIntervalMs}`);
    if (a.element) {
      if (a.element.startsWith('target.')) {
        if (!targets.has(a.element.slice(7))) errors.push(`${where}: unknown target ${a.element}`);
      } else {
        const e = ELEMENTS.find((x) => x.id === a.element);
        if (!e) errors.push(`${where}: unknown element ${a.element}`);
        else if (!e.surfaces.includes(plan.surface)) errors.push(`${where}: element ${a.element} not available on ${plan.surface}`);
      }
    }
    if (a.type === 'node') {
      const n = NODES.find((x) => x.name === a.node?.name);
      if (!n) errors.push(`${where}: unknown node ${a.node?.name ?? '(missing)'}`);
      for (const k of ['target', 'from', 'to'] as const) {
        const v = a.node?.input?.[k];
        if (typeof v === 'string' && n?.input[k] && !targets.has(v)) errors.push(`${where}: node ${n.name} references unknown target ${v}`);
      }
    }
    if (['tap', 'longPress'].includes(a.type) && !a.element) errors.push(`${where}: ${a.type} needs an element`);
    if (['type', 'key'].includes(a.type) && !a.value) errors.push(`${where}: ${a.type} needs a value`);
  };
  plan.setup.forEach((a, i) => checkAction(a, `setup[${i}]`));
  plan.actions.forEach((a, i) => checkAction(a, `actions[${i}]`));
  plan.prepare.forEach((a, i) => checkAction(a, `prepare[${i}]`));
  plan.afterCheck.forEach((a, i) => checkAction(a, `afterCheck[${i}]`));
  plan.correctPath?.forEach((a, i) => checkAction(a, `correctPath[${i}]`));
  plan.acceptance?.forEach((it) => it.actions.forEach((a, i) => checkAction(a, `acceptance.${it.id}[${i}]`)));
  for (const c of [...plan.checks, ...(plan.acceptance ?? []).map((a) => a.check)]) {
    if (c.kind === 'visual-region' && c.region?.startsWith('element:')) {
      if (!ELEMENTS.some((e) => e.id === c.region!.slice(8))) errors.push(`check: unknown element region ${c.region}`);
    } else if (c.kind === 'visual-region' && !REGIONS.some((r) => r.page === c.page && r.region === c.region)) errors.push(`check: unknown region ${c.page}/${c.region}`);
  }
  if (plan.category !== 'feature' && !plan.actions.length) errors.push('actions: empty loop');
  if (plan.category === 'feature' && !plan.acceptance?.length) errors.push('feature plan needs acceptance items');
  if (plan.limits.maxSteps > HARD_LIMITS.maxSteps || plan.limits.maxMinutes > HARD_LIMITS.maxMinutes) errors.push('limits above platform hard cap');
  const wantRule = plan.category === 'bug-always' ? 'consecutiveHits' : 'anyHit';
  if (!(wantRule in plan.verdictRule)) errors.push(`verdictRule must be ${wantRule} for ${plan.category}`);
  return { ok: !errors.length, errors, plan };
}
