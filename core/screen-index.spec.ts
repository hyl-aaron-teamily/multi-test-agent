import { describe, expect, it } from 'vitest';
import { fuzzyRanker } from '../executor/observe';
import { clickableOf, editDistance, hitTest, normalizeNodes, search, similarity } from './screen-index';
import { parseNodes } from './ui-tree';

const xml = `<hierarchy>
<node text="" content-desc="" class="android.view.ViewGroup" package="p" clickable="true" bounds="[0,400][1080,600]">
<node text="QA 群, aaron+test2" content-desc="" class="android.widget.TextView" package="p" clickable="false" bounds="[200,420][900,480]" />
</node>
<node text="" content-desc="" class="android.view.View" package="p" clickable="false" bounds="[0,0][1080,2400]" />
<node text="" content-desc="" class="android.view.View" package="p" clickable="false" bounds="[10,10][10,90]" />
<node text="输入消息..." hint="输入消息..." content-desc="" class="android.widget.EditText" package="p" clickable="true" bounds="[58,2100][900,2200]" />
<node text="" content-desc="发送" resource-id="ai.teamily:id/send" class="android.widget.ImageView" package="p" clickable="true" bounds="[920,2100][1060,2200]" />
<node text="引用" content-desc="" class="android.widget.TextView" package="p" clickable="true" bounds="[100,1000][300,1100]" />
</hierarchy>`;

describe('core/screen-index', () => {
  const nodes = normalizeNodes(parseNodes(xml, 'p'));
  it('normalises: drops zero-area and bare containers, empties an input showing its hint, keeps resource-id', () => {
    expect(nodes).toHaveLength(5);
    expect(nodes.find((n) => /EditText/.test(n.cls))?.text).toBe('');
    expect(nodes.find((n) => n.desc === '发送')?.rid).toBe('ai.teamily:id/send');
    expect(nodes[0].center).toEqual({ x: 540, y: 500 });
  });
  it('similarity / edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(similarity('发送', '发送')).toBe(1);
    expect(similarity('Send message', 'send-message')).toBe(1);
    expect(similarity('发送消息', '发送')).toBeGreaterThanOrEqual(0.8);
    expect(similarity('引用', '应用')).toBeLessThan(0.75);
  });
  it('search: exact → contains → fuzzy, none below threshold', () => {
    expect(search(nodes, '发送')?.how).toBe('exact');
    expect(search(nodes, 'aaron+test2')?.how).toBe('contains');
    const f = search(nodes, 'QA群 aaron test2');
    expect(f?.how).toBe('fuzzy');
    expect(f?.node.text).toContain('QA 群');
    expect(search(nodes, '应用')).toBeUndefined();
  });
  it('hitTest: smallest interactive node under the point; clickableOf: the row of a label', () => {
    expect(hitTest(nodes, 990, 2150)?.desc).toBe('发送');
    expect(hitTest(nodes, 500, 450)?.box).toEqual([0, 400, 1080, 200]);
    expect(hitTest(nodes, 5, 1500)).toBeUndefined();
    expect(clickableOf(nodes, nodes.find((n) => n.text.startsWith('QA'))!).box[1]).toBe(400);
  });
  it('fuzzyRanker (② tier) picks the closest label above threshold', async () => {
    const r = fuzzyRanker();
    expect(await r.rank('发送', ['引用', '发送消息', '取消'])).toEqual({ index: 1, score: expect.any(Number) });
    expect(await r.rank('转发', ['引用', '取消'])).toBeUndefined();
  });
});

describe('similarity: short containment', () => {
  it('a single character inside a long label is not a match', () => {
    expect(similarity('是', '是否删除这条消息')).toBeLessThan(0.75);
    expect(similarity('发送', '发送消息')).toBeGreaterThanOrEqual(0.8);
  });
});
