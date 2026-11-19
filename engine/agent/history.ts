// W3-3 F8: the run's history for the prompt, and search over it. Replaces step.ts historyText, which kept only
// the action type for steps older than 12 and cut typed text to 40 characters (2026-11-03 bench: long tasks
// forgot what they had typed and read). Every step stays as one ledger line with the typed text verbatim; the
// last 12 also carry the model's thought. No per-step visual summary and no chunk summaries (each would cost a
// model call per step): the screen-text delta below stands in for them, from the tree, at no cost.
// Ported from ref/artemis/artemis/memory/chunking.py L143-169 (build_action_ledger),
// ref/artemis/artemis/memory/transcript.py L98-101 (format_session_offset),
// ref/artemis/artemis/utils/task_tree.py L104-111 (format_action_clean) and
// ref/artemis/artemis/tools/history/search.py L80-102, L404-563 (_score, windowed snippets, search_history)
// (Apache-2.0), rewritten in TypeScript.
import { label, type ScreenNode } from '../../core/screen-index';
import type { StepRecord } from './step';

export const KEEP_STEPS = 12;

/** Pure: Artemis format_session_offset — `T+mm:ss`, minutes never wrap. */
export function offset(ms: number | undefined): string {
  const t = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Pure: one ledger line. */
export function ledgerLine(s: StepRecord, withThought = false): string {
  const extra = [s.changed === false ? 'screen unchanged' : '', s.sameAs ? `screen looks like the one after step ${s.sameAs}` : '', ...(s.readback ?? []).map((r) => `field now '${r}'`)].filter(Boolean);
  return `#${s.step} (${offset(s.at)}) [screen ${s.screen}] ${s.action} -> ${s.result}${extra.length ? `; ${extra.join('; ')}` : ''}${withThought && s.thought ? ` | thought: ${s.thought}` : ''}`;
}

/** Pure: the history block — every step one line (older ones: consecutive identical ones merged), the last
 *  KEEP_STEPS with the thought. */
export function historyText(steps: StepRecord[]): string {
  if (!steps.length) return '(none yet)';
  const old = steps.slice(0, -KEEP_STEPS);
  const recent = steps.slice(-KEEP_STEPS);
  const out: string[] = [];
  for (let i = 0; i < old.length; ) {
    let j = i;
    while (j + 1 < old.length && old[j + 1].action === old[i].action && old[j + 1].result === old[i].result) j++;
    out.push(j > i ? `#${old[i].step}–#${old[j].step} (${offset(old[i].at)}) ×${j - i + 1} [screen ${old[i].screen}] ${old[i].action} -> ${old[i].result}` : ledgerLine(old[i]));
    i = j + 1;
  }
  return [...out, ...recent.map((s) => ledgerLine(s, true))].join('\n');
}

/** Pure: the text that appeared on this screen and was not on the previous one (at most `max` characters). */
export function newScreenText(prev: ScreenNode[] | undefined, cur: ScreenNode[], max = 200): string {
  const before = new Set((prev ?? []).map((n) => label(n)));
  let out = '';
  for (const t of new Set(cur.map((n) => label(n)).filter((t) => t && !before.has(t)))) {
    const next = out ? `${out} | ${t}` : t;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** Pure: Artemis _score — how many of the terms occur (case-insensitive). */
export const score = (haystack: string, terms: string[]) => terms.filter((t) => haystack.toLowerCase().includes(t)).length;

/** Pure: the 240-character window around the first hit. */
function windowAround(text: string, terms: string[], limit = 240): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const hit = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, Math.min(hit - Math.floor(limit / 3), flat.length - limit));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + limit).trim()}${start + limit < flat.length ? '…' : ''}`;
}

/** Pure: search_history — over the ledger lines, the screen-text deltas and the notes; the best 5 by
 *  (score desc, step desc). */
export function searchHistory(steps: StepRecord[], notes: [string, string][], q: { query: string; from?: number; to?: number }): string {
  const terms = q.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 'search_history: give keywords in "query"';
  const docs: { step: number; text: string }[] = [];
  for (const s of steps) {
    if ((q.from !== undefined && s.step < q.from) || (q.to !== undefined && s.step > q.to)) continue;
    docs.push({ step: s.step, text: `${ledgerLine(s, true)}${s.newText ? ` | screen text: ${s.newText}` : ''}` });
  }
  for (const [k, v] of notes) docs.push({ step: -1, text: `note '${k}': ${v}` });
  const hits = docs
    .map((d) => ({ ...d, score: score(d.text, terms) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || b.step - a.step)
    .slice(0, 5);
  if (!hits.length) return `search_history "${q.query}": no matches`;
  return `search_history "${q.query}":\n${hits.map((h) => `- ${h.step >= 0 ? `step ${h.step}` : 'notes'}: ${windowAround(h.text, terms)}`).join('\n')}`;
}
