// W3-3 F6: final review. When the model reports done(completed), a read-only reviewer judges the original goal
// against the evidence before the run ends (2026-11-03 bench: RecipeAddMultipleRecipes saw "two Caprese" and
// still reported done; CameraTakeVideo recorded twice). Artemis' Checker is a tool loop of 2–20 calls; here it is
// ONE call: everything it needs is put into the prompt (goal and added instructions, final plan, notes, the last
// 60 ledger lines, every input read-back and "screen unchanged" mark, the final element list and screenshot).
// Not passed → the run goes on with the reasons at the top of the next prompt; the same failures twice with no
// screen-changing action in between → the run ends as failed (progress-based stop, no fixed review count).
// Ported from ref/artemis/artemis/agents/checker/checker.py L79-118 (CheckVerdict, CheckReport,
// verdicts_allow_release), L354-381 (_format_history), L432-461 (_normalize_report), L791-859 (run_final_check),
// L433-465 (revert_subgoal_status); prompts from agents/checker/checker.json (system, base_rules, final_guide);
// feedback block after agents/operator/prompts.py L408-432 (FeedbackPromptComponent) (Apache-2.0), rewritten in
// TypeScript.
import { modelCall } from '../../core/context/assemble';
import { similarity } from './notes';

export interface CheckVerdict {
  item: string;
  status: 'passed' | 'failed' | 'inconclusive';
  evidence: string;
  suggestion?: string;
}

export interface CheckReport {
  verdicts: CheckVerdict[];
  unmet: string[];
  /** Question tasks: the answer handed in is backed by the screen or the notes. */
  answer_ok?: boolean;
}

export const CHECKER_SYSTEM = `You are a precise, evidence-driven verification expert (Checker). You audit whether an agent that operated a phone really achieved its goal, against the recorded execution evidence. You never operate the device, never modify any state, and never negotiate with the agent — you only observe and judge.

# Verdict rules (always apply)
- Split the goal (as amended by the user's added instructions) into the concrete, checkable items it asks for, and judge each one.
- Quote each item in \`item\` in the goal's own words — never paraphrase it into something easier.
- Every verdict MUST carry concrete evidence: a specific on-screen element or screenshot observation, a ledger line, a field read-back, or a note excerpt. A \`failed\` verdict without concrete evidence is invalid and will be downgraded.
- \`inconclusive\` means the evidence needed for a judgment was never captured or is genuinely ambiguous; say what is missing. Do NOT output \`failed\` for lack of evidence.
- Judge only what the goal declares. Do not invent additional criteria and do not relax the declared ones.

# Final review
- Audit against the user's original goal as amended by the instructions added during the run, not merely the plan's checkboxes.
- Items about the end state: judge them on the FINAL screen (element list and screenshot).
- Items about something done earlier: judge them from the ledger, read-backs and notes; the current screen only proves the present.
- Look for things done twice (the same entry added again, a button pressed again after it had worked, "screen unchanged" followed by a repeat) and for values entered wrongly (read-backs that differ from what the goal asks).
- \`unmet\`: list, verbatim, any plan item marked done ([x]) whose result is demonstrably not there. Leave it empty otherwise.
- If the agent handed in an answer, set \`answer_ok\`: true only when the screen, the ledger or the notes back it.

Answer ONE JSON object: {"verdicts": [{"item": "...", "status": "passed|failed|inconclusive", "evidence": "...", "suggestion": "<what to do, for failed items>"}], "unmet": ["..."], "answer_ok": true|false (only if an answer was handed in)}`;

export interface CheckMaterials {
  goal: string;
  instructions?: string[];
  plan?: string;
  notes?: string;
  /** Ledger lines, oldest first (the caller passes the last 60). */
  ledger: string[];
  /** Every input read-back and "screen unchanged" mark of the run. */
  marks: string[];
  answer?: string;
  /** The final screen's element list (step.ts format). */
  elements: string;
}

/** Pure: the reviewer's user prompt. */
export function checkerPrompt(m: CheckMaterials): string {
  return [
    `Goal: ${m.goal}`,
    m.instructions?.length ? `Instructions the user added during the run (they amend the goal):\n${m.instructions.map((t) => `- ${t}`).join('\n')}` : '',
    `The agent's final plan:\n${m.plan ?? '(none)'}`,
    m.notes ? `The agent's notes:\n${m.notes}` : '',
    m.answer !== undefined ? `Answer the agent handed in: ${JSON.stringify(m.answer)}` : '',
    `Execution ledger (last ${m.ledger.length} steps):\n${m.ledger.join('\n') || '(none)'}`,
    `Input read-backs and unchanged screens during the whole run:\n${m.marks.join('\n') || '(none)'}`,
    `FINAL screen — visible elements (bounds on a 0–1000 scale):\n${m.elements || '(none read)'}`,
    'The final screenshot follows.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Pure: Artemis _normalize_report — unknown statuses are inconclusive; failed without evidence is inconclusive. */
export function normalizeReport(raw: unknown): CheckReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { verdicts?: unknown; unmet?: unknown; unmet_subgoals?: unknown; answer_ok?: unknown };
  if (!Array.isArray(r.verdicts)) return undefined;
  const verdicts: CheckVerdict[] = r.verdicts
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((v) => {
      const evidence = String(v.evidence ?? '').trim();
      const st = v.status === 'passed' || v.status === 'failed' ? v.status : 'inconclusive';
      return { item: String(v.item ?? v.item_text ?? '').trim(), status: st === 'failed' && !evidence ? 'inconclusive' : st, evidence, ...(typeof v.suggestion === 'string' && v.suggestion.trim() ? { suggestion: v.suggestion.trim() } : {}) };
    });
  const unmetRaw = Array.isArray(r.unmet) ? r.unmet : Array.isArray(r.unmet_subgoals) ? r.unmet_subgoals : [];
  return { verdicts, unmet: unmetRaw.map((x) => String(x).trim()).filter(Boolean), ...(typeof r.answer_ok === 'boolean' ? { answer_ok: r.answer_ok } : {}) };
}

/** Pure: Artemis verdicts_allow_release — no failed item, nothing unmet, and a handed-in answer is backed. */
export const passes = (r: CheckReport) => !r.verdicts.some((v) => v.status === 'failed') && !r.unmet.length && r.answer_ok !== false;

/** Pure: what failed, as a comparable key (the same failures twice without progress = stop). */
export const failureKey = (r: CheckReport) => [...r.verdicts.filter((v) => v.status === 'failed').map((v) => `f:${v.item}`), ...r.unmet.map((u) => `u:${u}`), ...(r.answer_ok === false ? ['answer'] : [])].sort().join('\n');

/** Pure: the block at the top of the next prompt when the review did not pass. */
export function feedbackBlock(r: CheckReport): string {
  const lines = ['--- Final review (not passed) ---'];
  for (const v of r.verdicts.filter((x) => x.status === 'failed')) lines.push(`- [verify failed] '${v.item}': ${v.evidence}${v.suggestion ? ` Suggestion: ${v.suggestion}` : ''}`);
  for (const u of r.unmet) lines.push(`- [unmet] '${u}' is marked done but its result is not there.`);
  if (r.answer_ok === false) lines.push('- [answer] the answer you handed in is not backed by the screen or your notes: check it, then answer again.');
  lines.push('These are independent judgments; address them, then report done again.');
  return lines.join('\n');
}

/** Pure: Artemis revert_subgoal_status — plan lines marked [x] that match a failed or unmet item go back to [/]. */
export function revertPlan(plan: string | undefined, r: CheckReport): string | undefined {
  if (!plan) return plan;
  const items = [...r.verdicts.filter((v) => v.status === 'failed').map((v) => v.item), ...r.unmet].map((s) => s.toLowerCase()).filter(Boolean);
  if (!items.length) return plan;
  return plan
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*[-*]\s*)\[(x|X)\](.*)$/);
      if (!m) return line;
      const text = m[3].trim().toLowerCase();
      const hit = items.some((it) => text.includes(it) || it.includes(text) || similarity(text, it) >= 0.6);
      return hit ? `${m[1]}[/]${m[3]}` : line;
    })
    .join('\n');
}

/** One review call. No usable report → { error }: the caller lets the model's own verdict stand (a review that
 *  cannot be had must not keep a run going on its own). */
export async function runCheck(m: CheckMaterials, shot: Buffer, timeoutMs = 180_000): Promise<{ report: CheckReport } | { error: string }> {
  const r = await modelCall({
    purpose: 'agent-check',
    vision: true,
    slots: [
      { name: 'role', role: 'system', stable: true, content: CHECKER_SYSTEM },
      { name: 'evidence', role: 'user', content: checkerPrompt(m) },
      { name: 'screenshot', role: 'user', content: [{ label: 'Final screenshot', png: shot }] },
    ],
    timeoutMs,
    correct: true,
  }).catch((e: Error) => ({ ok: false as const, error: e.message }));
  if (!r.ok) return { error: 'error' in r ? r.error : 'no answer' };
  const report = normalizeReport(r.value);
  return report ? { report } : { error: 'the review answer has no verdicts' };
}
