// Prompts Teamily web shows over the page that a user would close before going on (read-only lookup of
// where the close button is; the close itself is a normal tap / click).
import type { Page } from 'playwright';

/** "开启通知" (enable notifications) toast over the page header: the point of its close (×) button, if shown. */
export async function notifyPromptClose(page: Page): Promise<{ x: number; y: number } | undefined> {
  const title = page.getByText(/^(开启通知|Enable notifications)$/).filter({ visible: true }).first();
  const tb = await title.boundingBox({ timeout: 800 }).catch(() => null);
  if (!tb) return undefined;
  // The close button is the right-most button on the toast's row.
  let best: { x: number; y: number; w: number; h: number } | undefined;
  for (const b of await page.locator('button').filter({ visible: true }).all()) {
    const bb = await b.boundingBox().catch(() => null);
    if (!bb || bb.x < tb.x || Math.abs(bb.y + bb.height / 2 - (tb.y + tb.height / 2)) > 40) continue;
    if (!best || bb.x > best.x) best = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  }
  return best ? { x: Math.round(best.x + best.w / 2), y: Math.round(best.y + best.h / 2) } : undefined;
}
