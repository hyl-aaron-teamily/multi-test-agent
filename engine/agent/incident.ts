// W3-3 F7: execution incidents and "did the screen change". An action that the pre-tap check refused, that the
// driver failed, or that stopped a burst opens an incident; it is shown at the top of every prompt until an
// action goes through, then once as closed ("settle the original intent"). Before, the reason appeared once as
// "result of your last action" and was easy to miss. Whether the screen changed is told after every action
// (dHash, no model call): 2026-11-03 bench CameraTakeVideo pressed the shutter 4 times because nothing said the
// first press had worked.
// Ported from ref/artemis/artemis/agents/validator/incidents.py L45-120 (ExecutionIncident, open_incident) and
// ref/artemis/artemis/agents/operator/prompts.py L493-592 (render_execution_incident, render_closed_incident),
// L871-966 (ScreenshotSimilarityPromptComponent: pixel comparison, then dHash against earlier steps); hamming threshold from config/agent.py L565 (Apache-2.0),
// rewritten in TypeScript.
import { hamming, pixelDiff, type Rgba } from '../../core/image';

export type IncidentCategory = 'target_disappeared' | 'target_occupied' | 'target_shifted' | 'blocked' | 'driver_error' | 'burst_stopped' | 'general';

export interface ExecIncident {
  step: number;
  category: IncidentCategory;
  /** The action as the model asked for it. */
  action: string;
  reason: string;
  /** Position in the burst (0-based) and the burst size. */
  index: number;
  burst: number;
  consecutive: number;
  /** The last action that went through before this one, for "what summoned the vanished target". */
  prior?: { action: string; step: number };
}

/** Pure: the category of a failed action result (perform's text) or a risk block. */
export function categoryOf(result: string, blocked?: boolean): IncidentCategory {
  if (blocked) return 'blocked';
  if (/target disappeared/.test(result)) return 'target_disappeared';
  if (/target occupied/.test(result)) return 'target_occupied';
  if (/target shifted/.test(result)) return 'target_shifted';
  if (/^error:/.test(result)) return 'driver_error';
  return 'general';
}

/** Open, continue or close the incident after a turn. `failed` = the first action that did not go through. */
export class Incidents {
  open?: ExecIncident;
  private closed?: { incident: ExecIncident; at: number; shown: boolean };

  /** A turn ended: `failed` set → (re)open; otherwise any open incident closes. */
  afterTurn(step: number, failed: { action: string; reason: string; category: IncidentCategory; index: number; burst: number } | undefined, prior?: { action: string; step: number }): void {
    if (failed) {
      this.open = { step: this.open?.step ?? step, ...failed, consecutive: (this.open?.consecutive ?? 0) + 1, prior };
      this.closed = undefined;
      return;
    }
    if (this.open) this.closed = { incident: this.open, at: step, shown: false };
    this.open = undefined;
  }

  /** The prompt block for this turn (open: every turn; closed: once). */
  block(): string {
    if (this.open) return renderOpen(this.open);
    if (this.closed && !this.closed.shown) {
      this.closed.shown = true;
      const c = this.closed.incident;
      return `--- Execution Incident (CLOSED at Step ${this.closed.at}) ---\nThe incident opened at Step ${c.step} on \`${c.action}\` closed because your last action executed. Settle its original intent against the plan and the live screen: already served, still pending, or no longer needed.`;
    }
    return '';
  }
}

/** Pure: Artemis render_execution_incident. */
export function renderOpen(i: ExecIncident): string {
  const lines = ['--- Execution Incident (OPEN) ---', `Opened at Step ${i.step}; consecutive failed turns: ${i.consecutive}.`];
  if (i.burst > 1) {
    const rest = i.burst - i.index - 1;
    lines.push(`What happened: action ${i.index + 1} of your ${i.burst}-action burst, \`${i.action}\`, failed: ${i.reason}.${rest > 0 ? ` The ${rest} action(s) after it were NOT executed, so the device may be mid-sequence.` : ''}`);
  } else if (i.category === 'blocked') lines.push(`What happened: your planned action \`${i.action}\` was NOT executed. The safety rules refused it: ${i.reason}`);
  else lines.push(`What happened: your planned action \`${i.action}\` could not be executed; the device/executor reported: ${i.reason}`);
  if (i.category === 'target_shifted') lines.push('Evidence: the same element still exists but has moved; the shift exceeded the pre-tap check\'s auto-correction tolerance.');
  else if (i.category === 'target_occupied') lines.push('Evidence: the target position is now covered by a different element. Something appeared on top of your target (dialog, sheet, banner, keyboard, or a re-laid-out screen).');
  else if (i.category === 'target_disappeared') lines.push(`Evidence: the element you saw in the previous screenshot is no longer on screen.${i.prior ? ` Your last dispatched action was \`${i.prior.action}\` (Step ${i.prior.step}); if the vanished target belonged to a state that action summoned, that action is the trigger.` : ''}`);
  return lines.join('\n');
}

/** Hamming distance (dHash, 64 bits) up to which two screens count as the same (Artemis config/agent.py L565). */
export const SAME_SCREEN_HAMMING = 5;
/** Fraction of pixels that must differ for "the screen changed" (the snapshot's stability threshold): a whole-
 *  screen dHash misses a typed character or a toggled switch, so "unchanged" is decided on pixels. */
export const CHANGED_FRACTION = 0.003;

/** Pure: did the screen change between two frames of the same size (fraction of pixels that differ)? */
export function screenChanged(before: Rgba | undefined, now: Rgba | undefined): boolean | undefined {
  if (!before || !now || before.width !== now.width || before.height !== now.height) return undefined;
  return pixelDiff(before, now) / (now.width * now.height) > CHANGED_FRACTION;
}

/** Remembers the dHash of the screen after each step, for "looks like the one after step N". */
export class ScreenMemory {
  private readonly after: { step: number; hash: string }[] = [];

  /** The newest step before `lastStep` whose after-screen matches `now`. */
  sameAs(now: string | undefined, lastStep: number): number | undefined {
    if (!now) return undefined;
    return [...this.after].reverse().find((a) => a.step < lastStep && hamming(a.hash, now) <= SAME_SCREEN_HAMMING)?.step;
  }

  remember(step: number, hash: string | undefined): void {
    if (!hash) return;
    this.after.push({ step, hash });
    if (this.after.length > 200) this.after.shift();
  }
}
