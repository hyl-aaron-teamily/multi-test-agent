// W3-3 F5: the agent's notes — facts it read and will need after the screen changed (2026-11-03 bench:
// MarkorMergeNotes said after 156 steps "I did not note the original text"). One markdown file per key under
// <runDir>/notes/. Unlike Artemis (only the plan is in the prompt, the rest via read_note), every note goes into
// every prompt verbatim: our loop is single-agent and the model weaker, and notes stay a few hundred characters.
// Ported from ref/artemis/artemis/utils/notes.py L127-367 (save / append / update with exact → relaxed → fuzzy
// matching, clean_line, find_relaxed_match, find_fuzzy_match, apply_replacement) (Apache-2.0), rewritten in
// TypeScript; difflib.SequenceMatcher.ratio is reimplemented below (Ratcliff/Obershelp).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type NoteMode = 'save' | 'append' | 'update';

const FUZZY_WARNING = 'We did our best to apply changes despite some inaccuracies. Double check if the edit applied is what you intended.';

/** Pure: Artemis clean_line — lower case, no quotes, no list bullet / checkbox, no whitespace. */
export function cleanLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/^\s*[-*+]\s*(\[[ xX/]\])?\s*/, '')
    .replace(/\s+/g, '');
}

/** Pure: difflib.SequenceMatcher(None, a, b).ratio() — 2·matches / (|a| + |b|), matches by longest common blocks. */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (a1: number, a2: number, b1: number, b2: number): number => {
    let best = 0;
    let bi = 0;
    let bj = 0;
    // Longest common substring of a[a1,a2) and b[b1,b2) (dynamic programming over one row).
    let prev = new Array<number>(b2 - b1 + 1).fill(0);
    for (let i = a1; i < a2; i++) {
      const cur = new Array<number>(b2 - b1 + 1).fill(0);
      for (let j = b1; j < b2; j++) {
        if (a[i] === b[j]) {
          cur[j - b1 + 1] = prev[j - b1] + 1;
          if (cur[j - b1 + 1] > best) {
            best = cur[j - b1 + 1];
            bi = i - best + 1;
            bj = j - best + 1;
          }
        }
      }
      prev = cur;
    }
    if (!best) return 0;
    return best + matches(a1, bi, b1, bj) + matches(bi + best, a2, bj + best, b2);
  };
  return (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length);
}

const linesKeep = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Pure: the unique window of note lines equal to the target lines after cleanLine; [start, end) in characters. */
export function relaxedMatch(content: string, target: string): [number, number] | undefined {
  const noteLines = linesKeep(content);
  const clean = noteLines.map(cleanLine);
  const want = target.split('\n').map(cleanLine).filter(Boolean);
  if (!want.length || clean.length < want.length) return undefined;
  const hits: number[] = [];
  for (let i = 0; i + want.length <= clean.length; i++) if (want.every((w, k) => clean[i + k] === w)) hits.push(i);
  if (hits.length !== 1) return undefined;
  const at = (n: number) => noteLines.slice(0, n).join('').length;
  return [at(hits[0]), at(hits[0] + want.length)];
}

/** Pure: the unique window at least `threshold` similar (runner-up within 0.05 = ambiguous); [start, end). */
export function fuzzyMatch(content: string, target: string, threshold = 0.9): [number, number] | undefined {
  const noteLines = linesKeep(content);
  const m = target.split('\n').length;
  if (!m || noteLines.length < m) return undefined;
  const want = target.split('\n').map(cleanLine).join('\n');
  let best: number | undefined;
  let bestRatio = 0;
  let ambiguous = false;
  for (let i = 0; i + m <= noteLines.length; i++) {
    const r = similarity(noteLines.slice(i, i + m).map(cleanLine).join('\n'), want);
    if (r < threshold) continue;
    if (r > bestRatio + 0.05) {
      best = i;
      bestRatio = r;
      ambiguous = false;
    } else if (Math.abs(r - bestRatio) <= 0.05) ambiguous = true;
  }
  if (best === undefined || ambiguous) return undefined;
  const at = (n: number) => noteLines.slice(0, n).join('').length;
  return [at(best), at(best + m)];
}

/** Pure: Artemis apply_replacement — keeps the slice's trailing newline. */
function replaceRange(content: string, [s, e]: [number, number], replacement: string): string {
  const r = content.slice(s, e).endsWith('\n') && !replacement.endsWith('\n') ? `${replacement}\n` : replacement;
  return content.slice(0, s) + r + content.slice(e);
}

/** Pure: update `target` in `content` (exact → relaxed → fuzzy); throws with the reason the model gets back. */
export function updateText(content: string, key: string, target: string, replacement: string): { content: string; warning?: string } {
  const count = target ? content.split(target).length - 1 : 0;
  if (count === 1) return { content: content.replace(target, () => replacement) };
  if (count > 1) throw new Error(`Target string '${target}' is not unique in note '${key}' (found ${count} occurrences). To prevent accidental changes, please provide a longer and more complete target string.`);
  const r = relaxedMatch(content, target) ?? fuzzyMatch(content, target);
  if (r) return { content: replaceRange(content, r, replacement), warning: FUZZY_WARNING };
  throw new Error(`Target string '${target}' not found in note '${key}'. Please re-read the note and ensure spelling, spacing, and indentation are close.`);
}

export const safeKey = (k: string) => k.trim().replace(/[^\w.\-一-鿿]+/g, '_').slice(0, 60) || 'note';

/** The run's notes: in memory for the prompt, mirrored to <runDir>/notes/<key>.md. */
export class Notes {
  private readonly notes = new Map<string, string>();
  constructor(private readonly dir?: string) {}

  /** Apply one note action; the returned text is the action's result for the model. */
  apply(a: { key: string; content: string; mode: NoteMode; target?: string }): string {
    const key = safeKey(a.key);
    const cur = this.notes.get(key);
    let out: string;
    let msg: string;
    if (a.mode === 'save') {
      out = a.content;
      msg = `Saved note '${key}'.`;
    } else if (a.mode === 'append') {
      out = cur === undefined || cur === '' ? a.content : `${cur}${cur.endsWith('\n') ? '' : '\n'}${a.content}`;
      msg = `Appended to note '${key}'.`;
    } else {
      if (cur === undefined) throw new Error(`Note '${key}' not found.`);
      if (!a.target) throw new Error("update needs 'target': the exact text to replace");
      const r = updateText(cur, key, a.target, a.content);
      out = r.content;
      msg = `Updated note '${key}'.${r.warning ? ` WARNING: ${r.warning}` : ''}`;
    }
    this.notes.set(key, out);
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, `${key}.md`), out);
      } catch {
        /* the file is a mirror; the prompt uses memory */
      }
    }
    return msg;
  }

  get size(): number {
    return this.notes.size;
  }

  entries(): [string, string][] {
    return [...this.notes];
  }

  /** The prompt block: every note verbatim. */
  text(): string {
    return this.notes.size ? [...this.notes].map(([k, v]) => `## ${k}\n${v}`).join('\n\n') : '';
  }
}
