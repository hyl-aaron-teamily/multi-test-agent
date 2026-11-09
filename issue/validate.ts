// Rule validation of a TestPlan against the SKILL vocabulary and platform limits (milestone 5 §A.5), and the
// W3-1 rules for model-authored plans (validateAuthored: R1 R2 R4 R5 R6 R10 R12 of plan-authoring/SKILL.md §4).
import { APP_SURFACES, type CheckPoint, EXPECT_KINDS, HARD_LIMITS, MAX_IDLE_MS, type PlannedAction, type TestPlan, TestPlanZ } from '../platform/schema/test-plan';
import { constructionAllowed, loadConversations } from '../platform/conversations';
import { POSTING_NODES } from './catalog';
import { toRegExp } from '../core/ui-tree';
import { classifyPlan } from '../platform/approval';
import { observationOf, OBSERVATIONS } from '../engine/observe';
import { NODE_SPECS } from '../skills/teamily/node-specs';
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
      // Inputs against the Node's schema (a model-composed plan once asked openPage for page "discover").
      const schema = n && NODE_SPECS.find((x) => x.name === n.name)?.schema;
      const parsed = schema?.safeParse(a.node?.input ?? {});
      if (parsed && !parsed.success) errors.push(`${where}: node ${n!.name} input ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
      // prepare-only Nodes may locate (hierarchy / vision): never in the loop or the round's restore steps.
      if (n?.phase === 'lifecycle' && plan.surface !== 'android-app') errors.push(`${where}: node ${n.name} runs on android-app only, not ${plan.surface}`);
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
  const allChecks = [...plan.checks, ...plan.baseline, ...expectsOf(plan).map((x) => x.check), ...(plan.acceptance ?? []).map((a) => a.check)];
  for (const c of allChecks) {
    const sc = c.scope;
    if (sc && typeof sc === 'object' && 'target' in sc && !targets.has(sc.target)) errors.push(`check scope: unknown target ${sc.target}`);
    if (sc && typeof sc === 'object' && 'targetBubble' in sc && !targets.has(sc.targetBubble)) errors.push(`check scope: unknown target ${sc.targetBubble}`);
  }
  // A prepare check runs before the after-prepare targets are frozen: it cannot scope to them.
  const late = new Set(plan.targets.filter((t) => t.afterPrepare).map((t) => t.id));
  for (const [i, c] of [...(plan.prepareCheck ? [plan.prepareCheck] : []), ...plan.prepareChecks].entries()) {
    const sc = c.scope;
    const ref = sc && typeof sc === 'object' ? ('target' in sc ? sc.target : 'targetBubble' in sc ? sc.targetBubble : undefined) : undefined;
    if (ref && late.has(ref)) errors.push(`prepareCheck${i ? `s[${i - 1}]` : ''}: scope target ${ref} is frozen only after prepare — use {message: <anchor text>} or the screen`);
  }
  for (const c of allChecks) {
    if (c.kind === 'visual-region' && c.region?.startsWith('element:')) {
      if (!ELEMENTS.some((e) => e.id === c.region!.slice(8))) errors.push(`check: unknown element region ${c.region}`);
    } else if (c.kind === 'visual-region' && !REGIONS.some((r) => r.page === c.page && r.region === c.region)) errors.push(`check: unknown region ${c.page}/${c.region}`);
  }
  for (const c of [...allChecks, ...(plan.prepareCheck ? [plan.prepareCheck] : []), ...plan.prepareChecks]) {
    const o = OBSERVATIONS[observationOf(c)];
    if (o && !o.usable.includes(plan.surface)) errors.push(`check ${c.kind}: observation ${observationOf(c)} has no channel on ${plan.surface}`);
    if (c.kind === 'text' && !c.match) errors.push('check text: needs match');
    if (c.match && 'regex' in c.match) {
      try {
        toRegExp(c.match.regex);
      } catch (e) {
        errors.push(`check text: regex /${c.match.regex}/ is not a valid JavaScript regex (${(e as Error).message.split('\n')[0]})`);
      }
    }
  }
  if (plan.contract) {
    const o = OBSERVATIONS[plan.contract.observable.observation];
    if (o && !o.usable.includes(plan.surface)) errors.push(`contract: observation ${plan.contract.observable.observation} cannot be observed on ${plan.surface}`);
    for (const p of plan.contract.preconditions) if (p.establish === 'construct' && !plan.prepare.length) errors.push(`contract: precondition ${p.id} must be constructed but the plan has no prepare steps`);
  }
  if (plan.sync) {
    if (new Set(plan.sync.roles).size !== plan.sync.roles.length) errors.push('sync: roles must be different surfaces');
    if (plan.sync.roles[0] !== plan.surface) errors.push('sync: surface must be the first role');
  } else if (plan.category !== 'feature' && !plan.actions.length) errors.push('actions: empty loop');
  if (plan.category === 'feature' && !plan.acceptance?.length) errors.push('feature plan needs acceptance items');
  if (plan.limits.maxSteps > HARD_LIMITS.maxSteps || plan.limits.maxMinutes > HARD_LIMITS.maxMinutes) errors.push('limits above platform hard cap');
  return { ok: !errors.length, errors, plan };
}

/** Pure: every action of a plan with its place ("actions[2]", "afterCheck[0]", …). */
export function placedActions(p: Pick<TestPlan, 'setup' | 'prepare' | 'actions' | 'afterCheck'>): { at: string; a: PlannedAction }[] {
  return (['setup', 'prepare', 'actions', 'afterCheck'] as const).flatMap((k) => (p[k] ?? []).map((a, i) => ({ at: `${k}[${i}]`, a })));
}

/** Pure: the post-conditions of a plan's actions, with their place. */
export function expectsOf(p: Pick<TestPlan, 'setup' | 'prepare' | 'actions' | 'afterCheck'>): { at: string; role: 'phenomenon' | 'precondition'; check: CheckPoint }[] {
  return placedActions(p).flatMap(({ at, a }) => (a.expect ? [{ at, role: a.expect.role, check: a.expect.check }] : []));
}

/** Pure: whitespace / quote-mark normalisation for the verbatim quote check (R12). */
export const normText = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const screenWide = (k: CheckPoint) => k.kind === 'text' && (k.scope === undefined || k.scope === 'screen');

/**
 * W3-1 rules of a model-authored plan (SKILL §4), on top of validatePlan. `issueText` = the Issue file as is.
 * R1 ids exist (validatePlan) · R2 every target has `must` · R4 the oracle sits on an action with `expect`
 * (or says why) · R5 no whole-screen text check when the plan has targets; state the round restores needs a
 * baseline · R6 every afterCheck action carries `expect` · R10 execution constraints · R12 quotes are verbatim,
 * the trace covers every target, action and check.
 */
export function validateAuthored(plan: TestPlan, issueText: string, o: { allow?: string[] } = {}): string[] {
  const errors: string[] = [];
  const a = plan.audit;
  if (!a) errors.push('R4 audit: no oracle (the plan carries no audit — quotes / understanding / oracle / trace)', 'R12 audit: no quotes and no trace');
  if (plan.provenance.generatedBy === 'rules') errors.push('provenance: rule-template plans are no longer drafted (W3-1 K1)');
  // R2
  for (const t of plan.targets) if (!t.must || !Object.values(t.must).some((v) => v !== undefined && v !== '')) errors.push(`R2 targets.${t.id}: needs must (sender / content / contains)`);
  // R4
  const ex = expectsOf(plan);
  const at = a && ex.find((x) => x.at === a.oracle.at);
  if (a && !at && !a.oracle.atReason?.trim()) errors.push(`R4 oracle.at "${a.oracle.at}" is not an action with expect (or give oracle.atReason)`);
  if (at && at.role !== 'phenomenon') errors.push(`R4 oracle.at "${a!.oracle.at}": its expect must have role phenomenon`);
  // R5 (the phenomenon's discrimination): round checks and phenomenon expects; a precondition read ("chat open",
  // "menu closed") may look at the whole screen when nothing narrower applies.
  if (plan.targets.length) for (const [i, k] of [...plan.checks.map((k, i) => [`checks[${i}]`, k] as const), ...ex.filter((x) => x.role === 'phenomenon').map((x) => [`${x.at}.expect`, x.check] as const)]) if (screenWide(k)) errors.push(`R5 ${i}: the plan has targets — scope the text check to {targetBubble} / {target} / {message}, not the whole screen`);
  if (plan.afterCheck.length && !plan.baseline.length) errors.push('R5 baseline: the round changes state that afterCheck restores — declare a baseline read before each round');
  // R6
  plan.afterCheck.forEach((x, i) => {
    if (!x.expect) errors.push(`R6 afterCheck[${i}]: a restore step needs expect (role precondition)`);
    else if (x.expect.role !== 'precondition') errors.push(`R6 afterCheck[${i}]: expect role must be precondition`);
  });
  // R10
  const allow = o.allow ?? loadConversations().construct.allow;
  for (const { at: where, a: x } of placedActions(plan)) {
    if (x.type === 'node' && POSTING_NODES.has(x.node?.name ?? '')) {
      const convs = plan.targets.filter((t) => /conversation/.test(t.kind));
      const named = convs.map((t) => conversationTitle(t.guidance)).filter((v): v is string => !!v);
      if (!named.length || !named.every((n) => constructionAllowed(n, allow))) errors.push(`R10 ${where}: ${x.node?.name} posts a message — the conversation target must be named (titled "<name>") and on the allow list`);
    }
  }
  // A baseline is a state read before the round (① only, like expect): event channels (crash …) cannot be read.
  plan.baseline.forEach((k, i) => {
    if (!(EXPECT_KINDS as readonly string[]).includes(k.kind)) errors.push(`R5 baseline[${i}]: kind ${k.kind} is not a ① state read (${EXPECT_KINDS.join(' / ')})`);
  });
  // R10 as the approval policy sees it (same function): a plan the policy refuses outright is not deliverable.
  for (const r of classifyPlan(plan, { allow }).category === 'refused' ? classifyPlan(plan, { allow }).reasons : []) errors.push(`R10 policy: ${r}`);
  // R12
  if (!a) return errors;
  const raw = normText(issueText);
  const ids = new Set(a.quotes.map((q) => q.id));
  for (const q of a.quotes) if (!raw.includes(normText(q.text))) errors.push(`R12 quotes.${q.id}: not found verbatim in the Issue ("${q.text.slice(0, 60)}")`);
  const traced = new Map(a.trace.map((t) => [t.at, t.basis]));
  const need = [...plan.targets.map((t) => `targets.${t.id}`), ...placedActions(plan).map((x) => x.at), ...plan.checks.map((_, i) => `checks[${i}]`), ...plan.baseline.map((_, i) => `baseline[${i}]`)];
  for (const n of need) if (!traced.has(n)) errors.push(`R12 trace: ${n} is not traced to a quote (or executor:<reason>)`);
  for (const [n, basis] of traced) for (const b of basis) if (!ids.has(b) && !/^executor:.+/.test(b)) errors.push(`R12 trace ${n}: basis "${b}" is neither a quote id nor executor:<reason>`);
  for (const b of a.understanding.basis) if (!ids.has(b)) errors.push(`R12 understanding.basis: unknown quote ${b}`);
  return errors;
}

/** Pure: the conversation a target's guidance names — titled "<name>" (the convention), or a quoted title
 *  after 标题为 / 名为 / 叫. undefined = not named. */
export function conversationTitle(guidance: string): string | undefined {
  return guidance.match(/titled "([^"]+)"/)?.[1] ?? guidance.match(/(?:标题为|名为|叫|名称为)\s*["“「]([^"”」]+)["”」]/)?.[1];
}
