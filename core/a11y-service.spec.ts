import { describe, expect, it } from 'vitest';
import { A11Y_SERVICE, parseForwards, pruneOffscreen, servicesHave, servicesWith } from './a11y-service';

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

describe('pruneOffscreen (service output vs uiautomator)', () => {
  it('drops invisible rows below the screen (subtree) and invisible inverted boxes (node only); keeps invisible real boxes', () => {
    const xml = `<hierarchy><node text="a" visible-to-user="true" bounds="[0,0][1080,2400]"><node text="b" visible-to-user="false" bounds="[0,2407][10,2400]"><node text="c" visible-to-user="false" bounds="[0,2410][10,2400]" /></node><node text="d" visible-to-user="false" bounds="[160,297][981,157]"><node text="e" visible-to-user="false" bounds="[160,91][980,157]" /></node><node text="g" visible-to-user="false" bounds="[204,811][523,35]" /></node><node text="f" visible-to-user="true" bounds="[0,0][5,5]" /></hierarchy>`;
    expect(pruneOffscreen(xml)).toBe(`<hierarchy><node text="a" visible-to-user="true" bounds="[0,0][1080,2400]"><node text="e" visible-to-user="false" bounds="[160,91][980,157]" /></node><node text="f" visible-to-user="true" bounds="[0,0][5,5]" /></hierarchy>`);
  });
  it('a visible node is never dropped', () => {
    const xml = `<hierarchy><node text="v" visible-to-user="true" bounds="[0,2500][10,2400]" /></hierarchy>`;
    expect(pruneOffscreen(xml)).toBe(xml);
  });
});
