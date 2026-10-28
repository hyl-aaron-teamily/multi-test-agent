// Teamily SKILL trigger-pattern library (W2-1 §5.2): each pattern = trigger semantics + needed
// preconditions + observation + plan fragment builder. Moved verbatim from issue/planner.ts#templateFor
// (golden: issue/__golden__/templates.json); the contract stage selects patterns by id, the legacy text
// signal stays for rule-only drafting.
import type { Category, PlannedAction, Surface, TestPlan } from '../../platform/schema/test-plan';
import { TARGET_GUIDANCE } from './vocab';

export type PlanFragment = Pick<TestPlan, 'targets' | 'setup' | 'actions' | 'checks'> & { prepare?: TestPlan['prepare']; prepareCheck?: TestPlan['prepareCheck']; afterCheck?: TestPlan['afterCheck']; acceptance?: TestPlan['acceptance']; epilogue?: TestPlan['epilogue']; maxRounds?: number; title: string };

export interface Pattern {
  id: string;
  /** Trigger semantics id (contract.trigger.semantics). */
  trigger: string;
  /** Observation id the pattern's checks implement (contract.observable.observation). */
  observation: string;
  /** Precondition ids the pattern establishes (targets / prepare). */
  needs: string[];
  categories: Category[];
  /** Only for feature acceptance. */
  featureOnly: boolean;
  /** Legacy text signal (lower-cased sub-case text) used when drafting without a contract. */
  signal: (t: string) => boolean;
  surfaces?: Surface[];
  build: (surface: Surface, params?: Record<string, unknown>) => PlanFragment;
}

const a = (type: PlannedAction['type'], extra: Partial<PlannedAction> = {}): PlannedAction => ({ type, delayAfterMs: 300, ...extra });
const node = (name: string, input: Record<string, unknown> = {}, delayAfterMs = 300): PlannedAction => ({ type: 'node', node: { name, input }, delayAfterMs });
const T = TARGET_GUIDANCE;

export const PATTERNS: Pattern[] = [
  {
    id: 'notification-inventory',
    trigger: 'open-pages-inventory',
    observation: 'element',
    needs: [],
    categories: ['feature'],
    featureOnly: true,
    signal: (t) => /bell|🔔|notification entr|通知入口|notification center/.test(t),
    build: (surface) => {
    const pages = surface === 'android-app' ? [] : (['profile', 'artifacts'] as const);
    return {
      title: '通知入口盘点（一次性验收）',
      targets: [],
      setup: [],
      actions: [],
      checks: [],
      acceptance: [
        ...pages.map((p) => ({
          id: `no-separate-bell-${p}`,
          text: `${p === 'profile' ? '个人主页' : 'Artifacts 页'}不再有独立维护未读状态的 🔔 入口（统一到单一通知中心）`,
          actions: [node('teamily.openPage', { page: p }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 })],
          check: { kind: 'visual-region' as const, page: p, region: 'element:' + `${p}.bell`, expect: `${p} 页头部仍有独立 🔔`, want: 'absent' as const },
        })),
        ...(surface === 'desktop-web'
          ? [
              {
                id: 'no-separate-bell-clouddoc',
                text: 'CloudDoc / 交付物文档头部不再有独立维护未读状态的 🔔 入口（统一到单一通知中心）',
                actions: [node('teamily.openPage', { page: 'artifacts' }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 }), { type: 'tap' as const, element: 'artifacts.firstCard', delayAfterMs: 1000 }, a('wait', { value: '1000', delayAfterMs: 1000 }), a('wait', { value: '1000', delayAfterMs: 1000 }), a('wait', { value: '1000', delayAfterMs: 1000 })],
                check: { kind: 'visual-region' as const, page: 'clouddoc', region: 'element:clouddoc.bell', expect: 'CloudDoc 头部仍有独立 🔔', want: 'absent' as const },
              },
            ]
          : []),
        {
          id: 'single-center',
          text: '存在一个汇总所有模块通知、共享同一未读状态的通知中心入口',
          actions: [a('back', { delayAfterMs: 1000 }), node('teamily.openPage', { page: 'chat' }, 1000)],
          check: { kind: 'ai' as const, expect: 'The far-left global navigation rail (the narrow icon column at the left edge) contains a bell-shaped (🔔) notification icon. Answer false if no bell-shaped icon is in that rail; gift, memory, download or other icons do not count', want: 'present' as const, onlyOnAnomaly: false },
        },
      ],
    };
    },
  },
  {
    id: 'mention-aggregation',
    trigger: 'view-mention-aggregation',
    observation: 'visual-question',
    needs: ['muted-group-with-mention'],
    categories: ['feature'],
    featureOnly: true,
    signal: (t) => /mention|@/.test(t),
    build: (surface) => {
    return {
      title: '@我 聚合入口 / 免打扰群 @ 提示（单账号可验部分）',
      targets: [{ id: 'mutedGroup', kind: 'muted-group', guidance: '会话列表里带免打扰（划线铃铛）图标、且预览中出现 “@” 的群' }],
      setup: [],
      actions: [],
      checks: [],
      acceptance: [
        {
          id: 'mentions-entry',
          text: '存在 “@我 / Mentions” 聚合入口（列出所有 @ 我的消息）',
          actions: [node('teamily.openPage', { page: 'chat' }, 1000)],
          check: { kind: 'ai', expect: 'There is a visible entry named like "@我", "Mentions" or "提及" that lists messages mentioning the user', want: 'present', onlyOnAnomaly: false },
        },
        {
          id: 'muted-mention-badge',
          text: '免打扰群被 @ 时，会话列表有显著提示（角标/徽标，而不只是小号绿色 “[有人@你]” 文本）',
          actions: [],
          check: { kind: 'ai', expect: 'In the conversation list, the muted group row that mentions the user shows a prominent badge (a count or @ badge on the avatar or at the right side), not only small green preview text', want: 'present', onlyOnAnomaly: false },
        },
      ],
    };
    },
  },
  {
    // 2010: the AI rewrite control replaces the typed draft without confirmation / undo. Each round types a
    // draft carrying the run token and round, checks it really is in the input (round precondition), taps
    // rewrite and reads the input (①): still exactly the draft = normal; anything else = the draft was
    // replaced (a rewrite may quote the draft, so "contains" would miss it). Personal AI: nothing is sent.
    id: 'composer-rewrite',
    trigger: 'tap-rewrite-with-draft',
    observation: 'text',
    needs: ['other-conversation', 'composer-draft'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse'],
    featureOnly: false,
    signal: (t) => /\brewrite|改写|强化 ?prompt/.test(t),
    surfaces: ['android-app'],
    build: () => {
      const draft = 'autotest-2010 {token} {round}';
      return {
        title: '点 AI 改写后输入框草稿应保留（或先确认 / 可撤销）',
        targets: [{ id: 'conv', kind: 'other-conversation', guidance: "the user's own Personal AI conversation (nothing is sent; disturbs no one)" }],
        setup: [node('teamily.openConversation', { target: 'conv' }, 1000)],
        actions: [node('teamily.clearComposer', {}, 300), a('type', { value: draft, delayAfterMs: 500 }), a('require', { requires: { composerHas: draft }, delayAfterMs: 0 }), node('teamily.tapRewrite', {}, 300)],
        checks: [{ kind: 'text', scope: 'composer', match: { exact: draft }, expect: '点击改写后输入框仍是原草稿（没有被静默替换）', want: 'present' }],
        afterCheck: [],
        maxRounds: 6,
      };
    },
  },
  {
    // 1903: a sent message that @-mentions a member must show the mention in its bubble (a separate mention
    // node on Android). Each round (allow-listed group, test accounts only): text with the run token and round
    // → "@" → the member row frozen at preparation → the input must hold "@member" (round precondition) →
    // send → read the newest bubble carrying this round's text (①). Once at the end: the list preview.
    id: 'mention-render',
    trigger: 'send-message-with-mention',
    observation: 'text',
    needs: ['group-conversation', 'group-member-mentioned'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse'],
    featureOnly: false,
    signal: (t) => /(mention|@).{0,80}(not rendered|bubble|渲染|气泡)|(bubble|气泡).{0,80}(mention|@)/.test(t),
    surfaces: ['android-app'],
    build: (_surface, params = {}) => {
      const conv = String(params.conversation ?? '');
      const member = String(params.member ?? '') || 'aaron+test2';
      const text = 'autotest-1903 {token} {round}';
      return {
        title: '发送带 @ 的消息后气泡里应显示 @成员名',
        targets: [{ id: 'conv', kind: 'group-conversation', guidance: conv ? `the conversation titled "${conv}" (titles may be cut short with …)` : 'a group conversation whose members are all test accounts' }],
        setup: [node('teamily.openConversation', { target: 'conv' }, 1000)],
        prepare: [node('teamily.freezeMention', { member, as: 'member' }, 500)],
        actions: [
          node('teamily.clearComposer', {}, 300),
          a('type', { value: `${text} `, delayAfterMs: 300 }),
          a('type', { value: '@', delayAfterMs: 1000 }),
          a('wait', { value: '1000', delayAfterMs: 0 }),
          a('tap', { element: 'target.member', delayAfterMs: 800 }),
          a('require', { requires: { composerHas: `@${member}` }, delayAfterMs: 0 }),
          node('teamily.tapSend', {}, 1000),
          a('wait', { value: '1000', delayAfterMs: 1000 }),
        ],
        checks: [{ kind: 'text', scope: { message: text }, match: { exact: `@${member}` }, expect: `已发送气泡里显示 @${member}（独立的 @ 提及）`, want: 'present' }],
        afterCheck: [],
        epilogue: { actions: [a('tap', { element: 'chat.back', delayAfterMs: 1000 }), a('wait', { value: '1000', delayAfterMs: 1000 })], check: { kind: 'text', scope: { message: 'autotest-1903 {token}' }, match: { contains: `@${member}` }, expect: `会话列表预览里有 @${member}`, want: 'present' } },
        maxRounds: 6,
      };
    },
  },
  {
    id: 'mention-picker',
    trigger: 'repeat-switch-and-mention',
    observation: 'region',
    needs: ['group-conversation','other-conversation'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse', 'feature'],
    featureOnly: false,
    signal: (t) => /@|mention|picker|selector|选择器/.test(t),
    build: (surface) => {
    return {
      title: '@ 成员选择器弹出（切换会话后循环）',
      targets: [
        { id: 'group', kind: 'group-conversation', guidance: T['group-conversation'] },
        { id: 'other', kind: 'other-conversation', guidance: T['other-conversation'] },
      ],
      setup: [node('teamily.openConversation', { target: 'group' }, 800)],
      actions: [node('teamily.clearComposer', {}, 200), node('teamily.openConversation', { target: 'other' }, 500), node('teamily.openConversation', { target: 'group' }, 700), node('teamily.typeMention', {}, 700)],
      checks: [
        { kind: 'visual-region', page: 'mention-picker', region: 'picker', expect: '输入 @ 后成员/智能体选择器弹出', want: 'present', onlyOnAnomaly: true, requires: { composerHas: '@' } },
        { kind: surface === 'android-app' ? 'crash' : 'page-error', expect: '无崩溃 / 页面错误', want: 'absent' },
      ],
    };
    },
  },
  {
    // 2044 family: a quoted message whose content is Markdown link syntax must show as display text in the
    // quote block preview, not as raw "[label](url)". The precondition is constructed (prepare) in an
    // allow-listed conversation (D5); the observation reads the quote cards' text (① accessibility).
    id: 'quote-preview-text',
    trigger: 'view-quote-preview',
    observation: 'text',
    needs: ['quoted-message-with-markdown-link'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse'],
    featureOnly: false,
    signal: (t) => /quote (block )?preview|quote block|引用块|markdown/.test(t),
    build: (surface, params = {}) => {
      const url = String(params.url ?? 'https://github.com/TensorOpera-Inc/chat-web/pull/654');
      const conv = String(params.conversation ?? '');
      const tag = String(params.tag ?? 'autotest-2044');
      return {
        title: '引用块预览应显示链接文本而不是 Markdown 源码',
        targets: [{ id: 'conv', kind: 'group-conversation', guidance: conv ? `the conversation titled "${conv}" (titles may be cut short with …)` : 'a group conversation whose members are all test accounts' }],
        setup: [node('teamily.openConversation', { target: 'conv' }, 1000)],
        // Construct once: a message in Markdown link syntax, then a quote-reply to it.
        prepare: [node('teamily.sendMessage', { text: url, kind: 'markdown-link' }, 1000), node('teamily.quoteReply', { quote: url.replace(/^https?:\/\//, ''), text: `${tag} quote` }, 1000)],
        prepareCheck: { kind: 'text', scope: 'quote-cards', match: { contains: url.replace(/^https?:\/\//, '').slice(0, 30) }, expect: '会话里出现引用了该链接消息的引用块', want: 'present' },
        // Each round: leave and reopen the conversation, then read the newest quote block.
        actions: [...(surface === 'desktop-web' ? [] : [a('tap', { element: 'chat.back', delayAfterMs: 900 })]), node('teamily.openConversation', { target: 'conv' }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 })],
        checks: [{ kind: 'text', scope: 'quote-cards', match: { regex: '\\]\\(https?://' }, expect: '引用块预览不出现 Markdown 链接语法 [..](..)（链接只显示一次）', want: 'absent' }],
      };
    },
  },
  {
    id: 'quote-jump',
    trigger: 'tap-quote',
    observation: 'quoted-original',
    needs: ['group-conversation','quote-reply-exists'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse', 'feature'],
    featureOnly: false,
    signal: (t) => /location link|jumps? to|定位|跳转|message link/.test(t),
    build: (surface, params = {}) => {
    // A quote card (reply with quote) is a location link back to the quoted message. Round 1 checks the
    // first jump really shows the quoted original and keeps that screen; later rounds must land there too.
    // With an allow-listed conversation (params.conversation) the precondition is constructed: a plain
    // message and a quote-reply to it; otherwise an existing quote reply is used.
    const conv = String(params.conversation ?? '');
    const src = String(params.source ?? 'autotest-quote-source 1329');
    return {
      title: '点引用定位应稳定跳到被引用消息',
      targets: [
        { id: 'conv', kind: 'group-conversation', guidance: conv ? `the conversation titled "${conv}" (titles may be cut short with …)` : T['group-conversation'] },
        { id: 'link', kind: 'quote-card', guidance: '会话底部最近的一条引用回复里的引用块（左侧竖线 + 原发送人 + 原文；引用的是普通文字，不是链接 / URL）', ...(conv ? { afterPrepare: true } : {}) },
      ],
      setup: [node('teamily.openConversation', { target: 'conv' }, 1000)],
      ...(conv ? { prepare: [node('teamily.sendMessage', { text: src }, 1000), node('teamily.quoteReply', { quote: src, text: 'autotest-quote-reply 1329' }, 1000)] } : {}),
      actions: [{ type: 'tap', element: 'target.link', delayAfterMs: 1000 }, a('wait', { value: '1000', delayAfterMs: 1000 })],
      checks: [{ kind: 'baseline', expect: '点引用块后跳到被引用的原消息（每轮落在同一位置）', want: 'present' }],
      afterCheck: [...(surface === 'desktop-web' ? [] : [a('tap', { element: 'chat.back', delayAfterMs: 900 })]), node('teamily.openConversation', { target: 'conv' }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 })],
    };
    },
  },
  {
    id: 'keyboard-single-tap',
    trigger: 'tap-composer-once',
    observation: 'keyboard-shown',
    needs: ['group-conversation'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse', 'feature'],
    featureOnly: false,
    signal: (t) => /keyboard|键盘/.test(t),
    build: (surface) => {
    return {
      title: '点一次输入框键盘即弹出',
      targets: [{ id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] }],
      setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
      // chat.back (the on-screen button): the back KEY would only close the keyboard.
      actions: surface === 'desktop-web' ? [a('tap', { element: 'chatlist.search', delayAfterMs: 500 }), node('teamily.openConversation', { target: 'conv' }, 700), a('tap', { element: 'chat.composer', delayAfterMs: 800 })] : [a('tap', { element: 'chat.back', delayAfterMs: 700 }), node('teamily.openConversation', { target: 'conv' }, 900), a('tap', { element: 'chat.composer', delayAfterMs: 900 })],
      // Phones: system state (dumpsys input_method, ①); elsewhere the vision model (③).
      checks: [surface === 'android-app' || surface === 'android-web' ? { kind: 'keyboard', expect: 'The on-screen keyboard is shown after a single tap on the message input', want: 'present' } : { kind: 'ai', expect: 'The on-screen keyboard is shown after a single tap on the message input', want: 'present', onlyOnAnomaly: false }],
    };
    },
  },
  {
    id: 'like-visible',
    trigger: 'like-message',
    observation: 'visual-question',
    needs: ['group-conversation','others-text-message'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse', 'feature'],
    featureOnly: false,
    signal: (t) => /like|点赞|reaction/.test(t),
    build: (surface) => {
    return {
      title: '点赞后立即可见',
      targets: [
        { id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] },
        { id: 'msg', kind: 'others-text-message', guidance: T['others-text-message'] },
        { id: 'like', kind: 'like-action', guidance: '长按消息后出现的点赞 "👍" 表情按钮' },
      ],
      setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
      actions: [{ type: 'longPress', element: 'target.msg', delayAfterMs: 900 }, { type: 'tap', element: 'target.like', delayAfterMs: 1000 }],
      // Android App: the reaction is an accessible "👍" node right under the message (verified on device
      // 2026-10-26) → ① text near the target; other surfaces: the vision model.
      checks: [surface === 'android-app' ? { kind: 'text', match: { exact: '👍' }, scope: { target: 'msg', within: 160 }, expect: 'The liked message shows a like / 👍 reaction under it', want: 'present' } : { kind: 'ai', expect: 'The liked message shows a like / 👍 reaction under it', want: 'present', onlyOnAnomaly: false }],
      // Toggle back so every round starts from "not liked".
      afterCheck: [{ type: 'longPress', element: 'target.msg', delayAfterMs: 900 }, { type: 'tap', element: 'target.like', delayAfterMs: 1000 }],
    };
    },
  },
  {
    // Leave the app (Home) → wait in the background → [kill its process → wait] → launch again (was only in
    // scripts/m5.ts lifecycle smoke). params: mode warm|cold, idle ms. App: warm comes back on the chat page,
    // cold starts on the home screen; browser: warm keeps the conversation, cold reloads and reopens it.
    id: 'lifecycle',
    trigger: 'background-and-return',
    observation: 'process-alive',
    needs: ['other-conversation'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse'],
    featureOnly: false,
    signal: () => false,
    surfaces: ['android-app', 'android-web'],
    build: (surface, params = {}) => {
      const mode = params.mode === 'cold' ? 'cold' : 'warm';
      const idle = String(Number(params.idle ?? 5000));
      const web = surface === 'android-web';
      const conv = String(params.target ?? 'conv');
      const actions: PlannedAction[] = [
        a('exitApp', { delayAfterMs: 300 }),
        a('idle', { value: idle, delayAfterMs: 0 }),
        ...(mode === 'cold' ? [a('killApp', { delayAfterMs: 300 }), a('idle', { value: idle, delayAfterMs: 0 })] : []),
        a('launch', { delayAfterMs: 1000 }),
        // The page loads over the network after a cold browser start.
        web && mode === 'cold' ? a('idle', { value: '15000', delayAfterMs: 0 }) : a('wait', { value: '1000', delayAfterMs: 0 }),
      ];
      return {
        title: web
          ? mode === 'cold' ? '离开浏览器 → 后台等待 → 杀浏览器进程 → 等待 → 重新打开网址（应重新加载并回到上次的会话）' : '离开浏览器 → 后台等待 → 回到浏览器（应仍在原会话）'
          : mode === 'cold' ? '退出 App → 后台等待 → 杀进程 → 等待 → 冷启动（应回到首页且进程新建）' : '退出 App → 后台等待 → 重新打开（应恢复到原聊天页）',
        targets: [{ id: conv, kind: 'other-conversation', guidance: String(params.guidance ?? "the user's own Personal AI conversation (disturbs no one)") }],
        setup: [node('teamily.openConversation', { target: conv }, 1000)],
        actions,
        checks: [
          { kind: 'process-alive', expect: 'App 进程在重新打开后存在', want: 'present' },
          mode === 'cold' && !web
            ? { kind: 'visual-region', page: 'home', region: 'nav', expect: '冷启动后回到首页（底栏可见）', want: 'present' }
            : { kind: 'visual-region', page: 'chat', region: 'composer', expect: '热启动后恢复到原聊天页（输入框可见）', want: 'present' },
        ],
        // cold: the next round starts from the chat page again
        afterCheck: mode === 'cold' && !web ? [node('teamily.openConversation', { target: conv }, 1000)] : [],
      };
    },
  },
  {
    id: 'generic-browse',
    trigger: 'browse-history',
    observation: 'crash',
    needs: ['group-conversation'],
    categories: ['bug-always', 'bug-intermittent', 'suspected-misuse', 'feature'],
    featureOnly: false,
    signal: () => true,
    build: (surface) => {
    return {
    title: '按步骤执行并核对预期',
    targets: [{ id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] }],
    setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
    // Loop without side effects for other people (no sending): reopen + scroll the history.
    actions: [...(surface === 'desktop-web' ? [] : [a('tap', { element: 'chat.back', delayAfterMs: 700 })]), node('teamily.openConversation', { target: 'conv' }, 900), a('scroll', { value: 'up', delayAfterMs: 700 }), a('scroll', { value: 'down', delayAfterMs: 700 })],
    checks: [{ kind: surface === 'android-app' ? 'crash' : 'page-error', expect: '无崩溃 / 页面错误', want: 'absent' }],
  };
    },
  },];

export const GENERIC_PATTERN = 'generic-browse';
export const patternById = (id: string) => PATTERNS.find((p) => p.id === id);

/** Pure: the pattern a (sub-)case text selects (legacy rule path; first matching signal wins). */
export function patternForText(text: string, category: Category): Pattern {
  const t = text.toLowerCase();
  return PATTERNS.find((p) => p.categories.includes(category) && (!p.featureOnly || category === 'feature') && p.signal(t)) ?? patternById(GENERIC_PATTERN)!;
}
