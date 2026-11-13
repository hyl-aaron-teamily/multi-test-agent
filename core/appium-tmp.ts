// @appium/support (loaded through @midscene/android → appium-adb) makes an empty directory in the temp dir as
// soon as it is imported (tempdir.js: `const _static = tempDir()`) and never removes it: one per process that
// loads the Android driver. ~3200 had piled up by 2026-11-13. Importing this module first gives each process
// its own APPIUM_TMP_DIR (<temp>/mta-appium/<pid>), removed when the process exits; directories of processes
// that are gone (killed, crashed) are removed by the next process that loads it. An APPIUM_TMP_DIR set by
// someone else (vitest.config.ts, the user) is left alone.
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = 'MTA_APPIUM_TMP_OWNER';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Remove the per-process directories under `root` whose process is gone. Returns how many were removed. */
export function sweepAppiumTmp(root: string, isAlive: (pid: number) => boolean = alive): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      n++;
    } catch {
      /* in use: next time */
    }
  }
  return n;
}

/** Point APPIUM_TMP_DIR at this process's own directory (unless set by someone other than our parent). */
export function useAppiumTmp(env: NodeJS.ProcessEnv = process.env, root = join(tmpdir(), 'mta-appium')): string | undefined {
  if (env.APPIUM_TMP_DIR && !env[OWNER]) return undefined;
  const dir = join(root, String(process.pid));
  env.APPIUM_TMP_DIR = dir;
  env[OWNER] = String(process.pid);
  sweepAppiumTmp(root);
  return dir;
}

const mine = useAppiumTmp();
if (mine) process.on('exit', () => rmSync(mine, { recursive: true, force: true }));
