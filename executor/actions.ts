// One plan action by coordinates: element / target → point through the profile and the frozen targets.
// Loop-safe: no hierarchy read, no vision (prepare-only Nodes may locate; see skills/teamily/nodes).
import { lifecycle, type Point, sleep } from '../drivers/types';
import { RecordingDriver } from '../incident/recording-driver';
import { MAX_IDLE_MS, type PlannedAction } from '../platform/schema/test-plan';
import { pointOf, type Profile } from '../skills/profile';
import { type NodeContext, runNode } from '../skills/teamily/nodes';

export const idleMs = (a: PlannedAction) => Math.min(MAX_IDLE_MS, Math.max(0, Number(a.value ?? 1000)));

const DIRS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Label of an action in op logs / reports. */
export const actionLabel = (a: PlannedAction) => a.node?.name ?? a.element ?? a.type;

/** Pure: the point an element / target reference resolves to. */
export function resolvePoint(element: string | undefined, profile: Profile, targets: Record<string, Point>): Point {
  if (!element) throw new Error('action without element');
  if (element.startsWith('target.')) {
    const p = targets[element.slice(7)];
    if (!p) throw new Error(`target ${element} not frozen`);
    return p;
  }
  return pointOf(profile, element);
}

export async function execAction(a: PlannedAction, ctx: NodeContext, profile: Profile, targets: Record<string, Point>): Promise<void> {
  const d = ctx.driver;
  const pt = () => resolvePoint(a.element, profile, targets);
  const mid = { x: Math.round(profile.viewport.width / 2), y: Math.round(profile.viewport.height / 2) };
  switch (a.type) {
    case 'node':
      if (a.node?.name === 'teamily.login' && d instanceof RecordingDriver) await d.redacted(() => runNode(a.node!.name, a.node!.input ?? {}, ctx));
      else await runNode(a.node!.name, a.node!.input ?? {}, ctx);
      break;
    case 'tap':
      await d.tap(pt());
      break;
    case 'longPress':
      await d.longPress(pt());
      break;
    case 'type':
      if (a.element) await d.tap(pt());
      await d.type(a.value ?? '');
      break;
    case 'key':
      await d.key(a.value ?? 'Enter');
      break;
    case 'swipe': {
      const [dx, dy] = DIRS[a.value ?? 'up'] ?? DIRS.up;
      const from = a.element ? pt() : mid;
      await d.swipe(from, { x: from.x + dx * profile.viewport.width * 0.3, y: from.y + dy * profile.viewport.height * 0.3 });
      break;
    }
    case 'scroll': {
      const dy = (a.value === 'up' ? -1 : 1) * Math.round(profile.viewport.height * 0.4);
      await d.scroll(a.element ? pt() : mid, dy);
      break;
    }
    case 'back':
      await d.back();
      break;
    case 'wait':
      await sleep(Math.min(1000, Number(a.value ?? 300)));
      break;
    case 'launch':
      await d.launch();
      break;
    case 'exitApp':
    case 'killApp':
    case 'reload':
      if (d instanceof RecordingDriver) await d[a.type]();
      else await lifecycle(d, a.type);
      break;
    case 'idle':
      if (d instanceof RecordingDriver) await d.idle(idleMs(a));
      else await sleep(idleMs(a));
      break;
  }
  // Pace: the next input starts ≤ 950 ms after the previous one started (op time included).
  const lastAt = d instanceof RecordingDriver ? d.ops.at(-1)?.at : undefined;
  const wanted = Math.min(a.delayAfterMs ?? 300, 1000);
  await sleep(lastAt ? Math.max(0, Math.min(wanted, 950 - (Date.now() - lastAt))) : wanted);
}
