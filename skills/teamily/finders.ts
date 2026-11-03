// Teamily SKILL finders (refactor P3, replaces the offline calibrators): how to recognise each fixed element
// and each reference region on the live screen. Pure rules over the screen snapshot nodes (accessibility tree
// on Android, Playwright role locators on the web); a read-only CSS selector for web inputs without a role;
// a vision description as the last resort (icon-only controls). The rules carry what calibration learned
// (e.g. the Android send button has no label: the right-most button on the composer's toolbar row).
import type { Box } from '../../core/image';
import { label, type ScreenNode } from '../../core/screen-index';
import type { Surface } from '../../platform/accounts/types';

export interface Size {
  width: number;
  height: number;
}

export interface Finder {
  /** Label (text or accessibility description) of the element; its clickable container is used. */
  label?: RegExp;
  /** Geometry rule over the screen nodes. */
  pick?: (nodes: ScreenNode[], vp: Size) => ScreenNode | undefined;
  /** Web only: read-only CSS selector (bounding box of the last visible match). */
  selector?: string;
  /** Tier ③: what to ask the vision model for when the rules find nothing. */
  vision?: string;
}

type PerSurface = Partial<Record<Surface | 'web' | 'default', Finder>>;

const mobileBand = (n: ScreenNode | undefined, vp: Size, h?: number): Box | undefined => (n ? [0, n.box[1], vp.width, h ?? n.box[3]] : undefined);
const pad = (b: Box, p: number): Box => [b[0] - p, b[1] - p, b[2] + 2 * p, b[3] + 2 * p];
const byLabel = (nodes: ScreenNode[], re: RegExp) => nodes.find((n) => re.test(label(n)));
const ARTIFACT_CONTROLS = /^(更多操作|加入收藏|发送到聊天|筛选|通知|新建|新建子文档|查看全部|开启|网格视图|列表视图|收起侧边栏|搜索.*)$/;
const isEdit = (n: ScreenNode) => /EditText|textbox/i.test(n.cls) && !/^(搜索|Search)/i.test(label(n));
/** Phone browser: its own controls (address bar …) carry the browser's resource ids; the page's do not. */
const inPage = (n: ScreenNode) => !/^com\.android\.browser:id\//.test(n.rid ?? '');

export const FINDERS: Record<string, PerSurface> = {
  'login.email': { web: { selector: 'input[type=email]', vision: 'the email input field of the sign-in form' }, 'android-web': { pick: (ns) => ns.find((n) => isEdit(n) && /mail|邮箱/i.test(`${label(n)} ${n.rid}`)), vision: 'the email input field of the sign-in form' } },
  'login.emailContinue': { web: { label: /^(通过邮箱继续|Continue with Email)$/i, vision: 'the "Continue with Email" button' } },
  'login.password': { web: { selector: 'input[type=password]', vision: 'the password input field' }, 'android-web': { pick: (ns) => ns.find((n) => isEdit(n) && /password|密码/i.test(`${label(n)} ${n.rid}`)), vision: 'the password input field' } },
  'login.continue': { web: { label: /^(继续|Continue)$/i, vision: 'the "Continue" submit button of the password form' } },
  'onboarding.skip': { web: { label: /^(跳过|Skip)$/i, vision: 'the "Skip" button of the onboarding page' } },
  'popup.appBannerDismiss': { default: { label: /^(忽略|Ignore|Dismiss)$/i, vision: 'the "忽略" (Ignore) button of the "download the mobile app" dialog' } },
  'nav.chat': { default: { label: /^(\d+ )?(聊天|Chat)$/, vision: 'the 聊天 (Chat) entry of the navigation bar' } },
  'nav.artifacts': { default: { label: /^(Artifacts|成果)$/i, vision: 'the Artifacts entry of the navigation bar' } },
  'nav.me': { 'android-app': { label: /^(我的|我|Me)$/, vision: 'the avatar / "我的" (Me) entry that opens the user profile' }, default: { label: /^(我|我的|Me)$/, vision: 'the "我" (Me) entry of the navigation bar' } },
  'chatlist.search': { default: { label: /^(搜索|Search)$/, vision: 'the search box at the top of the conversation list' } },
  'chat.composer': {
    'android-app': { pick: (ns) => ns.filter(isEdit).sort((a, b) => b.box[1] - a.box[1])[0], vision: 'the message input box at the bottom of the chat' },
    web: { selector: '[contenteditable="true"], textarea', vision: 'the message input box of the chat' },
    // 2026-11-03: the address bar (an EditText too) was taken for the composer on a page without one.
    'android-web': { pick: (ns) => ns.filter((n) => isEdit(n) && inPage(n)).sort((a, b) => b.box[1] - a.box[1])[0], vision: 'the message input box of the chat' },
    default: { pick: (ns) => ns.filter(isEdit).sort((a, b) => b.box[1] - a.box[1])[0], vision: 'the message input box of the chat' },
  },
  'chat.send': {
    // The App's send button has no label: the right-most button on the composer's toolbar row (keyboard up).
    'android-app': {
      label: /^(发送|Send)$/,
      pick: (ns, vp) => {
        const comp = ns.filter(isEdit).sort((a, b) => b.box[1] - a.box[1])[0];
        if (!comp) return undefined;
        const y2 = comp.box[1] + comp.box[3];
        return ns.filter((n) => n.clickable && /Button/.test(n.cls) && !n.desc && n.box[0] > vp.width * 0.75 && n.box[1] >= y2 - 20 && n.box[1] < y2 + 250).sort((a, b) => b.box[0] + b.box[2] - (a.box[0] + a.box[2]))[0];
      },
      vision: 'the send button (arrow / paper plane) next to the message input',
    },
    default: { label: /^(发送|Send)$/, vision: 'the send button next to the message input' },
  },
  'chat.rewrite': { 'android-app': { label: /^((用记忆)?强化 ?prompt|改写|AI 改写|Rewrite|Enhance prompt( with memory)?)$/i, vision: 'the AI rewrite (sparkle "强化 prompt") button on the composer toolbar' } },
  'chat.rewriteCancel': { 'android-app': { label: /^(取消|Cancel)$/i, vision: 'the 取消 (Cancel) button of the "用记忆强化 prompt?" dialog' } },
  'chat.back': { default: { label: /^(返回|Back)$/, vision: 'the back arrow at the top left of the chat page' } },
  'profile.bell': { default: { label: /^(通知|Notifications?)$/i, vision: 'the 🔔 notification bell at the top right of the profile header' } },
  'artifacts.firstCard': {
    // 2026-11: cards have no "DOC" label any more; the card's title button is its only named part. The top-left
    // named button of the main area that is not one of the page's controls.
    'desktop-web': {
      pick: (ns) =>
        ns
          .filter((n) => /button|link/.test(n.cls) && n.box[0] > 330 && n.box[1] > 60 && label(n).length >= 4 && !ARTIFACT_CONTROLS.test(label(n)))
          .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])[0],
      vision: 'the title of the first document card in the Artifacts grid',
    },
    default: { label: /^DOC$/, vision: 'the first card of the Artifacts grid' },
  },
  'clouddoc.bell': { default: { vision: 'the 🔔 notification bell in the CloudDoc header, between help and the avatar' } },
  'artifacts.bell': { default: { label: /^(通知|Notifications?)$/i, vision: 'the 🔔 notification bell at the top right of the Artifacts page' } },
};

/** The finder of an element on a surface: surface-specific, then web (web surfaces), then default. */
export function finderFor(id: string, surface: Surface): Finder | undefined {
  const f = FINDERS[id];
  if (!f) return undefined;
  const web = surface === 'desktop-web' || surface === 'mobile-web' || surface === 'android-web';
  return f[surface] ?? (web && surface !== 'android-web' ? f.web : undefined) ?? f.default ?? (surface === 'android-web' ? f.web : undefined);
}

export interface RegionCtx {
  surface: Surface;
  vp: Size;
  nodes: ScreenNode[];
  /** Box of an element already located (anchors are resolved first). */
  el: (id: string) => Box | undefined;
}

export interface RegionSpec {
  /** Elements to locate before the box can be computed. */
  anchors: string[];
  box: (c: RegionCtx) => Box | undefined;
  /** Vision description when the anchors are not found by the rules (picker-like regions). */
  vision?: string;
}

const MOBILE = (s: Surface) => s !== 'desktop-web';

/** Reference regions (page/region): captured from the live screen the first time their anchors are seen. */
export const REGION_SPECS: Record<string, RegionSpec> = {
  // Home: the navigation bar around the chat entry (mobile: the whole bar; desktop: the entry).
  'home/nav': { anchors: ['nav.chat'], box: (c) => { const b = c.el('nav.chat'); return b && (MOBILE(c.surface) ? [0, b[1], c.vp.width, b[3]] : pad(b, 8)); } },
  // Chat: the composer's toolbar band under the input (stable, unlike the input's own text).
  'chat/composer': { anchors: ['chat.composer'], box: (c) => { const b = c.el('chat.composer'); return b && (MOBILE(c.surface) ? [0, b[1] + b[3], c.vp.width, 150] : [b[0], b[1] + b[3], b[2], 40]); } },
  // The "用记忆强化 prompt?" dialog: the smallest node holding 取消 and the confirm button, title above them.
  'rewrite-confirm/dialog': {
    anchors: ['chat.rewriteCancel'],
    box: (c) => {
      const cancel = byLabel(c.nodes, /^(取消|Cancel)$/i);
      const confirm = c.nodes.find((n) => n !== cancel && /^(强化|确定|确认|OK|Confirm|Enhance)$/i.test(label(n)) && cancel && Math.abs(n.box[1] - cancel.box[1]) < 60);
      if (!cancel || !confirm) return undefined;
      const cx2 = confirm.box[0] + confirm.box[2];
      const holder = c.nodes
        .filter((n) => n.box[0] <= cancel.box[0] && n.box[0] + n.box[2] >= cx2 && n.box[1] + n.box[3] >= cancel.box[1] + cancel.box[3] && n.box[1] < cancel.box[1] - 100 && n.box[2] < c.vp.width)
        .sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3])[0];
      return holder?.box ?? [Math.min(cancel.box[0], confirm.box[0]) - 40, cancel.box[1] - 360, Math.max(cancel.box[0] + cancel.box[2], cx2) - Math.min(cancel.box[0], confirm.box[0]) + 80, cancel.box[3] + 400];
    },
  },
  // The member / agent picker after typing "@": the band of its "所有人" (everyone) row.
  'mention-picker/picker': {
    anchors: [],
    box: (c) => {
      const all = c.nodes.find((n) => /^(所有人|Everyone|All)$/i.test(label(n)));
      return all && (MOBILE(c.surface) ? mobileBand(all, c.vp) : pad(all.box, 8));
    },
    vision: 'the member / agent picker list that opened after typing @',
  },
  'login/form': { anchors: ['login.email'], box: (c) => { const b = c.el('login.email'); return b && pad(b, 12); } },
  'banner/dismiss': { anchors: ['popup.appBannerDismiss'], box: (c) => c.el('popup.appBannerDismiss') },
  'artifacts/nav': { anchors: ['nav.artifacts'], box: (c) => { const b = c.el('nav.artifacts'); return b && pad(b, 8); } },
};

/** Region spec of a key; `page/element:<id>` = the element's own box. */
export function regionSpec(key: string): RegionSpec | undefined {
  const m = key.match(/^[^/]+\/element:(.+)$/);
  if (m) return { anchors: [m[1]], box: (c) => c.el(m[1]) };
  return REGION_SPECS[key];
}
