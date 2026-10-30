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
