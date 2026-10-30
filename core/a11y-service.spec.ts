import { describe, expect, it } from 'vitest';
import { A11Y_SERVICE, parseForwards, servicesHave, servicesWith } from './a11y-service';

describe('core/a11y-service', () => {
  it('enabled_accessibility_services: add / remove ours, keep the others and their order', () => {
    const other = 'com.x/.Svc';
    expect(servicesWith('null', true)).toBe(A11Y_SERVICE);
    expect(servicesWith(other, true)).toBe(`${other}:${A11Y_SERVICE}`);
    expect(servicesWith(`${other}:${A11Y_SERVICE}`, true)).toBe(`${other}:${A11Y_SERVICE}`);
    expect(servicesWith(`${A11Y_SERVICE}:${other}`, false)).toBe(other);
    expect(servicesWith(A11Y_SERVICE, false)).toBe('');
    expect(servicesHave(`${other}:${A11Y_SERVICE}`)).toBe(true);
    expect(servicesHave(other)).toBe(false);
  });
  it('parses our forwards only', () => {
    const out = '4f2ebdf2 tcp:51234 tcp:18765\n4f2ebdf2 tcp:5000 localabstract:scrcpy\nemulator-5554 tcp:51300 tcp:18765\n';
    expect(parseForwards(out)).toEqual([
      { serial: '4f2ebdf2', local: 'tcp:51234' },
      { serial: 'emulator-5554', local: 'tcp:51300' },
    ]);
  });
});
