// Exploration tier: what the model sees each step and what it may answer (after ref/artemis Flash: screenshot +
// numbered visible elements, tap by index first, coordinates only with a target description; Apache-2.0,
// rewritten). Pure: prompt building, answer parsing, screen fingerprints.
// W3-3 (§8.6 F3, F4): the element list shows full texts (JSON-quoted, no 60-character cut, no 80-element cap),
// 0–1000 bounds and overlap warnings — ported from ref/artemis/artemis/utils/visualization.py L173-255
// (_inject_mutual_occlusion_warnings) and L334-440 (format_minimal_list_with_elements); targets are read
// leniently and every unusable answer says why — after agents/validator/tool_declarations.py L189-226
// (normalize_coordinate_target) and mcp/action_executor.py L399-547; rules from agents/flash/flash_runner.md
// L26, L35-51 and agents/operator/operator.json tpl:39-40, 73 (Apache-2.0), rewritten in TypeScript.
import { createHash } from 'node:crypto';
import { label, type ScreenNode } from '../../core/screen-index';
import { normBox } from './coords';
import type { NoteMode } from './notes';

/** Where typed text goes: appended at the end (default), inserted at the very start, or replacing everything. */
export type TypeAt = 'end' | 'start' | 'replace';

export type AgentAction =
  // x / y: 0–1000 normalized; a coordinate target needs a description.
  | { type: 'tap'; target?: number; x?: number; y?: number; description?: string }
  | { type: 'longPress'; target?: number; x?: number; y?: number; description?: string }
  | { type: 'type'; target?: number; text: string; at?: TypeAt }
  | { type: 'drag'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'back' }
  | { type: 'launch' }
  | { type: 'wait'; ms: number }
  | { type: 'done'; status: 'completed' | 'failed'; summary: string }
  | { type: 'report_issue'; description: string }
  // W3-3 F5 / F8: notes and history search — no device action.
  | { type: 'note'; key: string; content: string; mode: NoteMode; target?: string }
  | { type: 'search_history'; query: string; from?: number; to?: number }
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
  /** W3-4 §8.5 ①: checklist results, as the model gave them (engine/explore/expectations.ts readVerify). */
  verify?: unknown;
}

/** Actions per turn at most (the first plus the burst). */
export const BURST_MAX = 4;
/** Actions that may be part of a burst (the others end a turn on their own). Notes ride along with device
 *  actions (operator.json tpl:39-40: note what you already see, not what you expect). */
const BURSTABLE = new Set(['tap', 'longPress', 'type', 'swipe', 'drag', 'back', 'enter', 'wait', 'note']);

export interface StepRecord {
  step: number;
  screen: string;
  action: string;
  result: string;
  /** The model's reasoning for this step (shortened). */
  thought?: string;
  /** Thumbnail of the screen the step acted on, relative to the run dir (steps/<n>.png). */
  thumb?: string;
  /** ms since the run started (ledger `T+mm:ss`). */
  at?: number;
  /** Texts typed in this step, verbatim (W3-3 F7). */
  typed?: string[];
  /** The field's text read back after each type (F9): the value, or `field not readable` / `input not committed`. */
  readback?: string[];
  /** Did the screen change after this step's actions (F7)? undefined = not compared. */
  changed?: boolean;
  /** The screen after this step looks like the one after that earlier step (F7). */
  sameAs?: number;
  /** Notes written in this step (keys, F5). */
  notes?: string[];
  /** Text that appeared on this screen and was not on the previous one (F8; search only, not in the ledger). */
  newText?: string;
  /** The page the step acted on (engine/pages.ts pageOf; W3-4 §8.2′). */
  page?: string;
  /** Checklist entries checked in this step: `<id> 符合|不符合|无法验证` (W3-4 §8.5 ①). */
  verified?: string[];
}

const INPUT = /EditText|textbox|textarea|searchbox|combobox/i;

/** Elements shown to the model: labelled or clickable (or inputs), numbered from 1; the same label within
 *  8 px of an already listed one is a duplicate (Artemis is_duplicate). No cap (W3-3 F4). */
export function visibleElements(nodes: ScreenNode[]): ScreenNode[] {
  const out: ScreenNode[] = [];
  for (const n of nodes) {
    if (!label(n) && !n.clickable && !INPUT.test(n.cls)) continue;
    const t = label(n);
    if (t && out.some((o) => label(o) === t && Math.hypot(o.center.x - n.center.x, o.center.y - n.center.y) < 8)) continue;
    out.push(n);
  }
  return out;
}

/** Pure: Artemis _inject_mutual_occlusion_warnings — pairs overlapping ≥ 50% that are not concentric parent/child. */
export function occlusions(els: ScreenNode[]): Map<number, number[]> {
  const w = new Map<number, number[]>();
  for (let i = 0; i < els.length; i++) {
    const [li, ti, wi, hi] = els[i].box;
    for (let j = i + 1; j < els.length; j++) {
      const [lj, tj, wj, hj] = els[j].box;
      const iw = Math.min(li + wi, lj + wj) - Math.max(li, lj);
      const ih = Math.min(ti + hi, tj + hj) - Math.max(ti, tj);
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const ai = Math.max(1, wi * hi);
      const aj = Math.max(1, wj * hj);
      const dist = Math.hypot(li + wi / 2 - (lj + wj / 2), ti + hi / 2 - (tj + hj / 2));
      const concentric = dist < Math.max(wi, wj, hi, hj) * 0.2;
      const iInJ = li >= lj && ti >= tj && li + wi <= lj + wj && ti + hi <= tj + hj && aj > ai * 2 && concentric;
      const jInI = lj >= li && tj >= ti && lj + wj <= li + wi && tj + hj <= ti + hi && ai > aj * 2 && concentric;
      if (iInJ || jInI) continue;
      if (inter / ai >= 0.5 || inter / aj >= 0.5) {
        w.set(i + 1, [...(w.get(i + 1) ?? []), j + 1]);
        w.set(j + 1, [...(w.get(j + 1) ?? []), i + 1]);
      }
    }
  }
  return w;
}

/** Pure: the numbered element list, texts in full (JSON-quoted: newlines and quotes escaped), bounds on the 0–1000
 *  scale, inputs with their placeholder and focus, overlap warnings. An element without text shows the tail of its
 *  resource id, so unlabelled fields and icons can still be told apart. */
export function elementList(els: ScreenNode[], size: { width: number; height: number }): string {
  const occ = occlusions(els);
  return els
    .map((n, i) => {
      const kind = INPUT.test(n.cls) ? 'input' : n.clickable ? 'button' : n.cls.replace(/^android\.widget\./, '') || 'text';
      const extra = [n.hint ? `hint ${JSON.stringify(n.hint)}` : '', n.focused ? 'focused' : '', !label(n) && n.rid && !/^(button|link|textbox|listitem|img|generic)$/.test(n.rid) ? `id ${JSON.stringify(n.rid.split('/').pop())}` : ''].filter(Boolean).join(' ');
      const o = occ.get(i + 1);
      const warn = o ? ` (WARNING: may overlap with ${o.slice(0, 2).map((x) => `[${x}]`).join(' and ')}${o.length > 2 ? ` (+${o.length - 2} more)` : ''}, possible occlusion)` : '';
      return `[${i + 1}] ${kind} ${JSON.stringify(label(n))}${extra ? ` ${extra}` : ''} | Bounds: ${size.width && size.height ? normBox(n.box, size.width, size.height) : '?'}${warn}`;
    })
    .join('\n');
}

/** Pure: a screen's fingerprint — its labels, ignoring counts and times that change while it stays the same screen. */
export function fingerprint(nodes: ScreenNode[]): string {
  const ls = [...new Set(nodes.map((n) => label(n).replace(/\d+/g, '#').slice(0, 30)).filter(Boolean))].sort().slice(0, 60);
  return createHash('sha1').update(ls.join('|')).digest('hex').slice(0, 10);
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

/** The action vocabulary shared by both system prompts (W3-3: 0–1000 coordinates, type `at`, notes, search). */
const ACTIONS = `- {"type":"tap","target":<element number>}  (preferred: the tap lands on the element's center)
- {"type":"tap","x":<0-1000>,"y":<0-1000>,"description":"<what you aim at, as a user would call it>"}  (only for something visible but not listed; coordinates on the 0-1000 scale of the screen, like the Bounds in the list; the description is required)
- {"type":"longPress","target":<n>}  (or x / y / description as for tap)
- {"type":"type","target":<n>,"text":"...","at":"end|start|replace"}  (focuses the field itself — do not tap it first; at: end = append (default), start = insert before the existing text, replace = clear the field first. Use \\n for a new line. The result tells you what the field holds afterwards: read it)
- {"type":"swipe","direction":"up|down|left|right"} | {"type":"drag","x1":..,"y1":..,"x2":..,"y2":..}  (drag on the 0-1000 scale: sliders, pickers, seek bars)`;

const NOTES_RULES = `- {"type":"note","key":"<short name>","content":"...","mode":"save|append|update","target":"<exact text to replace, for update>"}  (your notes: facts you READ that you will need later — values, names, list items, codes. Before an action that may wipe information off the screen (closing, scrolling away, switching apps), note what you saw first; collect a list that spans several screens into one note with append. Note only facts you have seen, never what you expect. Notes ride along with device actions and do not cost a turn; all your notes are shown to you every turn)
- {"type":"search_history","query":"<keywords>","from":<step>,"to":<step>}  (look up exactly what you did or saw at earlier steps — typed text, results, screen text, notes; it costs a turn and returns the best matches with their step numbers)`;

const SHARED_RULES = `Rules:
- Look before you act; do not assume where a tap leads. An action result only says what the device did; whether it had the intended effect you judge on the next screen.
- If you perform the same action on the same target for two consecutive turns and the screen shows no substantial change, stop and consider why instead of a third try (the executor rarely malfunctions; something on the screen is in the way).
- Prefer the element number; use an index only from the list of the current screen. Heed overlap warnings: an overlapped element may not receive the tap.
- ONLY report done(completed) after you have visually verified from the latest screen that the objective is fully achieved. A reviewer checks it against the goal; if it is not achieved you continue.`;

export const SYSTEM = (writable: boolean, ownContent: string[] = []) => `You test the Teamily app like a careful human tester, one action per turn, on a real ${'device or browser'}.
Each turn you get: the goal, your current plan, your notes, the history, the screenshot and the numbered visible elements.
Answer ONE JSON object: {"thought": "<short>", "plan": "<markdown checklist: - [ ] todo / - [/] doing / - [x] done / - [!] failed>", "action": {...}}.
Actions:
${ACTIONS}
- {"type":"back"} | {"type":"launch"} | {"type":"wait","ms":<=3000}
- {"type":"report_issue","description":"<what you see that is wrong, as visible facts>"}  (an error, a crash dialog, a blank or stuck page, broken text — something that stops normal use)
${NOTES_RULES}
- {"type":"done","status":"completed|failed","summary":"..."}  (goal reached, or impossible)
Several steps on the same screen (fill a form, type then press Enter): add "then": [up to 3 more actions of the kinds tap / longPress / type / swipe / drag / back / enter / wait / note]; they run in order and stop at the first one that does not go through.
${SHARED_RULES}
- Describe visible facts, never guess causes.
${writable ? '- Writable run: you may type and send, but never delete or recall anything.' : '- READ-ONLY run: never send, delete, change settings, pay, log out, invite or share, or edit a profile; typing is allowed only into a search box. Such actions are blocked and reported back to you.'}
- Likes, follows, favourites and subscriptions change what real users see: do them only on the test accounts' own profiles and content (${ownContent.length ? ownContent.map((n) => `"${n}"`).join(', ') : 'none configured'}); elsewhere they are blocked. Tabs with those names on other people's pages are blocked too — check them on the own profiles.
- When exploring, prefer entries you have not tried on this screen yet.
- Expectations (W3-4): when the prompt lists 本页待核对的预期 or 尚未核对, checking them is part of exploring. Do the trigger, look at the result on the next screen, then add "verify": {"id": "<id>", "result": "符合|不符合|无法验证", "evidence": "<visible facts>"} next to "action" (a list for several). A mismatch goes through verify, not report_issue. Issues listed under 已记录的问题 are already recorded: do not report them again.`;

/** Bench mode (AndroidWorld on an emulator): complete the task; nothing is blocked, nothing is reported. */
export const BENCH_SYSTEM = `You operate an Android phone to complete the user's task, one action per turn, like a careful human.
Each turn you get: the task, your current plan, your notes, the history, the screenshot and the numbered visible elements.
Answer ONE JSON object: {"thought": "<short>", "plan": "<markdown checklist: - [ ] todo / - [/] doing / - [x] done / - [!] failed>", "action": {...}}.
Actions:
${ACTIONS}
- {"type":"open_app","app":"<app name, e.g. Contacts, Clock, Markor>"}
- {"type":"back"} | {"type":"home"} | {"type":"enter"} | {"type":"wait","ms":<=3000}
- {"type":"answer","text":"..."}  (the task asks a question: give the answer, then finish with done)
${NOTES_RULES}
- {"type":"done","status":"completed|failed","summary":"..."}  (the task is done, or it cannot be done)
Several steps on the same screen (fill a form, type then press Enter, set a picker): add "then": [up to 3 more actions of the kinds tap / longPress / type / swipe / drag / back / enter / wait / note]; they run in order and stop at the first one that does not go through. Turns are limited: batch what you can see.
${SHARED_RULES}
- Never repeat an action whose effect you have not looked at (a second press of a button that already worked does it twice); read back the values the app shows after you enter them (names, numbers, dates, times) and correct them before moving on; to set a slider to its maximum or minimum, drag its thumb past the end of the track.`;

export function userPrompt(o: { goal: string; mode: 'task' | 'explore'; plan?: string; notes?: string; history: string; screen: string; els: ScreenNode[]; tried: string[]; feedback?: string; size: { width: number; height: number }; instructions?: string[]; top?: string[]; extra?: string[] }): string {
  return [
    // Open execution incident, final-review result, "no usable action last turn" (F6, F7): read first.
    ...(o.top ?? []),
    `Goal (${o.mode === 'explore' ? 'explore and find problems' : 'task'}): ${o.goal}`,
    o.instructions?.length ? `Instructions the user added during the run (follow them; the latest wins where they conflict; the safety rules still apply):\n${o.instructions.map((t) => `- ${t}`).join('\n')}` : '',
    `Current plan:\n${o.plan ?? '(write one)'}`,
    o.notes ? `Notes (yours, verbatim):\n${o.notes}` : '',
    `History:\n${o.history}`,
    o.feedback ? `Result of your last action: ${o.feedback}` : '',
    `Screen ${o.screen}; already tried here: ${o.tried.length ? o.tried.slice(0, 20).join(', ') : 'nothing'}`,
    `Visible elements (Bounds on the 0-1000 scale):\n${elementList(o.els, o.size) || '(none read — use 0-1000 coordinates from the screenshot, with a description)'}`,
    // Appended blocks (contract K4: later milestones add at the end): W3-4 checklist and known issues of the page.
    ...(o.extra ?? []),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Action names models use from other vocabularies (AndroidWorld, Artemis) → ours. */
const ALIASES: Record<string, string> = { click: 'tap', input_text: 'type', scroll: 'swipe', navigate_back: 'back', long_press: 'longPress', status: 'done', type_text: 'type', press_back: 'back', press_home: 'home', press_enter: 'enter', open: 'open_app', save_note: 'note', search: 'search_history' };
const KNOWN = ['tap', 'longPress', 'type', 'drag', 'swipe', 'back', 'launch', 'wait', 'done', 'report_issue', 'note', 'search_history', 'open_app', 'answer', 'home', 'enter'];

/** Pure: Artemis normalize_coordinate_target — 3, "3", [500, 280], "[500, 280]", "500, 280". */
export function readTarget(v: unknown): { index: number } | { point: { x: number; y: number } } | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return { index: v };
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return { point: { x: v[0], y: v[1] } };
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return { index: Number(s) };
  const m = s.match(/^\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?$/);
  return m ? { point: { x: Number(m[1]), y: Number(m[2]) } } : undefined;
}

export type ReadAction = { action: AgentAction } | { error: string };

/** Pure: one action of the answer, or why it cannot be used (the reason goes back to the model). `elements` =
 *  how many elements the list had (index range check). */
export function readAction(raw: Record<string, unknown>, bench = false, elements?: number): ReadAction {
  const type0 = typeof raw.type === 'string' ? raw.type : typeof raw.action_type === 'string' ? raw.action_type : undefined;
  if (!type0) return { error: "Each action needs a 'type'." };
  const type = ALIASES[type0] ?? type0;
  const benchOnly = ['open_app', 'answer', 'home', 'enter'];
  const allowed = KNOWN.filter((t) => (bench ? !['launch', 'report_issue'].includes(t) : !benchOnly.includes(t)));
  if (!allowed.includes(type)) return { error: `Unknown action type '${type0}'. Allowed: ${allowed.join(', ')}.` };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const index = (n: number): string | undefined => (elements !== undefined && (n < 1 || n > elements) ? `Invalid target index ${n}. Active index range is ${elements ? `1 to ${elements}` : 'empty (no elements were read)'}. Use an index shown in the Visible elements list, or normalized [x, y] coordinates with a description.` : undefined);
  const scale = (p: { x: number; y: number }) => (p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 1000 ? `Coordinates (${p.x}, ${p.y}) are outside the 0-1000 scale.` : undefined);
  switch (type) {
    case 'tap':
    case 'longPress': {
      const t = readTarget(raw.target ?? raw.index);
      const x = num(raw.x);
      const y = num(raw.y);
      const description = str(raw.description) ?? str(raw.target_description);
      if (t && 'index' in t) {
        const e = index(t.index);
        return e ? { error: e } : { action: { type, target: t.index } };
      }
      const p = t && 'point' in t ? t.point : x !== undefined && y !== undefined ? { x, y } : undefined;
      if (!p) return { error: `'${type0}' needs a target: an element number, or x / y on the 0-1000 scale with a description.` };
      const e = scale(p);
      if (e) return { error: e };
      if (!description?.trim()) return { error: "Coordinate target requires 'description' (what the element is, in a few words)." };
      return { action: { type, x: p.x, y: p.y, description: description.trim() } };
    }
    case 'type': {
      const text = str(raw.text) ?? str(raw.value);
      if (text === undefined) return { error: "'type' needs 'text'." };
      const t = readTarget(raw.target ?? raw.index);
      if (t && 'point' in t) return { error: "'type' takes an element number as target (the input field), not coordinates." };
      if (t) {
        const e = index(t.index);
        if (e) return { error: e };
      }
      const at0 = raw.clear === true ? 'replace' : str(raw.at);
      if (at0 !== undefined && !['end', 'start', 'replace'].includes(at0)) return { error: `'at' must be end, start or replace (got '${at0}').` };
      return { action: { type: 'type', ...(t ? { target: t.index } : {}), text, ...(at0 && at0 !== 'end' ? { at: at0 as TypeAt } : {}) } };
    }
    case 'drag': {
      const [x1, y1, x2, y2] = [num(raw.x1), num(raw.y1), num(raw.x2), num(raw.y2)];
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return { error: "'drag' needs x1, y1, x2, y2 on the 0-1000 scale." };
      const e = scale({ x: x1, y: y1 }) ?? scale({ x: x2, y: y2 });
      return e ? { error: e } : { action: { type: 'drag', x1, y1, x2, y2 } };
    }
    case 'swipe': {
      const d = str(raw.direction) ?? 'up';
      if (!['up', 'down', 'left', 'right'].includes(d)) return { error: `'swipe' direction must be up, down, left or right (got '${d}').` };
      return { action: { type: 'swipe', direction: d as 'up' } };
    }
    case 'back':
    case 'launch':
    case 'home':
    case 'enter':
      return { action: { type } as AgentAction };
    case 'wait':
      return { action: { type: 'wait', ms: Math.max(0, Math.min(3000, num(raw.ms) ?? 1000)) } };
    case 'done':
      return { action: { type: 'done', status: raw.status === 'failed' || raw.status === 'infeasible' ? 'failed' : 'completed', summary: String(raw.summary ?? raw.reason ?? '') } };
    case 'report_issue': {
      const d = str(raw.description);
      return d?.trim() ? { action: { type: 'report_issue', description: d } } : { error: "'report_issue' needs a non-empty 'description'." };
    }
    case 'note': {
      const key = str(raw.key);
      const content = str(raw.content);
      const mode = (str(raw.mode) ?? (type0 === 'save_note' ? 'save' : 'append')) as NoteMode;
      if (!key?.trim() || content === undefined) return { error: "'note' needs 'key' and 'content'." };
      if (!['save', 'append', 'update'].includes(mode)) return { error: `'note' mode must be save, append or update (got '${mode}').` };
      if (mode === 'update' && !str(raw.target)) return { error: "'note' with mode update needs 'target': the exact text to replace." };
      return { action: { type: 'note', key: key.trim(), content, mode, ...(mode === 'update' ? { target: str(raw.target) } : {}) } };
    }
    case 'search_history': {
      const query = str(raw.query) ?? (Array.isArray(raw.keywords) ? raw.keywords.join(' ') : undefined);
      if (!query?.trim()) return { error: "'search_history' needs 'query' (keywords)." };
      const from = num(raw.from);
      const to = num(raw.to);
      return { action: { type: 'search_history', query: query.trim(), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) } };
    }
    case 'open_app': {
      const app = str(raw.app) ?? str(raw.app_name);
      return app?.trim() ? { action: { type: 'open_app', app: app.trim() } } : { error: "'open_app' needs 'app' (the app's name)." };
    }
    case 'answer': {
      const text = str(raw.text);
      return text !== undefined ? { action: { type: 'answer', text } } : { error: "'answer' needs 'text'." };
    }
    default:
      return { error: `Unknown action type '${type0}'.` };
  }
}

/** Pure: one action of the answer; undefined = unusable (readAction says why). */
export function parseAction(a: Record<string, unknown>, bench = false): AgentAction | undefined {
  const r = readAction(a, bench);
  return 'action' in r ? r.action : undefined;
}

/** Pure: the model's answer, or why it cannot be used. A burst holds only burstable actions; anything else ends
 *  it, and an unusable burst action is dropped with its reason (the first action still runs). */
export function readAnswer(raw: unknown, bench = false, elements?: number): { answer: AgentAnswer; dropped?: string } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The answer is not one JSON object.' };
  const r = raw as { thought?: unknown; plan?: unknown; action?: unknown; then?: unknown; verify?: unknown };
  if (!r.action || typeof r.action !== 'object' || Array.isArray(r.action)) return { error: "The answer has no 'action' object." };
  const first = readAction(r.action as Record<string, unknown>, bench, elements);
  if ('error' in first) return first;
  const then: AgentAction[] = [];
  let dropped: string | undefined;
  if (Array.isArray(r.then) && BURSTABLE.has(first.action.type)) {
    for (const x of r.then.slice(0, BURST_MAX - 1)) {
      const a = x && typeof x === 'object' ? readAction(x as Record<string, unknown>, bench, elements) : { error: 'not an object' };
      if ('error' in a) {
        dropped = `a "then" action was not run: ${a.error}`;
        break;
      }
      if (!BURSTABLE.has(a.action.type)) {
        dropped = `"then" stopped at '${a.action.type}': only tap / longPress / type / swipe / drag / back / enter / wait / note can follow`;
        break;
      }
      then.push(a.action);
    }
  }
  return { answer: { thought: String(r.thought ?? ''), plan: typeof r.plan === 'string' ? r.plan : undefined, action: first.action, ...(then.length ? { then } : {}), ...(r.verify !== undefined && !bench ? { verify: r.verify } : {}) }, ...(dropped ? { dropped } : {}) };
}

/** Pure: the model's answer; undefined = unusable. */
export function parseAnswer(raw: unknown, bench = false): AgentAnswer | undefined {
  const r = readAnswer(raw, bench);
  return 'answer' in r ? r.answer : undefined;
}

/** Pure: checklist state of a plan. */
export function planState(plan: string | undefined): { todo: number; done: number; failed: number } {
  const items = [...(plan ?? '').matchAll(/^\s*[-*]\s*\[( |\/|x|X|!)\]/gm)].map((m) => m[1]);
  return { todo: items.filter((x) => x === ' ' || x === '/').length, done: items.filter((x) => x.toLowerCase() === 'x').length, failed: items.filter((x) => x === '!').length };
}
