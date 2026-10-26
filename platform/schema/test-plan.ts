// TestPlan: the single intermediate representation between an Issue and the executor (milestone 5 §A.4).
// Plans reference SKILL element ids and Nodes only — never coordinates; the executor resolves ids through
// the profile of its surface. The JSON Schema export is what the LLM gets as structured-output contract.
import { z } from 'zod';
import { IssueContractZ } from './contract';

/** The single definition of execution surfaces (platform/accounts/types re-exports it). */
export const SURFACES = ['android-app', 'android-web', 'mobile-web', 'desktop-web'] as const;
export const SurfaceZ = z.enum(SURFACES);
export const CategoryZ = z.enum(['bug-always', 'bug-intermittent', 'feature', 'suspected-misuse']);
export const PreCategoryZ = z.enum([...CategoryZ.options, 'server-side', 'multi-account', 'deferred', 'not-executable']);

export const PlannedActionZ = z.object({
  /** Lifecycle: exitApp = Home (app stays in the background); killApp = kill its process (verified gone);
   *  reload = page reload (web) / kill + launch (app); idle = no input for `value` ms (≤ 10 min, e.g. while
   *  the app sits in the background); launch after killApp = cold start. Lifecycle ops are not counted
   *  as action intervals and planned exits are never hits. */
  type: z.enum(['tap', 'longPress', 'type', 'key', 'swipe', 'scroll', 'back', 'wait', 'launch', 'node', 'exitApp', 'killApp', 'reload', 'idle']),
  node: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).default({}) }).optional(),
  element: z.string().optional(),
  /** type: text; key: key name; swipe/scroll: 'up' | 'down' | 'left' | 'right'; wait: ms (≤ 1000); idle: ms (≤ 600000). */
  value: z.string().optional(),
  delayAfterMs: z.number().int().min(0).max(1000).default(300),
});

export const CheckPointZ = z.object({
  /** keyboard: soft keyboard shown (Android system state); text: a text on screen (accessibility / page text). */
  kind: z.enum(['visual-region', 'crash', 'process-alive', 'console-error', 'page-error', 'ai', 'baseline', 'keyboard', 'text']),
  page: z.string().optional(),
  region: z.string().optional(),
  expect: z.string(),
  /** visual-region: the reference state that counts as "as expected" ('present' = matches the ref, 'absent' = differs). */
  want: z.enum(['present', 'absent']).default('present'),
  onlyOnAnomaly: z.boolean().optional(),
  /** text: what to find (exact text, substring or regex). */
  match: z.union([z.object({ exact: z.string() }), z.object({ contains: z.string() }), z.object({ regex: z.string() })]).optional(),
  /** text: where — whole screen (default), the quote cards, or near a frozen target (± px vertically). */
  scope: z.union([z.literal('screen'), z.literal('quote-cards'), z.object({ target: z.string(), within: z.number().default(250) })]).optional(),
});

export const LimitsZ = z.object({
  maxSteps: z.number().int().min(1).max(3000),
  maxMinutes: z.number().min(1).max(120),
  maxIntervalMs: z.literal(1000),
});

export const VerdictRuleZ = z.union([z.object({ consecutiveHits: z.literal(3) }), z.object({ anyHit: z.literal(true) })]);

/** Feature acceptance: one item per Expected/AC line; each is a check run once. */
export const AcceptanceItemZ = z.object({ id: z.string(), text: z.string(), actions: z.array(PlannedActionZ), check: CheckPointZ });

export const TestPlanZ = z.object({
  id: z.string(),
  issueRef: z.string(),
  title: z.string(),
  category: CategoryZ,
  surface: SurfaceZ,
  issueSurfaces: z.array(z.string()),
  substitution: z.object({ from: z.string(), to: SurfaceZ, reason: z.string() }).optional(),
  env: z.enum(['test', 'prod']),
  account: z.string().optional(),
  launch: z.enum(['once', 'each-iteration']).default('once'),
  /** Dynamic targets (which group / message): picked by the model at preparation time, then frozen to coordinates. */
  targets: z.array(z.object({ id: z.string(), kind: z.string(), guidance: z.string(), afterPrepare: z.boolean().optional() })).default([]),
  setup: z.array(PlannedActionZ),
  /** Builds a precondition through the UI after the in-conversation targets are frozen (e.g. send a reply);
   *  targets marked afterPrepare are located after it. Runs once. */
  prepare: z.array(PlannedActionZ).default([]),
  /** Must hold after prepare (the precondition really exists); otherwise the run is 执行失败, never a hit. */
  prepareCheck: CheckPointZ.optional(),
  actions: z.array(PlannedActionZ),
  checks: z.array(CheckPointZ),
  /** Run after each round's checkpoint: restore state the round changed (e.g. remove the like just added). */
  afterCheck: z.array(PlannedActionZ).default([]),
  acceptance: z.array(AcceptanceItemZ).optional(),
  /** suspected-misuse: the correct path, run first. */
  correctPath: z.array(PlannedActionZ).optional(),
  limits: LimitsZ,
  verdictRule: VerdictRuleZ,
  /** Intent contract the plan was compiled from (W2-1 §5). */
  contract: IssueContractZ.optional(),
  /** Do the plan's checks observe the contract's postcondition? 'not-covered' = generic fallback (report note). */
  coverage: z.enum(['covered', 'not-covered']).optional(),
  provenance: z.object({ generatedBy: z.enum(['model', 'rules', 'manual']), skillVersion: z.string(), confirmedAt: z.string().optional(), draftHash: z.string().optional(), pattern: z.string().optional() }),
});

export type Surface = z.infer<typeof SurfaceZ>;
export type Category = z.infer<typeof CategoryZ>;
export type PreCategory = z.infer<typeof PreCategoryZ>;
export type PlannedAction = z.infer<typeof PlannedActionZ>;
export type CheckPoint = z.infer<typeof CheckPointZ>;
export type TestPlan = z.infer<typeof TestPlanZ>;
export type AcceptanceItem = z.infer<typeof AcceptanceItemZ>;

export const DEFAULT_LIMITS = { maxSteps: 1000, maxMinutes: 15, maxIntervalMs: 1000 as const };
export const HARD_LIMITS = { maxSteps: 3000, maxMinutes: 120 };
export const MAX_IDLE_MS = 600_000;
/** Surfaces with an app process the user can leave / kill (exitApp, killApp). */
export const APP_SURFACES: string[] = ['android-app', 'android-web'];
/** Ops that are not user input pacing: excluded from the ≤ 1 s action-interval statistic. */
export const LIFECYCLE_OPS = new Set(['launch', 'exitApp', 'killApp', 'reload', 'idle', 'focus']);

export function verdictRuleFor(c: Category): TestPlan['verdictRule'] {
  return c === 'bug-always' ? { consecutiveHits: 3 } : { anyHit: true };
}

export function testPlanJsonSchema(): unknown {
  return z.toJSONSchema(TestPlanZ, { io: 'input' });
}
