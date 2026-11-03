// SKILL candidates (W2-5 §7.3, N6): elements an exploration saw again and again on the same screen with the same
// text — what a person may add to the SKILL after review. Nothing here writes a profile.
import { createHash } from 'node:crypto';
import { label, type ScreenNode } from '../../core/screen-index';

export interface SkillCandidate {
  /** Screen fingerprint (engine/agent/step.ts#fingerprint). */
  page: string;
  /** What it says (text / description): the element's meaning as far as the screen tells. */
  meaning: string;
  /** Text fingerprint: stable across runs while the text stays the same. */
  fingerprint: string;
  box: [number, number, number, number];
  clickable: boolean;
  /** Steps on which it was seen. */
  count: number;
  /** Thumbnail of the first step that saw it (relative to the run dir). */
  shot: string;
}

/** Seen at least this many times on the same screen. */
export const MIN_SEEN = 3;
const MAX_TRACKED = 2000;

const thumbOf = (step: number) => `steps/${String(step).padStart(4, '0')}.png`;

export class CandidateTracker {
  private readonly seen = new Map<string, SkillCandidate>();

  /** One step's screen. Same page + text + place (rounded to 24 px) = the same element. */
  see(step: number, page: string, els: ScreenNode[]): void {
    for (const n of els) {
      const meaning = label(n).trim();
      if (!meaning || meaning.length > 40 || /\d{2,}/.test(meaning)) continue; // counts, times, messages change
      const key = `${page}|${meaning}|${Math.round(n.center.x / 24)},${Math.round(n.center.y / 24)}`;
      const c = this.seen.get(key);
      if (c) c.count++;
      else if (this.seen.size < MAX_TRACKED) this.seen.set(key, { page, meaning, fingerprint: createHash('sha1').update(meaning).digest('hex').slice(0, 10), box: n.box, clickable: n.clickable, count: 1, shot: thumbOf(step) });
    }
  }

  /** Pure view: the candidates, most seen first; clickable ones before plain text. */
  list(min = MIN_SEEN): SkillCandidate[] {
    return [...this.seen.values()].filter((c) => c.count >= min).sort((a, b) => Number(b.clickable) - Number(a.clickable) || b.count - a.count).slice(0, 200);
  }
}
