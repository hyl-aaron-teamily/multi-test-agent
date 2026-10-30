// Device pool: platform/devices.yaml (declared endpoints + maxConcurrent) merged with live `adb devices`.
// State is persisted to platform/state/devices.json for the console and for post-mortem.
// Architecture after lycoding/auto-test-platform's register / heartbeat / occupy / release model,
// implemented in-process (one Node master, workers = child processes).
//
// Endpoints and slots: a task leases a *slot* = (endpoint, surface), not a whole endpoint, so one phone can
// run the Teamily app and its browser at the same time, and this computer can run desktop web and
// phone-sized web side by side — each with its own account.
//   android endpoint (adb serial) : android-app, android-web — one task each (one screen: see focus())
//   host endpoint ('host:<id>')   : desktop-web (Edge windows on Windows), mobile-web (headless Chromium)
// maxConcurrent caps distinct tasks on Android endpoints (one task may hold several slots).
// Sign-in on a phone lives on the phone: `accounts` says which pool account is signed in on which surface.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { type Surface, SURFACES, SURFACE_TRAITS } from './accounts/types';
import { type AdbDevice, listDevices } from './adb-devices';

export type DeviceStatus = 'idle' | 'busy' | 'offline';

const ANDROID_SURFACES: Surface[] = ['android-app', 'android-web'];
const HOST_DEFAULT: Partial<Record<Surface, number>> = { 'desktop-web': 2, 'mobile-web': 4 };

export interface EndpointConfig {
  udid: string;
  name?: string;
  kind: 'android' | 'host';
  /** Surfaces offered and how many tasks each can run at once. */
  capacity: Partial<Record<Surface, number>>;
  /** Pool account signed in on a surface of this endpoint (android-app / android-web). */
  accounts: Partial<Record<Surface, string>>;
  /** Phones: hierarchy read backend (W2-4 §4.1); default uiautomator. */
  treeBackend?: 'uiautomator' | 'a11y-service';
}

export interface PoolConfig {
  maxConcurrent: number;
  strategy: 'first-idle' | 'round-robin';
  devices: EndpointConfig[];
  hosts: EndpointConfig[];
}

export interface PoolDevice {
  udid: string;
  name: string;
  kind: 'android' | 'host';
  status: DeviceStatus;
  adbState: string;
  model?: string;
  /** First task holding a slot (kept for the console / older callers). */
  taskId?: string;
  lastSeen?: string;
  capacity: Partial<Record<Surface, number>>;
  /** Surface → tasks holding that slot. */
  leases: Partial<Record<Surface, string[]>>;
  accounts: Partial<Record<Surface, string>>;
}

export const CONFIG_FILE = resolve(process.env.PLATFORM_DEVICES_FILE ?? 'platform/devices.yaml');
export const STATE_FILE = resolve('platform/state/devices.json');
export const LOCAL_HOST = 'host:local';

const surfacesOf = (v: unknown, allowed: Surface[]): Surface[] => (Array.isArray(v) ? v.filter((s): s is Surface => allowed.includes(s)) : []);

function accountsOf(v: unknown): Partial<Record<Surface, string>> {
  const out: Partial<Record<Surface, string>> = {};
  if (v && typeof v === 'object') for (const [k, a] of Object.entries(v)) if (SURFACES.includes(k as Surface) && a) out[k as Surface] = String(a);
  return out;
}

/** Pure: YAML text → normalised config. Undeclared Android pool = every adb device; undeclared host = this computer. */
export function parsePoolConfig(text: string): PoolConfig {
  const raw = (yaml.load(text) ?? {}) as Record<string, any>;
  const max = Number(raw.maxConcurrent ?? 1);
  const devices: EndpointConfig[] = (Array.isArray(raw.devices) ? raw.devices : [])
    .filter((d: any) => d?.udid)
    .map((d: any) => {
      const surfaces = surfacesOf(d.surfaces, ANDROID_SURFACES);
      return { udid: String(d.udid), name: d.name ? String(d.name) : undefined, kind: 'android' as const, capacity: Object.fromEntries((surfaces.length ? surfaces : ANDROID_SURFACES).map((s) => [s, 1])), accounts: accountsOf(d.accounts), ...(d.treeBackend === 'a11y-service' ? { treeBackend: 'a11y-service' as const } : {}) };
    });
  const hosts: EndpointConfig[] = (Array.isArray(raw.hosts) ? raw.hosts : [{ id: 'local' }]).map((h: any) => {
    const cap: Partial<Record<Surface, number>> = {};
    const declared = h.surfaces && typeof h.surfaces === 'object' && !Array.isArray(h.surfaces) ? h.surfaces : HOST_DEFAULT;
    for (const [s, n] of Object.entries(declared)) if (SURFACES.includes(s as Surface) && SURFACE_TRAITS[s as Surface].host !== 'android' && Number(n) > 0) cap[s as Surface] = Number(n);
    return { udid: `host:${h.id ?? 'local'}`, name: h.name ? String(h.name) : 'this computer', kind: 'host' as const, capacity: cap, accounts: accountsOf(h.accounts) };
  });
  return { maxConcurrent: Number.isInteger(max) && max > 0 ? max : 1, strategy: raw.scheduling?.strategy === 'round-robin' ? 'round-robin' : 'first-idle', devices, hosts };
}

const EMPTY: PoolConfig = { maxConcurrent: 1, strategy: 'first-idle', devices: [], hosts: parsePoolConfig('').hosts };

export class DevicePool {
  private devices = new Map<string, PoolDevice>();
  private rr = 0;
  config: PoolConfig = EMPTY;

  async reloadConfig(): Promise<void> {
    this.config = existsSync(CONFIG_FILE) ? parsePoolConfig(await readFile(CONFIG_FILE, 'utf8')) : EMPTY;
  }

  /** Heartbeat: refresh adb state; leases survive until released. */
  async refresh(adbList?: AdbDevice[]): Promise<PoolDevice[]> {
    const live = adbList ?? (await listDevices());
    const declared: EndpointConfig[] = this.config.devices.length ? this.config.devices : live.map((d) => ({ udid: d.udid, name: d.model, kind: 'android', capacity: { 'android-app': 1, 'android-web': 1 }, accounts: {} }));
    const now = new Date().toISOString();
    const next = new Map<string, PoolDevice>();
    for (const d of [...declared, ...(this.config.hosts ?? [])]) {
      const a = live.find((x) => x.udid === d.udid);
      const prev = this.devices.get(d.udid);
      const online = d.kind === 'host' || a?.state === 'device';
      const dev: PoolDevice = {
        udid: d.udid,
        name: d.name ?? a?.model ?? d.udid,
        kind: d.kind,
        adbState: d.kind === 'host' ? 'host' : (a?.state ?? 'absent'),
        model: a?.model,
        status: 'idle',
        lastSeen: online ? now : prev?.lastSeen,
        capacity: d.capacity,
        leases: prev?.leases ?? {},
        accounts: d.accounts,
      };
      next.set(d.udid, this.withStatus(dev, online));
    }
    // An endpoint that holds leases stays in the pool even if adb lost it for a heartbeat (it shows offline).
    for (const [udid, prev] of this.devices) if (!next.has(udid) && this.tasksOf(prev).length) next.set(udid, this.withStatus({ ...prev, adbState: 'absent' }, false));
    this.devices = next;
    await this.persist();
    return this.list();
  }

  private withStatus(d: PoolDevice, online = d.adbState === 'device' || d.kind === 'host'): PoolDevice {
    const tasks = this.tasksOf(d);
    d.taskId = tasks[0];
    d.status = tasks.length ? 'busy' : online ? 'idle' : 'offline';
    return d;
  }

  private tasksOf(d: PoolDevice): string[] {
    return [...new Set(Object.values(d.leases).flat() as string[])];
  }

  list(): PoolDevice[] {
    return [...this.devices.values()];
  }

  get(udid: string): PoolDevice | undefined {
    return this.devices.get(udid);
  }

  /** Distinct tasks holding Android slots (the maxConcurrent budget). */
  busyCount(): number {
    return new Set(this.list().filter((d) => d.kind === 'android').flatMap((d) => this.tasksOf(d))).size;
  }

  /** Can `surface` of this endpoint take one more task? */
  free(d: PoolDevice, surface: Surface): boolean {
    const online = d.kind === 'host' || d.adbState === 'device';
    return online && (d.leases[surface]?.length ?? 0) < (d.capacity[surface] ?? 0);
  }

  /** Occupy a slot (endpoint × surface) for a task. `wanted` pins an endpoint. null if nothing is free or the
   *  Android budget is full (a task that already holds an Android slot does not count twice). */
  acquire(taskId: string, wanted?: string, surface: Surface = 'android-app'): PoolDevice | null {
    const android = SURFACE_TRAITS[surface].host === 'android';
    const holds = this.list().some((d) => this.tasksOf(d).includes(taskId) && d.kind === 'android');
    if (android && !holds && this.busyCount() >= this.config.maxConcurrent) return null;
    const cands = this.list().filter((d) => (!wanted || d.udid === wanted) && this.free(d, surface));
    if (!cands.length) return null;
    const dev = this.config.strategy === 'round-robin' ? cands[this.rr++ % cands.length] : cands[0];
    dev.leases[surface] = [...(dev.leases[surface] ?? []), taskId];
    this.withStatus(dev);
    void this.persist();
    return dev;
  }

  /** Release a task's slot(s) on an endpoint: one surface, or all of the task's (or all, without a task). */
  release(udid: string, surface?: Surface, taskId?: string): void {
    const d = this.devices.get(udid);
    if (d) {
      for (const s of Object.keys(d.leases) as Surface[]) {
        if (surface && s !== surface) continue;
        // One slot per call: a task may hold the same surface twice (two desktop-web roles).
        if (taskId) {
          const i = d.leases[s]!.indexOf(taskId);
          if (i >= 0) d.leases[s]!.splice(i, 1);
        } else d.leases[s] = [];
        if (!d.leases[s]!.length) delete d.leases[s];
      }
      this.withStatus(d);
    }
    void this.persist();
  }

  private writing: Promise<void> = Promise.resolve();
  /** Writes are serialised (overlapping writeFile calls could leave a torn file). */
  private persist(): Promise<void> {
    const body = JSON.stringify({ updatedAt: new Date().toISOString(), config: this.config, devices: this.list() }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(STATE_FILE), { recursive: true });
      await writeFile(`${STATE_FILE}.tmp`, body);
      await rename(`${STATE_FILE}.tmp`, STATE_FILE);
    }).catch(() => {});
    return this.writing;
  }
}

/** A phone's declared hierarchy read backend (`treeBackend` in devices.yaml; AUTOTEST_TREE_BACKEND overrides). */
export function declaredTreeBackend(udid: string): 'uiautomator' | 'a11y-service' {
  const o = process.env.AUTOTEST_TREE_BACKEND;
  if (o === 'uiautomator' || o === 'a11y-service') return o;
  try {
    return parsePoolConfig(readFileSync(CONFIG_FILE, 'utf8')).devices.find((d) => d.udid === udid)?.treeBackend ?? 'uiautomator';
  } catch {
    return 'uiautomator';
  }
}
