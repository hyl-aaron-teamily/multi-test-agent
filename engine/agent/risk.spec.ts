import { describe, expect, it } from 'vitest';
import { classifyRisk, nearOwnContent } from './risk';

const tap = (label: string, writable = false) => classifyRisk({ type: 'tap', label }, writable);

describe('quick tier risk rules (read-only by default)', () => {
  it('blocks the high-risk categories in Chinese and English', () => {
    for (const [l, c] of [['发送', 'send'], ['删除', 'delete'], ['设置', 'settings'], ['立即支付', 'payment'], ['退出登录', 'logout'], ['邀请成员', 'invite-share'], ['编辑资料', 'profile-edit'], ['Send', 'send'], ['Log out', 'logout'], ['Share', 'invite-share'], ['Upgrade', 'payment'], ['Settings', 'settings'], ['关注', 'social'], ['+ 关注', 'social'], ['点赞', 'social'], ['Follow', 'social']] as const)
      expect(tap(l), l).toMatchObject({ blocked: true, category: c });
  });

  it('word boundaries: "address", "spin", "recall list" style words inside others are not blocked by add / pin / call', () => {
    for (const l of ['Address book', 'Spinner', 'Callback info', 'Pinboard', '聊天', '我', 'Artifacts', '发现', '智能体', '查看全部']) expect(tap(l).blocked, l).toBe(false);
  });

  it('typing: only into a search box in read-only mode', () => {
    expect(classifyRisk({ type: 'type', label: '搜索', text: 'abc' }).blocked).toBe(false);
    expect(classifyRisk({ type: 'type', label: '输入消息...', text: 'hello' })).toMatchObject({ blocked: true, category: 'type' });
    expect(classifyRisk({ type: 'type', label: '输入消息...', text: 'hello' }, true).blocked).toBe(false);
  });

  it('writable mode still refuses the hard constraints (G3)', () => {
    expect(tap('删除消息', true)).toMatchObject({ blocked: true });
    expect(tap('撤回', true)).toMatchObject({ blocked: true });
    expect(tap('发送', true).blocked).toBe(false);
  });

  it('scrolling, going back and launching carry no risk', () => {
    for (const t of ['swipe', 'back', 'launch', 'wait']) expect(classifyRisk({ type: t }).blocked).toBe(false);
  });
  it('social actions: only on the own accounts’ content, in writable runs too (2026-11-03: likes / follows on real users)', () => {
    for (const l of ['点赞, 12', '已关注', '收藏 3', '赞', 'Like', 'Liked 4', 'Following', 'Bookmark']) expect(tap(l), l).toMatchObject({ blocked: true, category: 'social' });
    expect(tap('点赞', true)).toMatchObject({ blocked: true, category: 'social' });
    expect(classifyRisk({ type: 'tap', label: '帖子右下角的爱心按钮', free: true }, true)).toMatchObject({ blocked: true, category: 'social' });
    expect(classifyRisk({ type: 'tap', label: 'the heart icon', free: true })).toMatchObject({ blocked: true, category: 'social' });
    expect(classifyRisk({ type: 'tap', label: 'Start button', free: true }).blocked).toBe(false);
    expect(classifyRisk({ type: 'tap', label: '点赞' }, false, { ownContent: true }).blocked).toBe(false);
    expect(classifyRisk({ type: 'tap', label: '点赞' }, true, { ownContent: true }).blocked).toBe(false);
    // own content does not lift the other categories
    expect(classifyRisk({ type: 'tap', label: '发送' }, false, { ownContent: true }).blocked).toBe(true);
    for (const l of ['0 粉丝', 'Open 关注列表', '关注者 12 人', '发现', 'Likely']) expect(tap(l).blocked, l).toBe(false);
  });

  it('own content: an own name within a fifth of the screen height of the tap', () => {
    const nodes = [{ label: 'aaron+test2', y: 400 }, { label: 'kissme00126', y: 1500 }, { label: '黄悦龙-AgentEval 的帖子', y: 2000 }];
    const names = ['aaron+test2', '黄悦龙-AgentEval'];
    expect(nearOwnContent(600, nodes, names, 2400)).toBe(true);
    expect(nearOwnContent(1500, nodes, names, 2400)).toBe(false);
    expect(nearOwnContent(2100, nodes, names, 2400)).toBe(true);
    expect(nearOwnContent(600, nodes, [], 2400)).toBe(false);
  });
});
