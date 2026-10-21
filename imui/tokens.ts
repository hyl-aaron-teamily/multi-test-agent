// Message tokens: every message carries `imui-<runId>-<seq>` so any client can recognise it from
// rendered text alone (no SDK, no message IDs). ASCII only — `adb shell input text` cannot type CJK.

export const makeToken = (runId: string, seq: number) => `imui-${runId}-${seq}`;

export function newRunId(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** Tokens of this run in a text blob, in order of appearance. Pure. */
export function extractTokens(text: string, runId: string): string[] {
  const re = new RegExp(`imui-${runId}-\\d+(?![\\w-])`, 'g');
  return text.match(re) ?? [];
}

/**
 * The token a bubble *starts with*, if any. Our messages always begin with their token; replies
 * that quote it (auto-reply bots, e.g. "收到：imui-x-1") must not count as sightings or duplicates —
 * the UI-level twin of imload's unexpected_pushes from perfbot. Pure.
 */
export function leadingToken(text: string, runId: string): string | undefined {
  return new RegExp(`^(imui-${runId}-[0-9]+)(?![A-Za-z0-9_-])`).exec(text.trim())?.[1];
}

/** Message body for a type. `long` pads to payloadBytes with ASCII filler. */
export function messageBody(token: string, msgType: string, payloadBytes: number): string {
  if (msgType === 'long') {
    const filler = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = `${token} `;
    while (s.length < payloadBytes) s += filler;
    return s.slice(0, Math.max(payloadBytes, token.length));
  }
  return token;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Accessibility trees report one bubble several times (container + TextView). Count distinct bubbles
 * as clusters of mutually nested / overlapping boxes. Pure.
 */
export function bubbleClusters(boxes: Box[]): number {
  const overlap = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i], boxes[j])) parent[find(i)] = find(j);
  return new Set(boxes.map((_, i) => find(i))).size;
}
