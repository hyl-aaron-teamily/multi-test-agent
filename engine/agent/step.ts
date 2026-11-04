// Exploration tier: what the model sees each step and what it may answer (after ref/artemis Flash: screenshot +
// numbered visible elements, tap by index first, coordinates only with a target description; Apache-2.0,
// rewritten). Pure: prompt building, answer parsing, history compression, screen fingerprints.
import { createHash } from 'node:crypto';
import { label, type ScreenNode } from '../../core/screen-index';

export type AgentAction =
  | { type: 'tap'; target?: number; x?: number; y?: number; description?: string }
  | { type: 'longPress'; target?: number; x?: number; y?: number; description?: string }
  | { type: 'type'; target?: number; text: string; clear?: boolean }
  | { type: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'back' }
  | { type: 'launch' }
  | { type: 'wait'; ms: number }
  | { type: 'done'; status: 'completed' | 'failed'; summary: string }
  | { type: 'report_issue'; description: string }
  // Bench mode only (AndroidWorld, W2-5 P1): open an app by name, hand in an answer, Home, Enter.
  | { type: 'open_app'; app: string }
  | { type: 'answer'; text: string }
  | { type: 'home' }
  | { type: 'enter' };

export interface AgentAnswer {
  thought: string;
  /** Markdown checklist ([ ] / [/] / [x] / [!]); the model keeps it current. */
  plan?: string;
  action: AgentAction;
  /** A short burst on the same screen after `action` (Artemis Flash click_sequence): at most BURST_MAX - 1. */
  then?: AgentAction[];
}

/** Actions per turn at most (the first plus the burst). */
export const BURST_MAX = 4;
/** Actions that may be part of a burst (the others end a turn on their own). */
const BURSTABLE = new Set(['tap', 'longPress', 'type', 'swipe', 'drag', 'back', 'enter', 'wait']);

export interface StepRecord {
  step: number;
  screen: string;
  action: string;
  result: string;
  /** The model's reasoning for this step (shortened). */
  thought?: string;
  /** Thumbnail of the screen the step acted on, relative to the run dir (steps/<n>.png). */
  thumb?: string;
}

/** Elements shown to the model: labelled or clickable, at most `max`, numbered from 1. */
export function visibleElements(nodes: ScreenNode[], max = 80): ScreenNode[] {
  return nodes.filter((n) => label(n) || n.clickable).slice(0, max);
}

const INPUT = /EditText|textbox|textarea|searchbox|combobox/i;

/** Pure: the numbered element list. Inputs are called inputs (with their placeholder); an element without text
 *  shows the tail of its resource id, so unlabelled fields and icons can still be told apart. */
export function elementList(els: ScreenNode[]): string {
  return els
    .map((n, i) => {
      const kind = INPUT.test(n.cls) ? 'input' : n.clickable ? 'button' : n.cls.replace(/^android\.widget\./, '');
      const extra = [n.hint ? `hint "${n.hint.slice(0, 40)}"` : '', !label(n) && n.rid && !/^(button|link|textbox|listitem|img|generic)$/.test(n.rid) ? `id "${n.rid.split('/').pop()!.slice(0, 40)}"` : ''].filter(Boolean).join(' ');
      return `[${i + 1}] ${kind} "${label(n).slice(0, 60)}"${extra ? ` ${extra}` : ''} @(${n.center.x},${n.center.y})`;
    })
    .join('\n');
}

/** Pure: a screen's fingerprint — its labels, ignoring counts and times that change while it stays the same screen. */
export function fingerprint(nodes: ScreenNode[]): string {
  const ls = [...new Set(nodes.map((n) => label(n).replace(/\d+/g, '#').slice(0, 30)).filter(Boolean))].sort().slice(0, 60);
  return createHash('sha1').update(ls.join('|')).digest('hex').slice(0, 10);
}

export const KEEP_STEPS = 12;

/** Pure: history for the prompt — the last KEEP_STEPS steps verbatim, older ones as one line per chunk of 12. */
export function historyText(steps: StepRecord[]): string {
  if (!steps.length) return '(none yet)';
  const recent = steps.slice(-KEEP_STEPS);
  const old = steps.slice(0, -KEEP_STEPS);
  const chunks: string[] = [];
  for (let i = 0; i < old.length; i += KEEP_STEPS) {
    const c = old.slice(i, i + KEEP_STEPS);
    const screens = new Set(c.map((s) => s.screen)).size;
    const issues = c.filter((s) => /issue|blocked|error/i.test(s.result)).map((s) => `#${s.step} ${s.result.slice(0, 60)}`);
    chunks.push(`steps ${c[0].step}–${c.at(-1)!.step}: ${screens} screen(s); ${c.map((s) => s.action.split(' ')[0]).join(', ')}${issues.length ? `; notable: ${issues.join('; ')}` : ''}`);
  }
  return [...chunks.map((c) => `(summary) ${c}`), ...recent.map((s) => `#${s.step} [screen ${s.screen}] ${s.action} → ${s.result}`)].join('\n');
}

/** Pure: the last steps repeat one (screen, action) pair, or alternate two of them → a hint for the model
 *  (a 2026-11-03 desktop run spent 11 steps opening and closing the same side panel). */
export function loopHint(steps: StepRecord[]): string | undefined {
  // The same action on the same screen three times (scrolling on through new screens is fine) …
  const ks = (s: StepRecord) => `${s.screen} ${s.action}`;
  const t = steps.slice(-4);
  if (t.length < 3) return undefined;
  const same = t.slice(-3).every((s) => ks(s) === ks(t.at(-1)!));
  // … or a cycle by actions only: the screen fingerprint changes with typed text, a loop through a dialog repeats anyway.
  const k = (s: StepRecord) => s.action;
  // A cycle of 2–4 steps run twice in a row (2026-11-03: type → rewrite → confirm → clear, again and again).
  let cycle = 0;
  for (let n = 2; n <= 4 && !cycle; n++) {
    const w = steps.slice(-2 * n);
    if (w.length === 2 * n && w.slice(0, n).every((s, i) => k(s) === k(w[n + i])) && new Set(w.slice(0, n).map(k)).size > 1) cycle = n;
  }
  if (!same && !cycle) return undefined;
  const acts = [...new Set((same ? t.slice(-3) : steps.slice(-cycle)).map((s) => s.action))].join(' / ');
  return `LOOP: the last ${same ? 3 : 2 * cycle} steps repeated ${acts}. Do not repeat it: if what you came for is already on the screen, finish with done; otherwise choose another element or area, scroll, go back, or end with done(failed).`;
}

export const SYSTEM = (writable: boolean, ownContent: string[] = []) => `You test the Teamily app like a careful human tester, one action per turn, on a real ${'device or browser'}.
Each turn you get: the goal, your current plan, the history, the screenshot and the numbered visible elements.
Answer ONE JSON object: {"thought": "<short>", "plan": "<markdown checklist: - [ ] todo / - [/] doing / - [x] done / - [!] failed>", "action": {...}}.
Actions:
- {"type":"tap","target":<element number>}  (preferred)
- {"type":"tap","x":<px>,"y":<px>,"description":"<what is there>"}  (only for something not in the list; coordinates in the element list's space)
- {"type":"longPress","target":<n>}
- {"type":"type","target":<n>,"text":"...","clear":true|false}  (focuses the field itself — no tap before it; clear = replace what is there)
- {"type":"swipe","direction":"up|down|left|right"} | {"type":"drag","x1":..,"y1":..,"x2":..,"y2":..}  (drag: sliders, pickers)
- {"type":"back"} | {"type":"launch"} | {"type":"wait","ms":<=3000}
- {"type":"report_issue","description":"<what you see that is wrong, as visible facts>"}  (an error, a crash dialog, a blank or stuck page, broken text — something that stops normal use)
- {"type":"done","status":"completed|failed","summary":"..."}  (goal reached, or impossible)
Several steps on the same screen (fill a form, type then press Enter): add "then": [up to 3 more actions of the kinds tap / longPress / type / swipe / drag / back / enter / wait]; they run in order and stop at the first one that does not go through.
Rules: look before you act; do not assume where a tap leads; describe visible facts, never guess causes.
${writable ? 'Writable run: you may type and send, but never delete or recall anything.' : 'READ-ONLY run: never send, delete, change settings, pay, log out, invite or share, or edit a profile; typing is allowed only into a search box. Such actions are blocked and reported back to you.'}
Likes, follows, favourites and subscriptions change what real users see: do them only on the test accounts' own profiles and content (${ownContent.length ? ownContent.map((n) => `"${n}"`).join(', ') : 'none configured'}); elsewhere they are blocked. Tabs with those names on other people's pages are blocked too — check them on the own profiles.
When exploring, prefer entries you have not tried on this screen yet.`;

/** Bench mode (AndroidWorld on an emulator): complete the task; nothing is blocked, nothing is reported. */
export const BENCH_SYSTEM = `You operate an Android phone to complete the user's task, one action per turn, like a careful human.
Each turn you get: the task, your current plan, the history, the screenshot and the numbered visible elements.
Answer ONE JSON object: {"thought": "<short>", "plan": "<markdown checklist: - [ ] todo / - [/] doing / - [x] done / - [!] failed>", "action": {...}}.
Actions:
- {"type":"tap","target":<element number>}  (preferred)
- {"type":"tap","x":<px>,"y":<px>,"description":"<what is there>"}  (only for something not in the list; coordinates in the element list's space)
- {"type":"longPress","target":<n>}
- {"type":"type","target":<n>,"text":"...","clear":true|false}  (focuses the field itself — do not tap it first; clear = replace what is there)
- {"type":"swipe","direction":"up|down|left|right"} | {"type":"drag","x1":..,"y1":..,"x2":..,"y2":..}  (drag: sliders, pickers, seek bars)
- {"type":"open_app","app":"<app name, e.g. Contacts, Clock, Markor>"}
- {"type":"back"} | {"type":"home"} | {"type":"enter"} | {"type":"wait","ms":<=3000}
- {"type":"answer","text":"..."}  (the task asks a question: give the answer, then finish with done)
- {"type":"done","status":"completed|failed","summary":"..."}  (the task is done, or it cannot be done)
Several steps on the same screen (fill a form, type then press Enter, set a picker): add "then": [up to 3 more actions of the kinds tap / longPress / type / swipe / drag / back / enter / wait]; they run in order and stop at the first one that does not go through. Turns are limited: batch what you can see.
Rules: look before you act; do not assume where a tap leads; check on the screen that each step took effect before moving on — never repeat an action whose effect you have not looked at (a second press of a button that already worked does it twice); read back the values the app shows after you enter them (names, numbers, dates, times) and correct them before moving on; to set a slider to its maximum or minimum, drag its thumb past the end of the track; finish with done as soon as the task is complete.`;

export function userPrompt(o: { goal: string; mode: 'task' | 'explore'; plan?: string; history: string; screen: string; els: ScreenNode[]; tried: string[]; feedback?: string; size: { width: number; height: number }; instructions?: string[] }): string {
  return [
    `Goal (${o.mode === 'explore' ? 'explore and find problems' : 'task'}): ${o.goal}`,
    o.instructions?.length ? `Instructions the user added during the run (follow them; the latest wins where they conflict; the safety rules still apply):\n${o.instructions.map((t) => `- ${t}`).join('\n')}` : '',
    `Current plan:\n${o.plan ?? '(write one)'}`,
    `History:\n${o.history}`,
    o.feedback ? `Result of your last action: ${o.feedback}` : '',
    `Screen ${o.screen} (${o.size.width}×${o.size.height}); already tried here: ${o.tried.length ? o.tried.slice(0, 20).join(', ') : 'nothing'}`,
    `Visible elements:\n${elementList(o.els) || '(none read — use coordinates from the screenshot)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Pure: validate the model's answer; undefined = unusable (the turn is retried once, then ends as failed). */
export function parseAnswer(raw: unknown, bench = false): AgentAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { thought?: unknown; plan?: unknown; action?: Record<string, unknown>; then?: unknown };
  const action = r.action && parseAction(r.action, bench);
  if (!action) return undefined;
  const rest = Array.isArray(r.then) && BURSTABLE.has(action.type) ? r.then.slice(0, BURST_MAX - 1).map((x) => (x && typeof x === 'object' ? parseAction(x as Record<string, unknown>, bench) : undefined)) : [];
  // A burst holds only burstable actions; anything else ends it.
  const then: AgentAction[] = [];
  for (const x of rest) {
    if (!x || !BURSTABLE.has(x.type)) break;
    then.push(x);
  }
  return { thought: String(r.thought ?? ''), plan: typeof r.plan === 'string' ? r.plan : undefined, action, ...(then.length ? { then } : {}) };
}

/** Pure: one action of the answer; undefined = unusable. */
export function parseAction(a: Record<string, unknown>, bench = false): AgentAction | undefined {
  if (typeof a.type !== 'string') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
  let action: AgentAction | undefined;
  switch (a.type) {
    case 'tap':
    case 'longPress': {
      const target = num(a.target);
      const x = num(a.x);
      const y = num(a.y);
      if (target === undefined && (x === undefined || y === undefined)) return undefined;
      action = { type: a.type, target, x, y, description: typeof a.description === 'string' ? a.description : undefined };
      break;
    }
    case 'type':
      if (typeof a.text !== 'string') return undefined;
      action = { type: 'type', target: num(a.target), text: a.text, ...(a.clear === true ? { clear: true } : {}) };
      break;
    case 'drag': {
      const [x1, y1, x2, y2] = [num(a.x1), num(a.y1), num(a.x2), num(a.y2)];
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
      action = { type: 'drag', x1, y1, x2, y2 };
      break;
    }
    case 'swipe':
      action = { type: 'swipe', direction: (['up', 'down', 'left', 'right'] as const).find((d) => d === a.direction) ?? 'up' };
      break;
    case 'back':
      action = { type: 'back' };
      break;
    case 'launch':
      if (bench) return undefined;
      action = { type: 'launch' };
      break;
    case 'home':
    case 'enter':
      if (!bench) return undefined;
      action = { type: a.type };
      break;
    case 'open_app':
      if (!bench || typeof a.app !== 'string' || !a.app.trim()) return undefined;
      action = { type: 'open_app', app: a.app.trim() };
      break;
    case 'answer':
      if (!bench || typeof a.text !== 'string') return undefined;
      action = { type: 'answer', text: a.text };
      break;
    case 'wait':
      action = { type: 'wait', ms: Math.min(3000, num(a.ms) ?? 1000) };
      break;
    case 'done':
      action = { type: 'done', status: a.status === 'failed' ? 'failed' : 'completed', summary: String(a.summary ?? '') };
      break;
    case 'report_issue':
      if (bench) return undefined;
      if (typeof a.description !== 'string' || !a.description.trim()) return undefined;
      action = { type: 'report_issue', description: a.description };
      break;
    default:
      return undefined;
  }
  return action;
}

/** Pure: checklist state of a plan. */
export function planState(plan: string | undefined): { todo: number; done: number; failed: number } {
  const items = [...(plan ?? '').matchAll(/^\s*[-*]\s*\[( |\/|x|X|!)\]/gm)].map((m) => m[1]);
  return { todo: items.filter((x) => x === ' ' || x === '/').length, done: items.filter((x) => x.toLowerCase() === 'x').length, failed: items.filter((x) => x === '!').length };
}
