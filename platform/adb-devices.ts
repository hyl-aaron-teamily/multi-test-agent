// `adb devices -l` parsed into {udid, state, model}. Returns [] (not throw) when adb is missing,
// so the console and CLI degrade to "no devices" instead of crashing.
import { adb } from '../core/adb';

export interface AdbDevice {
  udid: string;
  state: string; // device | unauthorized | offline | ...
  model?: string;
  product?: string;
}

export function parseAdbDevices(out: string): AdbDevice[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [udid, state, ...kv] = l.split(/\s+/);
      const props = Object.fromEntries(kv.filter((x) => x.includes(':')).map((x) => x.split(':') as [string, string]));
      return { udid, state, model: props.model, product: props.product };
    });
}

export async function listDevices(): Promise<AdbDevice[]> {
  try {
    return parseAdbDevices(await adb(['devices', '-l']));
  } catch {
    return [];
  }
}
