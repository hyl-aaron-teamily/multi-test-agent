// Exploration tier safety (rule G10, W2-5 X2): read-only by default. An action is classified before it runs from the
// label of what it acts on and, for typing, the typed text. Read-only blocks every high-risk category and all
// typing except into a search box; writable (an approved sensitive plan) blocks only the hard constraints G3.
// Seed words: the keyword lists of the W1 explorer / mission runner (git show 3d7dc46:explore/explore-loop.ts,
// mission/runner.ts), rewritten with word boundaries (the old lists blocked "add", "pin", "call" inside other
// words) and split by language.

export type RiskCategory = 'send' | 'delete' | 'settings' | 'payment' | 'logout' | 'invite-share' | 'profile-edit' | 'social' | 'type' | 'lock';

export interface Risk {
  blocked: boolean;
  category?: RiskCategory;
  reason: string;
}

const ZH: [RiskCategory, RegExp][] = [
  ['payment', /支付|付款|充值|购买|订阅|开通|升级会员|续费|钱包|红包|转账|积分兑换/],
  ['delete', /删除|移除|清空|撤回|解散|退出群|删除好友|拉黑|举报/],
  ['logout', /退出登录|注销|登出|切换账号/],
  ['send', /^发送$|发送消息|^发送(到|给)|^转发|^回复$|^提交$|^发布/],
  ['invite-share', /邀请|分享|^复制链接|添加好友|加好友/],
  ['settings', /设置|开关|启用|停用|免打扰|置顶|通知权限|隐私|权限申请|开启通知|^开启$/],
  ['profile-edit', /编辑资料|修改(昵称|头像|签名|资料|密码)|更换头像|^保存$|^确定$|^确认$/],
];

const EN: [RiskCategory, RegExp][] = [
  ['payment', /\b(pay|purchase|buy|subscribe|upgrade|top[- ]?up|recharge|wallet|checkout|billing)\b/i],
  ['delete', /\b(delete|remove|clear|recall|unsend|block|report|dismiss group|leave group)\b/i],
  ['logout', /\b(log ?out|sign ?out|switch account|delete account)\b/i],
  ['send', /^\s*send\s*$|\bsend (message|to)\b|^\s*(submit|post|publish|forward|reply)\s*$/i],
  ['invite-share', /\b(invite|share|copy link|add friend)\b/i],
  ['settings', /\b(settings?|toggle|enable|disable|mute|pin to top|permissions?|privacy|turn on|turn off)\b/i],
  ['profile-edit', /\b(edit profile|change (avatar|name|password)|save|confirm)\b/i],
];

/** Social state changes (follow / like / favourite …), with or without a count ("点赞, 12"). The same words
 *  also name list tabs ("关注", "点赞"): blocked anyway — real users must not see the agent's likes. */
const SOCIAL = /^\s*\+?\s*(关注|已关注|取消关注|关注 ?(TA|他|她)|点赞|已赞|赞|取消点赞|喜欢|收藏|已收藏|取消收藏|订阅|已订阅)\s*[,，:：]?\s*\d*\s*$|^\s*\+?\s*(follow(ing)?|unfollow|like[ds]?|unlike|favou?rite[ds]?|bookmark(ed)?|subscribed?|star(red)?)\s*[,:]?\s*\d*\s*$/i;
/** The model's own words for a coordinate tap ("右下角的爱心按钮"): any mention counts. */
const SOCIAL_WORDS = /关注|点赞|收藏|订阅|喜欢|爱心|心形|星标|\b(follow|like|heart|favou?rite|bookmark|star|subscribe)\b/i;

/** Hard constraints (G3): never, whatever the mode. */
const HARD = /删除|撤回|unsend|recall|\bdelete\b|锁屏|lock ?screen|密码|password/i;

const SEARCH = /搜索|search|查找|find/i;

/** Pure: the risk of an action on an element labelled `label` (typing: `text` is what would be typed;
 *  `free`: the label is the model's description of a coordinate tap). Social actions run only on the agent
 *  accounts' own profiles and content (`ownContent`, see nearOwnContent) — in writable runs too.
 *  `bench`: AndroidWorld on an emulator (W2-5 N9) — no real users, nothing is blocked. */
export function classifyRisk(a: { type: string; label?: string; text?: string; free?: boolean }, writable = false, ctx: { ownContent?: boolean; bench?: boolean } = {}): Risk {
  if (ctx.bench) return { blocked: false, reason: 'bench (emulator)' };
  const label = (a.label ?? '').trim();
  if (HARD.test(label) || (a.type === 'type' && HARD.test(a.text ?? '') && /密码|password/i.test(label))) return { blocked: true, category: label.match(/锁屏|lock/i) ? 'lock' : 'delete', reason: `硬约束：${label || a.type}` };
  const tapLike = a.type === 'tap' || a.type === 'longPress';
  if (tapLike && !ctx.ownContent && (SOCIAL.test(label) || (a.free && SOCIAL_WORDS.test(label)))) return { blocked: true, category: 'social', reason: `拦截「${label}」（social）：点赞 / 关注 / 收藏只对测试账号自己的主页和内容做` };
  if (writable) return { blocked: false, reason: 'writable' };
  if (a.type === 'type') {
    if (SEARCH.test(label)) return { blocked: false, reason: 'typing into a search box' };
    return { blocked: true, category: 'type', reason: `只读探索不键入（目标「${label || '未知输入框'}」）` };
  }
  if (!tapLike) return { blocked: false, reason: 'no target' };
  for (const [category, re] of [...ZH, ...EN]) if (re.test(label)) return { blocked: true, category, reason: `只读探索拦截「${label}」（${category}）` };
  return { blocked: false, reason: 'read-only safe' };
}

/** Pure: the tapped point belongs to the agent accounts' own content — one of their names (nickname, or an
 *  agent / post they made, `ownContent` in accounts.local.yaml) is on screen within a fifth of the screen
 *  height of it (a profile header, a post card). Conservative: a like bar far below the author line stays
 *  blocked. */
export function nearOwnContent(y: number, nodes: { label: string; y: number }[], names: string[], height: number): boolean {
  if (!names.length || !height) return false;
  const own = nodes.filter((n) => names.some((m) => n.label.includes(m)));
  return own.some((n) => Math.abs(n.y - y) <= height / 5);
}
