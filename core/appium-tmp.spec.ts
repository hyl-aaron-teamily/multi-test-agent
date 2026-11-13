import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './testing/tmp-dir';
import { sweepAppiumTmp, useAppiumTmp } from './appium-tmp';

describe('core/appium-tmp', () => {
  it('removes the directories of processes that are gone, keeps live ones and non-pid names', () => {
    const root = tmpDir('appiumtmp-');
    for (const n of ['111', '222', String(process.pid), 'other']) mkdirSync(join(root, n, 'x'), { recursive: true });
    expect(sweepAppiumTmp(root, (pid) => pid === 222)).toBe(1);
    expect(['111', '222', String(process.pid), 'other'].map((n) => existsSync(join(root, n)))).toEqual([false, true, true, true]);
  });

  it('gives this process its own directory; an APPIUM_TMP_DIR set by someone else is left alone', () => {
    const root = tmpDir('appiumtmp-');
    const env: NodeJS.ProcessEnv = {};
    expect(useAppiumTmp(env, root)).toBe(join(root, String(process.pid)));
    expect(env.APPIUM_TMP_DIR).toBe(join(root, String(process.pid)));
    // A child of ours inherits the variable together with the owner mark: it takes its own directory.
    const child: NodeJS.ProcessEnv = { APPIUM_TMP_DIR: join(root, '999'), MTA_APPIUM_TMP_OWNER: '999' };
    expect(useAppiumTmp(child, root)).toBe(join(root, String(process.pid)));
    const user: NodeJS.ProcessEnv = { APPIUM_TMP_DIR: 'D:/mine' };
    expect(useAppiumTmp(user, root)).toBeUndefined();
    expect(user.APPIUM_TMP_DIR).toBe('D:/mine');
  });
});
