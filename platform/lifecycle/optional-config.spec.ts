import { describe, expect, it } from 'vitest';
import { androidConfigItems } from './android-ops';
import { type AndroidBaselineDriver, walkAndroid } from './baseline';

const phone = (svc: { ok: boolean; applyThrows?: boolean }): AndroidBaselineDriver => ({
  online: async () => true,
  screen: async () => ({ awake: true, locked: false }),
  wake: async () => {},
  where: async () => 'home',
  back: async () => {},
  restartApp: async () => {},
  openConversation: async () => false,
  composer: async () => '',
  clearComposer: async () => {},
  keyboard: async () => false,
  hideKeyboard: async () => {},
  ime: async () => undefined,
  setIme: async () => {},
  configOk: async (c) => ({ ok: c.id === 'a11y-service' ? svc.ok : true, detail: `${c.id} ${c.id === 'a11y-service' ? svc.ok : true}` }),
  applyConfig: async (c) => {
    if (c.id === 'a11y-service' && svc.applyThrows) throw new Error('INSTALL_FAILED_USER_RESTRICTED');
  },
  residual: async () => [],
  killResidual: async () => {},
});

describe('optional configuration item (tree service)', () => {
  const items = androidConfigItems('ai.teamily.mobile', 'a11y-service').map((c) => ({ ...c, consentedAt: '2026-10-30T00:00:00Z' }));
  it('not consented yet → not applied (no install before the one-time consent)', async () => {
    let applied = false;
    const ph = { ...phone({ ok: false }), applyConfig: async () => void (applied = true) };
    const w = await walkAndroid(ph, { configItems: androidConfigItems('p', 'a11y-service').filter((c) => c.id === 'a11y-service') }, [], true);
    expect(applied).toBe(false);
    expect(w.items[w.items.length - 1].detail).toMatch(/待同意，未应用/);
  });
  it('is declared only when the device asks for the service, and is optional', () => {
    expect(androidConfigItems('p').map((c) => c.id)).toEqual(['taplus', 'stayon']);
    expect(items.find((c) => c.id === 'a11y-service')?.optional).toBe(true);
  });
  it('unmet / failing to apply → environment still passes, item says it falls back', async () => {
    const w = await walkAndroid(phone({ ok: false, applyThrows: true }), { configItems: items }, [], true);
    expect(w.ok).toBe(true);
    const it = w.items.find((i) => i.id === 'config:a11y-service')!;
    expect(it.ok).toBe(true);
    expect(it.detail).toMatch(/应用失败：INSTALL_FAILED_USER_RESTRICTED.*退回 uiautomator/);
  });
  it('consented but unmet in a check-only walk → pending (env check then runs one fix pass)', async () => {
    const w = await walkAndroid(phone({ ok: false }), { configItems: items }, [], false);
    expect(w.items.find((i) => i.id === 'config:a11y-service')).toMatchObject({ ok: true, pending: true });
  });
  it('met → plain pass', async () => {
    const w = await walkAndroid(phone({ ok: true }), { configItems: items }, [], false);
    expect(w.items.find((i) => i.id === 'config:a11y-service')?.detail).toBe('a11y-service true');
  });
});

describe('task finished → notifications.ndjson (W2-4 §5.3)', () => {
  it('one line per finished top-level task; series children are reported by their parent', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    process.env.AUTOTEST_STATE_DIR = mkdtempSync(join(tmpdir(), 'notify-'));
    try {
      const { createTask, moveTask } = await import('./task');
      const { notificationsFile } = await import('./notify');
      createTask({ id: 'p1', kind: 'issue', issue: '2010', planId: 'p', planHash: 'h', envId: 'e', options: {} });
      createTask({ id: 'c1', kind: 'issue', issue: '2010', planId: 'p', planHash: 'h', envId: 'e', options: {}, parent: 'p1' });
      for (const id of ['p1', 'c1']) {
        for (const s of ['waiting-env', 'preflight', 'running', 'finishing'] as const) moveTask(id, s, 't', 'x');
        moveTask(id, 'done', 't', 'x', (t) => void Object.assign(t, { outcome: { code: 'NOT_REPRODUCED', summary: '未复现' }, endedBy: 'normal' }));
      }
      const lines = readFileSync(notificationsFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toEqual([expect.objectContaining({ task: 'p1', issue: '2010', state: 'done', code: 'NOT_REPRODUCED', summary: '未复现', endedBy: 'normal' })]);
    } finally {
      delete process.env.AUTOTEST_STATE_DIR;
    }
  });
});

describe('leftover helper processes (sibling environments on one phone)', () => {
  it('only helpers older than the minimum age count; ps / grep lines never do', async () => {
    const { etimeSeconds, residualHelpers } = await import('./android-ops');
    expect(etimeSeconds('00:02')).toBe(2);
    expect(etimeSeconds('01:02:03')).toBe(3723);
    expect(etimeSeconds('1-00:00:10')).toBe(86410);
    const ps = `  PID ELAPSED ARGS
22182    00:02 sh -c rm -f /sdcard/autotest_ui_0.xml; uiautomator dump /sdcard/autotest_ui_0.xml
22185    00:02 uiautomator
 9001    05:10 app_process / com.android.commands.input text abc
 9002    12:00 /system/bin/sh -c ps -A -o PID,ETIME,ARGS
 9003    03:00 yadb -keyboard x
 9004    00:30 grep uiautomator`;
    expect(residualHelpers(ps).map((h) => h.pid)).toEqual(['9001', '9003']);
  });
});
