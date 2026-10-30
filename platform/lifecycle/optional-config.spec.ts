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
  const items = androidConfigItems('ai.teamily.mobile', 'a11y-service');
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
