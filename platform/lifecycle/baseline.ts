// Baseline (W2-3 §3.3): the checkable definition of a "clean" environment, and the recovery actions that
// bring it back. Check and fix are the same walk (fix=false only looks), so a recovery is just
// `walk(fix) → walk(check)` and can be repeated or cut short and repeated (G7). Never deletes or recalls a
// message (hard rule): a touched conversation only gets its input box emptied.
// The walk reads the accessibility tree — it runs outside any test loop.
import type { BaselineItem, ConfigItem, EnvRecord } from './env';

/** What the walk needs from an Android phone (adb in production, a fake in tests). */
export interface AndroidBaselineDriver {
  online(): Promise<boolean>;
  screen(): Promise<{ awake: boolean; locked: boolean }>;
  wake(): Promise<void>;
  /** Where the app under test is: its home list, a chat page, a popup / picker over it, or another app. */
  where(): Promise<'home' | 'chat' | 'popup' | 'foreign' | 'unknown'>;
  back(): Promise<void>;
  restartApp(): Promise<void>;
  /** Open a conversation from the home list by its name; false when not found. */
  openConversation(name: string): Promise<boolean>;
  /** The chat page's input box text ('' = empty), null = unreadable. */
  composer(): Promise<string | null>;
  clearComposer(): Promise<void>;
  keyboard(): Promise<boolean | null>;
  hideKeyboard(): Promise<void>;
  ime(): Promise<string | undefined>;
  setIme(id: string): Promise<void>;
  configOk(c: ConfigItem): Promise<{ ok: boolean; detail: string }>;
  applyConfig(c: ConfigItem): Promise<void>;
  /** Leftover helper processes on the phone (yadb, uiautomator dump, input). */
  residual(): Promise<string[]>;
  killResidual(): Promise<void>;
  /** Is the app under test (the browser for android-web) running? */
  appRunning?(): Promise<boolean>;
  /** End the app under test (force-stop). */
  stopApp?(): Promise<void>;
  /** versionName of the app under test, if readable. */
  appVersion?(): Promise<string | undefined>;
}

/** Host side of an environment (both kinds): the last task's process tree and its leftovers. */
export interface HostBaselineDriver {
  /** Processes of the last task still running (descriptions). */
  taskProcesses(): Promise<string[]>;
  killTaskProcesses(): Promise<void>;
  /** Web: the signed-in session file is valid. */
  sessionOk?(): Promise<{ ok: boolean; detail: string }>;
}

export interface Walk {
  items: BaselineItem[];
  /** Fix actions taken (in order). */
  did: string[];
  ok: boolean;
  /** No fix can make it pass without a person: 'locked' | 'offline' (→ unfit), else undefined. */
  blocker?: 'locked' | 'offline';
}

const item = (id: string, ok: boolean, detail: string, auto = true): BaselineItem => ({ id, ok, detail, auto });

/** One configuration item: check, apply when fixing, check again. An optional item (the tree service) that
 *  stays unmet — or whose apply fails — leaves the environment usable (degraded), never unfit. */
async function configWalk(d: AndroidBaselineDriver, c: ConfigItem, fix: boolean, did: string[]): Promise<BaselineItem> {
  let r = await d.configOk(c);
  let err = '';
  // An optional item (installing the tree service) is applied only after its one-time consent.
  if (!r.ok && fix && c.optional && !c.consentedAt) err = '；待同意，未应用';
  else if (!r.ok && fix) {
    try {
      await d.applyConfig(c);
      did.push(`按声明重写 ${c.id}：${c.what}`);
    } catch (e) {
      if (!c.optional) throw e;
      const lines = (e as Error).message.split('\n');
      err = `；应用失败：${(lines.find((l) => /Failure|失败|没有/.test(l)) ?? lines[0]).trim().slice(0, 160)}`;
      // A recovery reports its follow-up check walk: keep the reason with its actions too.
      did.push(`${c.id} 未能应用${err.slice(1)}`);
    }
    r = await d.configOk(c);
  }
  if (r.ok || !c.optional) return item(`config:${c.id}`, r.ok, r.detail);
  return { ...item(`config:${c.id}`, true, `${r.detail}${err}（可选项未生效：读树退回 uiautomator）`), ...(!fix && c.consentedAt ? { pending: true } : {}) };
}

/** Conversations the last task typed into (ledger), each once. Clearing the input leaves no draft: not a touch. */
export const touchedConversations = (ledger: { kind: string; target?: string; value?: string }[]) => [...new Set(ledger.filter((l) => (l.kind === 'type' || l.kind === 'send') && l.target && l.value !== 'clearComposer').map((l) => l.target!))];

/** The android-app walk. `touched` = conversations typed into by the last task. */
export async function walkAndroid(d: AndroidBaselineDriver, env: Pick<EnvRecord, 'configItems' | 'ime'>, touched: string[], fix: boolean, host?: HostBaselineDriver): Promise<Walk> {
  const items: BaselineItem[] = [];
  const did: string[] = [];
  const end = (blocker?: Walk['blocker']): Walk => ({ items, did, ok: items.every((i) => i.ok), blocker });

  if (host) {
    let procs = await host.taskProcesses();
    if (procs.length && fix) {
      await host.killTaskProcesses();
      did.push(`结束上一任务残留进程：${procs.join(', ')}`);
      procs = await host.taskProcesses();
    }
    items.push(item('host-processes', !procs.length, procs.length ? `上一任务进程仍在：${procs.join(', ')}` : '无上一任务的残留进程'));
  }
  if (!(await d.online())) {
    items.push(item('online', false, '设备不在线（adb 不可达）', false));
    return end('offline');
  }
  items.push(item('online', true, 'adb 在线'));

  let s = await d.screen();
  if (!s.awake && fix) {
    await d.wake();
    did.push('唤醒屏幕');
    s = await d.screen();
  }
  if (s.locked) {
    items.push(item('screen', false, '锁屏（有 PIN，需人工解锁）', false));
    return end('locked');
  }
  items.push(item('screen', s.awake, s.awake ? '屏幕亮、未锁屏' : '屏幕未亮'));

  let res = await d.residual();
  if (res.length && fix) {
    await d.killResidual();
    did.push(`结束残留进程：${res.join(', ')}`);
    res = await d.residual();
  }
  items.push(item('residual', !res.length, res.length ? `残留进程：${res.join(', ')}` : '无残留进程（yadb / uiautomator / input）'));

  // The chat left open (an abnormal exit usually stops inside it): its input box first, whatever its title.
  if ((await d.where()) === 'chat') {
    let t = await d.composer();
    if (t && fix) {
      await d.clearComposer();
      did.push(`清空当前打开会话的输入框（原有「${t.slice(0, 30)}${t.length > 30 ? '…' : ''}」）`);
      t = await d.composer();
    }
    if (t !== null) items.push(item('composer:当前会话', t === '', t ? `当前打开会话的输入框不为空：「${t.slice(0, 40)}」` : '当前打开会话的输入框为空'));
  }

  // Touched conversations: input box empty (opened from the home list by name).
  for (const name of touched) {
    if ((await d.where()) !== 'home') await toHome(d, fix ? did : []);
    if (!(await d.openConversation(name))) {
      items.push(item(`composer:${name}`, false, `会话「${name}」未在首页找到，输入框无法检查`));
      continue;
    }
    let t = await d.composer();
    if (t && fix) {
      await d.clearComposer();
      did.push(`清空会话「${name}」的输入框（原有「${t.slice(0, 30)}${t.length > 30 ? '…' : ''}」）`);
      t = await d.composer();
    }
    items.push(item(`composer:${name}`, t === '', t === null ? `会话「${name}」输入框读不出` : t ? `会话「${name}」输入框不为空：「${t.slice(0, 40)}」` : `会话「${name}」输入框为空`));
    if ((await d.keyboard()) === true) await d.hideKeyboard();
    await d.back();
  }

  let kb = await d.keyboard();
  if (kb === true && fix) {
    await d.hideKeyboard();
    did.push('收起键盘');
    kb = await d.keyboard();
  }
  items.push(item('keyboard', kb !== true, kb === true ? '键盘弹出' : '键盘收起'));

  let w = await d.where();
  if (w !== 'home' && fix) {
    await toHome(d, did);
    w = await d.where();
  }
  items.push(item('app-home', w === 'home', w === 'home' ? '被测 App 在前台、在首页、无弹层' : `被测 App 不在首页（${w}）`));

  if (env.ime) {
    let ime = await d.ime();
    if (ime !== env.ime && fix) {
      await d.setIme(env.ime);
      did.push(`切回默认输入法 ${env.ime}（原 ${ime ?? '?'}）`);
      ime = await d.ime();
    }
    items.push(item('ime', ime === env.ime, `输入法 ${ime ?? '?'}${ime === env.ime ? '（声明的默认）' : `，应为 ${env.ime}`}`));
  }
  for (const c of env.configItems) items.push(await configWalk(d, c, fix, did));
  return end();
}

/** The android-web walk (phone browser). The browser's accessibility tree does not follow in-page navigation,
 *  so a touched conversation's input box cannot be read reliably: the browser is ended instead (every task
 *  starts it cold), and the touched conversations are listed as not individually checked. Phone-side items
 *  (online, screen, leftover processes, keyboard, input method, configuration items) are the same as the App's. */
export async function walkAndroidWeb(d: AndroidBaselineDriver, env: Pick<EnvRecord, 'configItems' | 'ime'>, touched: string[], fix: boolean, host?: HostBaselineDriver): Promise<Walk> {
  const items: BaselineItem[] = [];
  const did: string[] = [];
  const end = (blocker?: Walk['blocker']): Walk => ({ items, did, ok: items.every((i) => i.ok), blocker });

  if (host) {
    let procs = await host.taskProcesses();
    if (procs.length && fix) {
      await host.killTaskProcesses();
      did.push(`结束上一任务残留进程：${procs.join(', ')}`);
      procs = await host.taskProcesses();
    }
    items.push(item('host-processes', !procs.length, procs.length ? `上一任务进程仍在：${procs.join(', ')}` : '无上一任务的残留进程'));
  }
  if (!(await d.online())) {
    items.push(item('online', false, '设备不在线（adb 不可达）', false));
    return end('offline');
  }
  items.push(item('online', true, 'adb 在线'));

  let s = await d.screen();
  if (!s.awake && fix) {
    await d.wake();
    did.push('唤醒屏幕');
    s = await d.screen();
  }
  if (s.locked) {
    items.push(item('screen', false, '锁屏（有 PIN，需人工解锁）', false));
    return end('locked');
  }
  items.push(item('screen', s.awake, s.awake ? '屏幕亮、未锁屏' : '屏幕未亮'));

  let res = await d.residual();
  if (res.length && fix) {
    await d.killResidual();
    did.push(`结束残留进程：${res.join(', ')}`);
    res = await d.residual();
  }
  items.push(item('residual', !res.length, res.length ? `残留进程：${res.join(', ')}` : '无残留进程（yadb / uiautomator / input）'));

  let kb = await d.keyboard();
  if (kb === true && fix) {
    await d.hideKeyboard();
    did.push('收起键盘');
    kb = await d.keyboard();
  }
  items.push(item('keyboard', kb !== true, kb === true ? '键盘弹出' : '键盘收起'));

  if (d.appRunning && d.stopApp) {
    let running = await d.appRunning();
    if (running && fix) {
      await d.stopApp();
      did.push('结束手机浏览器（下一任务冷启动）');
      running = await d.appRunning();
    }
    items.push(item('browser-closed', !running, running ? '手机浏览器仍在运行（页面停在上一任务留下的位置）' : '手机浏览器已结束，下一任务冷启动'));
  }
  if (touched.length) items.push(item('drafts', true, `上一任务键入过的会话：${touched.join('、')}——浏览器已结束，未逐个打开核对输入框（浏览器无障碍树不随页面内跳转更新）`));

  if (env.ime) {
    let ime = await d.ime();
    if (ime !== env.ime && fix) {
      await d.setIme(env.ime);
      did.push(`切回默认输入法 ${env.ime}（原 ${ime ?? '?'}）`);
      ime = await d.ime();
    }
    items.push(item('ime', ime === env.ime, `输入法 ${ime ?? '?'}${ime === env.ime ? '（声明的默认）' : `，应为 ${env.ime}`}`));
  }
  for (const c of env.configItems) items.push(await configWalk(d, c, fix, did));
  return end();
}

/** Back up to three times, then restart the app; ends on the home list when it can. */
async function toHome(d: AndroidBaselineDriver, did: string[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const w = await d.where();
    if (w === 'home') return;
    if (w === 'foreign') break;
    if ((await d.keyboard()) === true) await d.hideKeyboard();
    await d.back();
    did.push(`返回（${w}）`);
  }
  if ((await d.where()) === 'home') return;
  await d.restartApp();
  did.push('重新启动被测 App');
}

/** Web environments: the last task's browser is gone; the signed-in session file is valid. */
export async function walkWeb(host: HostBaselineDriver, fix: boolean): Promise<Walk> {
  const items: BaselineItem[] = [];
  const did: string[] = [];
  let procs = await host.taskProcesses();
  if (procs.length && fix) {
    await host.killTaskProcesses();
    did.push(`结束上一任务的浏览器 / 进程：${procs.join(', ')}`);
    procs = await host.taskProcesses();
  }
  items.push(item('host-processes', !procs.length, procs.length ? `上一任务进程仍在：${procs.join(', ')}` : '上一任务启动的浏览器已结束'));
  if (host.sessionOk) {
    const s = await host.sessionOk();
    items.push(item('session', s.ok, s.detail, false));
  }
  return { items, did, ok: items.every((i) => i.ok) };
}
