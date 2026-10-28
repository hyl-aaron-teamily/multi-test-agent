// Rule validation of a TestPlan against the SKILL vocabulary and platform limits (milestone 5 §A.5).
import { APP_SURFACES, HARD_LIMITS, MAX_IDLE_MS, type PlannedAction, type TestPlan, TestPlanZ } from '../platform/schema/test-plan';
import { observationOf, OBSERVATIONS } from '../executor/observe';
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
  // Targets: declared ones, and those a prepare-only Node freezes (teamily.freezeMention → input.as).
  const targets = new Set([...plan.targets.map((t) => t.id), ...plan.prepare.filter((a) => a.node?.name === 'teamily.freezeMention').map((a) => String(a.node?.input?.as ?? ''))]);
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
      // prepare-only Nodes may locate (hierarchy / vision): never in the loop or the round's restore steps.
      if (n?.phase === 'prepare-only' && !where.startsWith('prepare')) errors.push(`${where}: node ${n.name} is prepare-only (it locates on screen; the loop is coordinates only)`);
      for (const k of ['target', 'from', 'to'] as const) {
        const v = a.node?.input?.[k];
        if (typeof v === 'string' && n?.input[k] && !targets.has(v)) errors.push(`${where}: node ${n.name} references unknown target ${v}`);
      }
    }
    if (['tap', 'longPress'].includes(a.type) && !a.element) errors.push(`${where}: ${a.type} needs an element`);
    if (a.type === 'require' && !a.requires) errors.push(`${where}: require needs requires`);
    if (a.type === 'require' && !where.startsWith('actions')) errors.push(`${where}: require is a round precondition (loop actions only)`);
    if (['type', 'key'].includes(a.type) && !a.value) errors.push(`${where}: ${a.type} needs a value`);
    if (['exitApp', 'killApp'].includes(a.type) && !APP_SURFACES.includes(plan.surface)) errors.push(`${where}: ${a.type} needs an app surface (${APP_SURFACES.join(' / ')}), not ${plan.surface}`);
    if (a.type === 'idle' && !(Number(a.value) > 0 && Number(a.value) <= MAX_IDLE_MS)) errors.push(`${where}: idle needs a value in ms (1..${MAX_IDLE_MS})`);
    if (a.type === 'wait' && Number(a.value ?? 0) > 1000) errors.push(`${where}: wait ≤ 1000 ms (use idle for longer pauses)`);
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
  for (const c of [...plan.checks, ...(plan.prepareCheck ? [plan.prepareCheck] : []), ...(plan.acceptance ?? []).map((a) => a.check)]) {
    const o = OBSERVATIONS[observationOf(c)];
    if (o && !o.usable.includes(plan.surface)) errors.push(`check ${c.kind}: observation ${observationOf(c)} has no channel on ${plan.surface}`);
    if (c.kind === 'text' && !c.match) errors.push('check text: needs match');
  }
  if (plan.contract) {
    const o = OBSERVATIONS[plan.contract.observable.observation];
    if (o && !o.usable.includes(plan.surface)) errors.push(`contract: observation ${plan.contract.observable.observation} cannot be observed on ${plan.surface}`);
    for (const p of plan.contract.preconditions) if (p.establish === 'construct' && !plan.prepare.length) errors.push(`contract: precondition ${p.id} must be constructed but the plan has no prepare steps`);
  }
  if (plan.category !== 'feature' && !plan.actions.length) errors.push('actions: empty loop');
  if (plan.category === 'feature' && !plan.acceptance?.length) errors.push('feature plan needs acceptance items');
  if (plan.limits.maxSteps > HARD_LIMITS.maxSteps || plan.limits.maxMinutes > HARD_LIMITS.maxMinutes) errors.push('limits above platform hard cap');
  const wantRule = plan.category === 'bug-always' ? 'consecutiveHits' : 'anyHit';
  if (!(wantRule in plan.verdictRule)) errors.push(`verdictRule must be ${wantRule} for ${plan.category}`);
  return { ok: !errors.length, errors, plan };
}
