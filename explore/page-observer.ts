// Interactive element discovery for the generic explorer: one aiQuery per screen returns the
// tappable / typeable controls with a short purpose description used for prioritisation.
// ref: midscene-example/android/javascript-sdk-demo/demo.ts (aiQuery with a typed shape string)
// ref: node_modules/@midscene/core dist/types/agent/agent.d.ts — aiQuery<T>(demand, opt)
// note: ref/midscene-skills is not present locally; prompt wording follows the midscene docs
//       "aiQuery" examples (shape description + natural-language demand).
import type { AndroidAgent } from '@midscene/android';

export type InteractiveElementType = 'button' | 'input' | 'list-item' | 'tab' | 'switch' | 'unknown';

export interface InteractiveElement {
  type: InteractiveElementType;
  label: string;
  description: string;
}

const TYPES: InteractiveElementType[] = ['button', 'input', 'list-item', 'tab', 'switch', 'unknown'];

const QUERY =
  '{type: "button" | "input" | "list-item" | "tab" | "switch" | "unknown", label: string, description: string}[], ' +
  'every interactive element currently visible on the screen (buttons, icon buttons, input boxes, ' +
  'tappable list rows, bottom/top tabs, switches). label = the visible text, or a short inferred name ' +
  'for icon-only controls; description = what tapping it most likely does in under 12 words. ' +
  'Do not include plain text, images or the system status bar. At most 25 items.';

/** Normalise whatever the model returned into a clean, de-duplicated list. Pure, exported for tests. */
export function normaliseElements(raw: unknown): InteractiveElement[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: InteractiveElement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const label = String(r.label ?? '').trim();
    if (!label) continue;
    const type = TYPES.includes(r.type as InteractiveElementType) ? (r.type as InteractiveElementType) : 'unknown';
    const el = { type, label, description: String(r.description ?? '').trim() };
    const key = elementKey(el);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

/** Stable key of an element inside one state. */
export function elementKey(el: Pick<InteractiveElement, 'type' | 'label'>): string {
  return `${el.type}:${el.label.toLowerCase()}`;
}

export async function observeInteractiveElements(agent: AndroidAgent, hint?: string): Promise<InteractiveElement[]> {
  const raw = await agent.aiQuery(hint ? `${QUERY} Context: ${hint}` : QUERY);
  return normaliseElements(raw);
}
