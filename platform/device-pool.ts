// Device pool: platform/devices.yaml (declared devices + maxConcurrent) merged with live `adb devices`.
// State is persisted to platform/state/devices.json for the console and for post-mortem.
// Architecture after lycoding/auto-test-platform's register / heartbeat / occupy / release model,
// implemented in-process (one Node master, workers = child processes).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { type AdbDevice, listDevices } from './adb-devices';

export type DeviceStatus = 'idle' | 'busy' | 'offline';

export interface PoolConfig {
  maxConcurrent: number;
  strategy: 'first-idle' | 'round-robin';
  devices: { udid: string; name?: string }[];
}

export interface PoolDevice {
  udid: string;
  name: string;
  status: DeviceStatus;
  adbState: string;
  model?: string;
  taskId?: string;
  lastSeen?: string;
}

export const CONFIG_FILE = resolve(process.env.PLATFORM_DEVICES_FILE ?? 'platform/devices.yaml');
export const STATE_FILE = resolve('platform/state/devices.json');

/** Pure: YAML text → normalised config. Undeclared pool = every adb device. */
export function parsePoolConfig(text: string): PoolConfig {
  const raw = (yaml.load(text) ?? {}) as Record<string, any>;
  const max = Number(raw.maxConcurrent ?? 1);
  return {
    maxConcurrent: Number.isInteger(max) && max > 0 ? max : 1,
    strategy: raw.scheduling?.strategy === 'round-robin' ? 'round-robin' : 'first-idle',
    devices: Array.isArray(raw.devices) ? raw.devices.filter((d: any) => d?.udid).map((d: any) => ({ udid: String(d.udid), name: d.name ? String(d.name) : undefined })) : [],
  };
}

export class DevicePool {
  private devices = new Map<string, PoolDevice>();
  private rr = 0;
  config: PoolConfig = { maxConcurrent: 1, strategy: 'first-idle', devices: [] };

  async reloadConfig(): Promise<void> {
    this.config = existsSync(CONFIG_FILE) ? parsePoolConfig(await readFile(CONFIG_FILE, 'utf8')) : { maxConcurrent: 1, strategy: 'first-idle', devices: [] };
  }

  /** Heartbeat: refresh adb state; busy devices stay busy until released. */
  async refresh(adbList?: AdbDevice[]): Promise<PoolDevice[]> {
    const live = adbList ?? (await listDevices());
    const declared = this.config.devices.length ? this.config.devices : live.map((d) => ({ udid: d.udid, name: d.model }));
    const now = new Date().toISOString();
    const next = new Map<string, PoolDevice>();
    for (const d of declared) {
      const a = live.find((x) => x.udid === d.udid);
      const prev = this.devices.get(d.udid);
      const online = a?.state === 'device';
      next.set(d.udid, {
        udid: d.udid,
        name: d.name ?? a?.model ?? d.udid,
        adbState: a?.state ?? 'absent',
        model: a?.model,
        status: prev?.status === 'busy' ? 'busy' : online ? 'idle' : 'offline',
        taskId: prev?.status === 'busy' ? prev.taskId : undefined,
        lastSeen: online ? now : prev?.lastSeen,
      });
    }
    this.devices = next;
    await this.persist();
    return this.list();
  }

  list(): PoolDevice[] {
    return [...this.devices.values()];
  }

  busyCount(): number {
    return this.list().filter((d) => d.status === 'busy').length;
  }

  /** Occupy a device for a task. `wanted` pins a udid; null if nothing is free or concurrency is full. */
  acquire(taskId: string, wanted?: string): PoolDevice | null {
    if (this.busyCount() >= this.config.maxConcurrent) return null;
    const idle = this.list().filter((d) => d.status === 'idle' && (!wanted || d.udid === wanted));
    if (!idle.length) return null;
    const dev = this.config.strategy === 'round-robin' ? idle[this.rr++ % idle.length] : idle[0];
    dev.status = 'busy';
    dev.taskId = taskId;
    void this.persist();
    return dev;
  }

  release(udid: string): void {
    const d = this.devices.get(udid);
    if (d) {
      d.status = d.adbState === 'device' ? 'idle' : 'offline';
      d.taskId = undefined;
    }
    void this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), config: this.config, devices: this.list() }, null, 2));
  }
}
