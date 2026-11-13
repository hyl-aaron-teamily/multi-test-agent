// W3-3 F3: the model answers coordinates on a 0–1000 scale; the code converts them to pixels. The screenshot can
// then be scaled for tokens without the model doing arithmetic (2026-11-03 bench: "scaled y≈475 → full-res ≈712").
// Ported from ref/artemis/artemis/utils/coordinates.py L315-328 (normalize_point / denormalize_point) and
// ref/artemis/artemis/mcp/actuators/adb.py L127-131 (_to_px) (Apache-2.0), rewritten in TypeScript.
import type { Box } from '../../core/screen-index';

export interface Point {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pure: pixels → 0–1000. */
export const toNorm = (p: Point, w: number, h: number): Point => ({ x: clamp(Math.round((p.x * 1000) / w), 0, 1000), y: clamp(Math.round((p.y * 1000) / h), 0, 1000) });

/** Pure: 0–1000 → pixels, inside the screen. */
export const toPx = (n: Point, w: number, h: number): Point => ({ x: clamp(Math.trunc((n.x * w) / 1000), 0, w - 1), y: clamp(Math.trunc((n.y * h) / 1000), 0, h - 1) });

/** Pure: a pixel box [x, y, w, h] as the model sees it: `[l,t][r,b]` on the 0–1000 scale. */
export function normBox(b: Box, w: number, h: number): string {
  const a = toNorm({ x: b[0], y: b[1] }, w, h);
  const z = toNorm({ x: b[0] + b[2], y: b[1] + b[3] }, w, h);
  return `[${a.x},${a.y}][${z.x},${z.y}]`;
}
