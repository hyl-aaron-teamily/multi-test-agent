import { describe, expect, it } from 'vitest';
import type { ScreenNode } from '../../core/screen-index';
import { finderFor, regionSpec, REGION_SPECS } from './finders';
import { ELEMENTS } from './vocab';
import { labelsOf } from '../../engine/skill-resolver';

const n = (o: Partial<ScreenNode> & { box: ScreenNode['box'] }): ScreenNode => ({ text: '', desc: '', rid: '', cls: 'android.widget.TextView', clickable: false, center: { x: o.box[0] + o.box[2] / 2, y: o.box[1] + o.box[3] / 2 }, ...o });
const vp = { width: 1080, height: 2400 };

describe('SKILL finders (runtime locate rules)', () => {
  it('every element has a finder on every surface it is declared for', () => {
    for (const e of ELEMENTS) for (const s of e.surfaces) expect(finderFor(e.id, s), `${e.id} on ${s}`).toBeDefined();
  });

  it('labels: 2.1.1 bottom nav "聊天" (text) and the App\'s "我的"; web inputs by read-only selector', () => {
    expect(finderFor('nav.chat', 'android-app')!.label!.test('聊天')).toBe(true);
    expect(finderFor('nav.chat', 'desktop-web')!.label!.test('3 聊天')).toBe(true);
    expect(finderFor('nav.me', 'android-app')!.label!.test('我的')).toBe(true);
    expect(finderFor('login.email', 'desktop-web')!.selector).toBe('input[type=email]');
    expect(finderFor('login.email', 'android-web')!.pick).toBeDefined();
  });

  it('labels: text and description both count; the state Teamily appends to a description is ignored', () => {
    expect(labelsOf({ text: '11', desc: '聊天, 11' })).toEqual(['11', '聊天, 11', '聊天']);
    expect(labelsOf({ text: '', desc: '我, 有新通知' }).some((l) => finderFor('nav.me', 'desktop-web')!.label!.test(l))).toBe(true);
  });

  it('desktop Artifacts: the first card is the top-left named button of the main area, not a control', () => {
    const b = (label: string, box: ScreenNode['box']) => n({ text: label, cls: 'button', box });
    const nodes = [b('通知', [1980, 24, 32, 32]), b('更多操作', [607, 90, 36, 36]), b('新建', [92, 76, 208, 44]), b('行业周报 · 科技与软件', [357, 320, 286, 20]), b('第二个文档标题', [700, 320, 286, 20])];
    expect(finderFor('artifacts.firstCard', 'desktop-web')!.pick!(nodes, vp)?.text).toBe('行业周报 · 科技与软件');
  });

  it('App composer: the lowest input, never the home search box', () => {
    const pick = finderFor('chat.composer', 'android-app')!.pick!;
    const search = n({ cls: 'android.widget.EditText', text: '搜索', box: [100, 300, 800, 90] });
    expect(pick([search], vp)).toBeUndefined();
    const comp = n({ cls: 'android.widget.EditText', text: '输入消息...', box: [58, 2128, 966, 84] });
    expect(pick([search, comp], vp)).toBe(comp);
  });

  it('App send button (no label): the right-most unlabelled button on the composer toolbar row', () => {
    const comp = n({ cls: 'android.widget.EditText', box: [58, 1500, 966, 84] });
    const plus = n({ cls: 'android.widget.Button', clickable: true, box: [40, 1600, 90, 90] });
    const mic = n({ cls: 'android.widget.Button', clickable: true, box: [850, 1600, 90, 90] });
    const send = n({ cls: 'android.widget.Button', clickable: true, box: [960, 1600, 99, 99] });
    expect(finderFor('chat.send', 'android-app')!.pick!([comp, plus, mic, send], vp)).toBe(send);
  });

  it('regions: mobile nav band spans the screen; composer band sits under the input; rewrite dialog holds 取消 and 强化', () => {
    const el = (id: string) => ({ 'nav.chat': [100, 2200, 200, 120], 'chat.composer': [58, 1500, 966, 84] })[id] as any;
    expect(REGION_SPECS['home/nav'].box({ surface: 'android-app', vp, nodes: [], el })).toEqual([0, 2200, 1080, 120]);
    expect(REGION_SPECS['home/nav'].box({ surface: 'desktop-web', vp, nodes: [], el })).toEqual([92, 2192, 216, 136]);
    expect(REGION_SPECS['chat/composer'].box({ surface: 'android-app', vp, nodes: [], el })).toEqual([0, 1584, 1080, 150]);
    const cancel = n({ text: '取消', box: [200, 1300, 300, 100] });
    const ok = n({ text: '强化', box: [580, 1300, 300, 100] });
    const dlg = n({ cls: 'android.widget.FrameLayout', box: [150, 1000, 780, 450] });
    const screen = n({ cls: 'android.widget.FrameLayout', box: [0, 0, 1080, 2400] });
    expect(REGION_SPECS['rewrite-confirm/dialog'].box({ surface: 'android-app', vp, nodes: [screen, dlg, cancel, ok], el })).toEqual(dlg.box);
    expect(REGION_SPECS['rewrite-confirm/dialog'].box({ surface: 'android-app', vp, nodes: [cancel], el })).toBeUndefined();
  });

  it('element regions are the element\'s own box', () => {
    const r = regionSpec('profile/element:profile.bell')!;
    expect(r.anchors).toEqual(['profile.bell']);
    expect(r.box({ surface: 'desktop-web', vp, nodes: [], el: () => [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
  });
});
