// Environment check (refactor P2, replaces the W2-3 baseline walk and recovery): can a task start here?
// Phones: online, screen on and unlocked (wakes it when it is only dark), the installed app version (approvals
// bind it), and the consented configuration items applied. Web: a usable signed-in session file. Pass → ready;
// otherwise unfit with what a person should do. Cleaning the app between runs is not the environment's job:
// every run starts from a clean point itself (engine/plan/isolation.ts).
import { type CheckItem, type ConfigItem, type EnvRecord, getEnv, moveEnv, updateEnv } from './env';

/** What the check needs from an Android phone (adb in production, a fake in tests). */
export interface PhoneDriver {
  online(): Promise<boolean>;
  screen(): Promise<{ awake: boolean; locked: boolean }>;
  wake(): Promise<void>;
  appVersion(): Promise<string | undefined>;
  configOk(c: ConfigItem): Promise<{ ok: boolean; detail: string }>;
  applyConfig(c: ConfigItem): Promise<void>;
}

export interface CheckDrivers {
  phone?: PhoneDriver;
  /** Web: the signed-in session file is valid. */
  sessionOk?: () => Promise<{ ok: boolean; detail: string }>;
}

export type DriverFactory = (env: EnvRecord) => CheckDrivers;

export interface CheckResult {
  ok: boolean;
  items: CheckItem[];
  did: string[];
  /** Why it failed, for a person ('locked' / 'offline' / other). */
  blocker?: 'locked' | 'offline' | 'other';
  appVersion?: string;
}

const item = (id: string, ok: boolean, detail: string): CheckItem => ({ id, ok, detail });

/** One configuration item: check, apply when consented and unmet, check again. An optional item (the tree
 *  service) that stays unmet leaves the environment usable (degraded). */
async function configItem(d: PhoneDriver, c: ConfigItem, did: string[]): Promise<CheckItem> {
  let r = await d.configOk(c);
  let note = '';
  // An optional item (installing the tree service) is applied only after its one-time consent; the others are
  // the same settings every preflight writes (W2-2 E3).
  if (!r.ok && c.optional && !c.consentedAt) note = '；待同意，未应用';
  else if (!r.ok) {
    try {
      await d.applyConfig(c);
      did.push(`按声明应用 ${c.id}：${c.what}`);
    } catch (e) {
      if (!c.optional) throw e;
      const lines = (e as Error).message.split('\n');
      note = `；应用失败：${(lines.find((l) => /Failure|失败|没有/.test(l)) ?? lines[0]).trim().slice(0, 160)}`;
      did.push(`${c.id} 未能应用${note.slice(1)}`);
    }
    r = await d.configOk(c);
  }
  if (r.ok || !c.optional) return item(`config:${c.id}`, r.ok, `${r.detail}${note}`);
  return item(`config:${c.id}`, true, `${r.detail}${note}（可选项未生效：读树退回 uiautomator）`);
}

/** Pure walk over the drivers (no state change). */
export async function runCheck(env: Pick<EnvRecord, 'surface' | 'configItems'>, d: CheckDrivers): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const did: string[] = [];
  const done = (blocker?: CheckResult['blocker'], appVersion?: string): CheckResult => {
    const ok = items.every((i) => i.ok);
    return { ok, items, did, blocker: ok ? undefined : (blocker ?? 'other'), appVersion };
  };
  if (env.surface === 'android-app' || env.surface === 'android-web') {
    const p = d.phone;
    if (!p || !(await p.online().catch(() => false))) {
      items.push(item('online', false, '设备不在线（adb 不可达）'));
      return done('offline');
    }
    items.push(item('online', true, 'adb 在线'));
    let s = await p.screen();
    if (!s.awake && !s.locked) {
      await p.wake();
      did.push('唤醒屏幕');
      s = await p.screen();
    }
    if (s.locked) {
      items.push(item('screen', false, '锁屏（有 PIN，需人工解锁）'));
      return done('locked');
    }
    items.push(item('screen', s.awake, s.awake ? '屏幕亮、未锁屏' : '屏幕未亮'));
    const appVersion = await p.appVersion().catch(() => undefined);
    for (const c of env.configItems) items.push(await configItem(p, c, did));
    return done(undefined, appVersion);
  }
  if (d.sessionOk) {
    const s = await d.sessionOk();
    items.push(item('session', s.ok, s.detail));
  }
  return done();
}

const SUGGEST = { locked: '在手机上输入 PIN 解锁，然后点「重新检查」', offline: '检查 USB 连接 / adb，然后点「重新检查」', other: '按未通过的项处理后点「重新检查」' };

export const CHECK_LIMIT_MS = Number(process.env.AUTOTEST_CHECK_MS ?? 120_000);

function withLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`检查超出时长上限 ${Math.round(ms / 1000)} s`)), ms).unref())]);
}

/** Check an environment and move it to ready / unfit. Leased environments are never checked. */
export async function checkEnv(id: string, drivers: DriverFactory, by = 'platform'): Promise<{ env: EnvRecord; result?: CheckResult; error?: string }> {
  let env = getEnv(id);
  if (!env) throw new Error(`no environment ${id}`);
  if (env.state === 'leased') return { env, error: `环境被任务 ${env.lease?.taskId} 占用：不检查` };
  if (env.state !== 'checking') env = moveEnv(id, 'checking', { by, basis: `check requested from ${env.state}` });
  let r: CheckResult;
  try {
    r = await withLimit(runCheck(env, drivers(env)), CHECK_LIMIT_MS);
  } catch (e) {
    r = { ok: false, items: [item('check', false, (e as Error).message.split('\n')[0])], did: [], blocker: 'other' };
  }
  const at = new Date().toISOString();
  if (r.appVersion && r.appVersion !== env.appVersion) env = updateEnv(id, (e) => void (e.appVersion = r.appVersion));
  const patch = (e: EnvRecord) => void (e.check = { at, ok: r.ok, items: r.items, did: r.did });
  if (r.ok) return { env: moveEnv(id, 'ready', { by, basis: 'check passed' }, patch), result: r };
  const reason = r.items.filter((i) => !i.ok).map((i) => i.detail).join('；');
  return { env: moveEnv(id, 'unfit', { by, basis: `check failed: ${reason}`, reason, suggestion: SUGGEST[r.blocker ?? 'other'] }, patch), result: r };
}
