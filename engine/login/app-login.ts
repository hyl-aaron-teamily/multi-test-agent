// Sign-in of the Teamily app on a fresh device (W3-4 E1 ④: emulator preparation, before its snapshot).
// Elements are taken from the hierarchy (the app's login form exposes its fields and buttons with labels), the
// text goes in as key events (`input text`: an emulator has no Chinese IME to swallow them). The password is
// never logged. Not a test step: the result is the environment's starting state.
import { adb } from '../../core/adb';
import { dumpTree, type UiNode } from '../../core/ui-tree';
import { escapeAdbText } from '../../drivers/android';
import type { Credentials } from '../../platform/accounts/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (n: UiNode) => `${n.text} ${n.desc} ${n.hint}`;
const isEdit = (n: UiNode) => /EditText/.test(n.cls);

/** Pure: which login step the hierarchy shows. */
export function loginStep(ns: UiNode[]): 'email' | 'password' | 'none' {
  if (ns.some((n) => isEdit(n) && /password|密码/i.test(label(n)))) return 'password';
  if (ns.some((n) => isEdit(n) && /email|邮箱|@company/i.test(label(n)))) return 'email';
  return 'none';
}

/** Pure: the submit button of the form (Continue / Sign in / 继续 / 登录). */
export function submitButton(ns: UiNode[]): UiNode | undefined {
  return ns.find((n) => n.clickable && /^(continue|sign in|log in|next|继续|登录|下一步)$/i.test((n.desc || n.text).trim()));
}

const center = (n: UiNode) => `${Math.round((n.x1 + n.x2) / 2)} ${Math.round((n.y1 + n.y2) / 2)}`;

export async function loginApp(udid: string, pkg: string, cred: Credentials, log: (s: string) => void = () => {}): Promise<'signed-in' | 'logged-in'> {
  const sh = (c: string) => adb(['shell', c], udid, 20_000);
  const tree = () => dumpTree(udid, pkg).catch(() => [] as UiNode[]);
  let ns = await tree();
  if (loginStep(ns) === 'none') return 'signed-in';
  for (const step of ['email', 'password'] as const) {
    for (let i = 0; i < 10 && loginStep(ns) !== step; i++) {
      await sleep(1500);
      ns = await tree();
    }
    if (loginStep(ns) !== step) throw new Error(`login: the ${step} field did not appear`);
    const field = ns.find((n) => isEdit(n) && (step === 'email' ? /email|邮箱|@company/i : /password|密码/i).test(label(n)))!;
    await sh(`input tap ${center(field)}`);
    await sleep(600);
    await sh(`input text ${escapeAdbText(step === 'email' ? cred.email : cred.password)}`);
    await sleep(600);
    const btn = submitButton(await tree());
    if (btn) await sh(`input tap ${center(btn)}`);
    else await sh('input keyevent 66');
    log(`${step} entered${step === 'email' ? ` (${cred.email.replace(/^(.).*@/, '$1***@')})` : ''}`);
    await sleep(3000);
    ns = await tree();
  }
  for (let i = 0; i < 20; i++) {
    if (loginStep(ns) === 'none' && ns.length) return 'logged-in';
    await sleep(1500);
    ns = await tree();
  }
  throw new Error('login: still on the login form after the password');
}
