import { describe, expect, it } from 'vitest';
import type { UiNode } from '../core/ui-tree';
import { literalsOf } from './locate';
import { observationOf, OBSERVATIONS, scopeNodes } from './observe';

const n = (text: string, desc: string, y: number, clickable = false, x1 = 300): UiNode => ({ x1, y1: y, x2: 1000, y2: y + 60, text, hint: '', desc, cls: 'TextView', clickable });

describe('observation library', () => {
  it('maps check kinds to observation ids', () => {
    expect(observationOf({ kind: 'keyboard', expect: '', want: 'present' })).toBe('keyboard-shown');
    expect(observationOf({ kind: 'visual-region', page: 'p', region: 'element:profile.bell', expect: '', want: 'absent' })).toBe('element');
    expect(observationOf({ kind: 'ai', expect: '', want: 'present' })).toBe('visual-question');
    expect(OBSERVATIONS['keyboard-shown'].usable).not.toContain('mobile-web');
  });
  it('scopes text checks to quote cards or to a band around a target', () => {
    const nodes = [n('hello', '', 500), n('', 'Tmly, [x](x) 测', 900, true), n('far', '', 1600)];
    expect(scopeNodes(nodes, { kind: 'text', expect: '', want: 'absent', scope: 'quote-cards' }, {}, 1080).map((x) => x.desc)).toEqual(['Tmly, [x](x) 测']);
    expect(scopeNodes(nodes, { kind: 'text', expect: '', want: 'present', scope: { target: 'msg', within: 250 } }, { msg: { x: 500, y: 600 } }, 1080).map((x) => x.text)).toEqual(['hello']);
  });
  it('finds literal texts in a locate description', () => {
    expect(literalsOf('the "忽略" (Ignore) button of a dialog')).toEqual(['忽略', 'Ignore']);
  });
});
