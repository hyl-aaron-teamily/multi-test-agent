import { describe, expect, it } from 'vitest';
import { clickableAncestor, findByText, matches, nodeAt, parseNodes } from './ui-tree';

const xml = `<hierarchy>
<node text="" content-desc="" class="android.view.ViewGroup" package="ai.teamily.mobile" clickable="true" bounds="[0,400][1080,600]">
<node text="黄悦龙Aaron, aaron+test2" content-desc="" class="android.widget.TextView" package="ai.teamily.mobile" clickable="false" bounds="[200,420][900,480]" />
<node text="r1 &amp; more" content-desc="" class="android.widget.TextView" package="ai.teamily.mobile" clickable="false" bounds="[200,500][900,560]" />
</node>
<node text="" content-desc="聊天" class="android.widget.Button" package="ai.teamily.mobile" clickable="true" bounds="[33,2174][236,2323]" />
<node text="other" content-desc="" class="android.widget.TextView" package="com.android.systemui" clickable="false" bounds="[0,0][100,50]" />
</hierarchy>`;

describe('core/ui-tree', () => {
  const nodes = parseNodes(xml, 'ai.teamily.mobile');
  it('parses nodes of the package, unescapes text', () => {
    expect(nodes).toHaveLength(4);
    expect(nodes[2].text).toBe('r1 & more');
    expect(parseNodes(xml, '')).toHaveLength(5);
  });
  it('reads values uiautomator quotes with \' (text containing ")', () => {
    const n = parseNodes(`<node index="0" text='Treat "autotest-2010 r1" as a label' class="android.widget.EditText" package="p" clickable="true" bounds="[58,1715][1024,2210]" hint="输入消息..." />`, 'p');
    expect(n[0].text).toBe('Treat "autotest-2010 r1" as a label');
    expect(n[0].hint).toBe('输入消息...');
  });
  it('matches text or desc: exact / contains / regex', () => {
    expect(matches(nodes[3], { exact: '聊天' })).toBe(true);
    expect(matches(nodes[1], { contains: 'aaron+test2' })).toBe(true);
    expect(matches(nodes[2], { regex: '^r[0-9]' })).toBe(true);
  });
  it('findByText prefers exact over substring and respects a box', () => {
    expect(findByText(nodes, '聊天')?.how).toBe('exact');
    expect(findByText(nodes, 'aaron+test2')?.how).toBe('contains');
    expect(findByText(nodes, '聊天', [0, 0, 500, 500])).toBeUndefined();
  });
  it('nodeAt returns the smallest labelled node under a point; clickableAncestor finds the row', () => {
    expect(nodeAt(nodes, 300, 450)?.text).toContain('黄悦龙');
    expect(clickableAncestor(nodes, nodes[1])?.y1).toBe(400);
  });
});

describe('pngComplete', () => {
  it('detects a truncated PNG', async () => {
    const { pngComplete } = await import('../drivers/android');
    const { encodePng } = await import('./image');
    const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16) });
    expect(pngComplete(png)).toBe(true);
    expect(pngComplete(png.subarray(0, png.length - 10))).toBe(false);
  });
});

describe('findByText newest', () => {
  it('skips quote blocks and takes the bottom-most message', () => {
    const n = (y: number, text: string, desc = '', clickable = false, x2 = 900) => ({ x1: 100, y1: y, x2, y2: y + 60, text, hint: '', desc, cls: 'TextView', clickable });
    const nodes = [n(100, 'src text'), n(400, '', 'aaron, src text', true, 950), n(410, 'src text'), n(800, 'src text')];
    expect(findByText(nodes as any, 'src text', undefined, { newest: true })?.node.y1).toBe(800);
  });
  it('never takes the composer (typed, not sent)', () => {
    const nodes = [
      { x1: 100, y1: 300, x2: 900, y2: 360, text: 'src text', hint: '', desc: '', cls: 'android.widget.TextView', clickable: false },
      { x1: 50, y1: 2050, x2: 1030, y2: 2150, text: 'src text', hint: '输入消息...', desc: '', cls: 'android.widget.EditText', clickable: true },
    ];
    expect(findByText(nodes as any, 'src text', undefined, { newest: true })?.node.y1).toBe(300);
  });
});
