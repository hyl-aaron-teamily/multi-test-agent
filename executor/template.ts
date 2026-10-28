// Run token and round placeholders (W2-2 §4.3 isolation): plans write `{token}` / `{round}` into typed text,
// node inputs, round preconditions and check matches; the executor substitutes them per run / round, so
// "the newest message" and text checks only ever match what this run (and this round) produced.
import { randomBytes } from 'node:crypto';
import type { CheckPoint, PlannedAction } from '../platform/schema/test-plan';

export interface TemplateVars {
  token: string;
  round: number;
}

/** A fresh run token: "r" + 6 hex digits (e.g. r3fa9c1). */
export const newRunToken = () => `r${randomBytes(3).toString('hex')}`;

/** Pure: substitute {token} / {round} in a string. */
export const expand = (s: string, v: TemplateVars) => s.replace(/\{token\}/g, v.token).replace(/\{round\}/g, String(v.round));

const expandDeep = (x: unknown, v: TemplateVars): unknown => {
  if (typeof x === 'string') return expand(x, v);
  if (Array.isArray(x)) return x.map((y) => expandDeep(y, v));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, expandDeep(y, v)]));
  return x;
};

/** Pure: the action with its text, node input and precondition expanded (element ids are left alone). */
export function expandAction(a: PlannedAction, v: TemplateVars): PlannedAction {
  return { ...a, value: a.value === undefined ? undefined : expand(a.value, v), node: a.node && { ...a.node, input: expandDeep(a.node.input, v) as Record<string, unknown> }, requires: a.requires && (expandDeep(a.requires, v) as PlannedAction['requires']) };
}

/** Pure: the check with its match, message anchor and precondition expanded. */
export function expandCheck(k: CheckPoint, v: TemplateVars): CheckPoint {
  return { ...k, match: k.match && (expandDeep(k.match, v) as CheckPoint['match']), scope: k.scope && (expandDeep(k.scope, v) as CheckPoint['scope']), requires: k.requires && (expandDeep(k.requires, v) as CheckPoint['requires']) };
}
