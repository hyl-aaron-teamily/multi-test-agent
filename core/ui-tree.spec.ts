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
