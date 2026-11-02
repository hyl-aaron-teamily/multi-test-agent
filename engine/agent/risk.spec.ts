import { describe, expect, it } from 'vitest';
import { classifyRisk } from './risk';

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
});
