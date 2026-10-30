// `autotest doctor [--fix] [--probe]` (W2-4 §4.4): one place that says whether runs can start, what is
// missing and what to do next — in dependency order, split into commands that can be run (one local,
// non-destructive command each) and things only a person can do (unlock, tap 允许, plug in). After Artemis'
// `mobile_diagnose` (ref/artemis, Apache-2.0), rewritten.
//   gatherFacts()  — I/O (local only; works with the platform down)
//   diagnose()     — pure: facts → checks → conclusion ready / degraded / blocked + next steps
//   fixStale()     — --fix: stale lock files, our stale adb forwards, leases left by dead tasks (only while the
//                    platform is down: otherwise its watchdog owns them). Never `adb kill-server` (the test
//                    phone drops its USB-debugging authorization), never anything on the device.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { a11yForwards, a11yHealth, a11yBackend, type A11yHealth, removeForward } from '../core/a11y-service';
import { adb, resolveAdbPath, screencap } from '../core/adb';
import { modelConfigured, visionConfigured } from '../core/model/llm';
import { findScrcpy } from '../core/screen-recorder';
import { uiautomatorBackend } from '../core/tree-backend';
import { readDeviceState } from '../executor/preflight';
import { listDevices } from './adb-devices';
import { CONFIG_FILE, declaredTreeBackend, parsePoolConfig } from './device-pool';
import { endLease, listEnvs } from './lifecycle/env';
import { closeTask } from './lifecycle/crosscheck';
import { alive } from './lifecycle/proc';
import type { Code } from './lifecycle/status';
import { stateRoot } from './lifecycle/store';
import { getTask, isTerminal } from './lifecycle/task';

export type Level = 'ok' | 'warn' | 'fail';
export interface Next {
  /** run = one local, non-destructive command; human = only a person can do it. */
  kind: 'run' | 'human';
  text: string;
  cmd?: string;
}
export interface Check {
  id: string;
  title: string;
  level: Level;
  detail: string;
  next?: Next[];
  /** A fail here stops every run (blocked) rather than one device / feature (degraded). */
  blocking?: boolean;
  code?: Code;
}

export interface DeviceFact {
  udid: string;
  state: string;
  model?: string;
  declared: boolean;
  locked?: boolean;
  awake?: boolean;
  backend: 'uiautomator' | 'a11y-service';
  a11y?: A11yHealth;
}

export interface Facts {
  node: { version: string; missing: string[] };
  platform: { up: boolean; url: string };
  model: { text: boolean; vision: boolean };
  adb: { ok: boolean; path: string; version?: string; error?: string };
  devices: DeviceFact[];
  recorder: { scrcpy: boolean };
  envs: { id: string; state: string; reason?: string; suggestion?: string; lease?: string; dirty?: string }[];
  stale: { locks: string[]; forwards: { serial: string; local: string }[]; leases: { env: string; task: string; why: string }[] };
  probe?: ProbeResult[];
}

export interface ProbeResult {
  udid: string;
  screenshotMs?: number;
  uiautomatorMs?: number;
  uiautomatorNodes?: number;
  a11yMs?: number;
  a11yNodes?: number;
  error?: string;
}

export interface Diagnosis {
  conclusion: 'ready' | 'degraded' | 'blocked';
  /** Status code of the first blocking cause (OK when not blocked). */
  code: Code;
  summary: string;
  checks: Check[];
  next: Next[];
  probe?: ProbeResult[];
}

const REQUIRED_DEPS = ['tsx', 'playwright', '@midscene/android', 'js-yaml', 'zod'];
const PLATFORM_URL = () => `http://localhost:${process.env.PLATFORM_PORT ?? 3210}/api/v1`;

/** Pure: facts → checks (dependency order) → conclusion and next steps. */
export function diagnose(f: Facts): Diagnosis {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(f.node.version.split('.')[0]);
  add({ id: 'node', title: 'Node 与依赖', level: major >= 20 && !f.node.missing.length ? 'ok' : 'fail', blocking: true, code: 'ENV_UNFIT', detail: `Node ${f.node.version}${f.node.missing.length ? `；缺依赖 ${f.node.missing.join(', ')}` : '，依赖齐全'}`, next: f.node.missing.length ? [{ kind: 'run', text: '安装依赖', cmd: 'pnpm install' }] : major < 20 ? [{ kind: 'human', text: '安装 Node 20 或更高版本' }] : undefined });

  const phones = f.devices.filter((d) => d.declared || d.state === 'device');
  const wantPhones = f.devices.some((d) => d.declared) || f.envs.some((e) => /^android-/.test(e.id));
  add({ id: 'adb', title: 'adb', level: f.adb.ok ? 'ok' : wantPhones ? 'fail' : 'warn', blocking: wantPhones, code: 'ENV_OFFLINE', detail: f.adb.ok ? `${f.adb.version ?? 'adb'}（${f.adb.path}）` : `adb 不可用：${f.adb.error ?? f.adb.path}`, next: f.adb.ok ? undefined : [{ kind: 'human', text: '安装 Android platform-tools，并把 adb 放到 PATH 或在 .env 设 MIDSCENE_ADB_PATH' }] });

  let usable = 0;
  if (f.adb.ok) {
    for (const d of phones) {
      const name = `${d.udid}${d.model ? `（${d.model}）` : ''}`;
      if (d.state === 'absent') {
        add({ id: `device:${d.udid}`, title: `手机 ${name}`, level: 'fail', code: 'ENV_OFFLINE', detail: 'adb 看不到这台手机', next: [{ kind: 'human', text: `把手机 ${d.udid} 用 USB 线连上电脑，并开启 USB 调试` }] });
        continue;
      }
      if (d.state === 'unauthorized') {
        add({ id: `device:${d.udid}`, title: `手机 ${name}`, level: 'fail', code: 'ENV_OFFLINE', detail: '未授权 USB 调试', next: [{ kind: 'human', text: `在手机 ${d.udid} 上点「允许 USB 调试」（可勾选「始终允许」）` }] });
        continue;
      }
      if (d.state !== 'device') {
        add({ id: `device:${d.udid}`, title: `手机 ${name}`, level: 'fail', code: 'ENV_OFFLINE', detail: `adb 状态 ${d.state}`, next: [{ kind: 'run', text: '让 adb 重新连接这台手机（不会取消授权）', cmd: `adb -s ${d.udid} reconnect` }, { kind: 'human', text: '仍不行就重新插拔 USB 线' }] });
        continue;
      }
      if (d.locked) {
        add({ id: `device:${d.udid}`, title: `手机 ${name}`, level: 'fail', code: 'ENV_LOCKED', detail: '锁屏（有 PIN，只能人工解锁）', next: [{ kind: 'human', text: `请解锁手机 ${d.udid}（不要让工具代输 PIN）` }] });
        continue;
      }
      usable++;
      add({ id: `device:${d.udid}`, title: `手机 ${name}`, level: 'ok', detail: `在线、已授权、未锁屏${d.awake === false ? '（屏幕未亮，运行时会唤醒）' : ''}` });
      if (d.backend === 'a11y-service') {
        const h = d.a11y;
        const nx: Next[] = !h?.installed
          ? [{ kind: 'human', text: '小米 / HyperOS：手机「设置 > 开发者选项」打开「USB 安装」；安装时手机弹确认，点「继续安装」（否则报 INSTALL_FAILED_USER_RESTRICTED）' }, { kind: 'run', text: '按环境配置项安装并启用读树服务（需已同意该配置项）', cmd: `pnpm autotest env check android-app:${d.udid}@prod` }]
          : !h.enabled
            ? [{ kind: 'run', text: '按环境配置项启用读树服务（需已同意该配置项）', cmd: `pnpm autotest env check android-app:${d.udid}@prod` }] : !h.responding ? [{ kind: 'human', text: '在手机「设置 > 无障碍」里关掉再打开「autotest 读树服务」，并把它加入电池白名单（省电策略会回收它）' }] : [];
        add({ id: `backend:${d.udid}`, title: `读树后端 ${d.udid}`, level: h?.responding ? 'ok' : 'warn', detail: h?.responding ? `a11y-service：${h.detail}` : `a11y-service 不可用（${h?.detail ?? '未检查'}）— 运行时退回 uiautomator（慢 2–3 s / 次）`, next: nx.length ? nx : undefined });
      } else add({ id: `backend:${d.udid}`, title: `读树后端 ${d.udid}`, level: 'ok', detail: 'uiautomator（devices.yaml 未声明 treeBackend: a11y-service）' });
    }
    if (wantPhones && !usable) {
      const first = checks.find((c) => c.id.startsWith('device:') && c.level === 'fail');
      if (first) first.blocking = true;
      else add({ id: 'device:none', title: '手机', level: 'fail', blocking: true, code: 'ENV_OFFLINE', detail: '没有在线的手机', next: [{ kind: 'human', text: '用 USB 连上测试手机并开启 USB 调试' }] });
    }
  }

  add({ id: 'platform', title: '平台服务', level: f.platform.up ? 'ok' : 'fail', blocking: true, code: 'PLATFORM_DOWN', detail: f.platform.up ? `运行中（${f.platform.url}）` : `未启动（连不上 ${f.platform.url}）`, next: f.platform.up ? undefined : [{ kind: 'run', text: '启动平台服务（常驻进程，另开一个终端）', cmd: 'pnpm platform' }] });

  const modelNext: Next[] = [{ kind: 'human', text: '在 .env 配置模型（MIDSCENE_MODEL_BASE_URL / MIDSCENE_MODEL_API_KEY / MIDSCENE_MODEL_NAME），改完重启平台和 MCP 服务' }];
  add({ id: 'model', title: '模型配置', level: f.model.text && f.model.vision ? 'ok' : 'warn', detail: f.model.text || f.model.vision ? `文本模型 ${f.model.text ? '有' : '无'}，视觉模型 ${f.model.vision ? '有' : '无'}${f.model.vision ? '' : '（视觉判定 / 证据复核记为未验证）'}` : '未配置：草稿只能用规则（--no-model），视觉判定与证据复核记为未验证', next: f.model.text && f.model.vision ? undefined : modelNext });

  add({ id: 'recorder', title: '录屏工具链', level: 'ok', detail: f.recorder.scrcpy ? 'scrcpy 可用' : 'scrcpy 不在，录屏用手机自带 screenrecord（每段最长 3 分钟）' });

  for (const e of f.envs) {
    const bad = e.state === 'unfit' || e.state === 'quarantined';
    if (!bad && !e.dirty) continue;
    add({ id: `env:${e.id}`, title: `环境 ${e.id}`, level: 'warn', detail: `${e.state}${e.reason ? `：${e.reason}` : ''}${e.dirty ? `；脏标记：${e.dirty}` : ''}`, next: [e.state === 'quarantined' ? { kind: 'human', text: `看过环境 ${e.id} 后在 Web 上放行，或运行检查`, cmd: `pnpm autotest env check ${e.id}` } : { kind: 'run', text: `重新检查环境 ${e.id}`, cmd: `pnpm autotest env check ${e.id}` }] });
  }

  const st = f.stale;
  const n = st.locks.length + st.forwards.length + st.leases.length;
  add({ id: 'stale', title: '残留（锁 / 转发端口 / 租约）', level: n ? 'warn' : 'ok', detail: n ? [st.locks.length && `锁文件 ${st.locks.length} 个`, st.forwards.length && `读树转发端口 ${st.forwards.length} 个`, st.leases.length && `死任务留下的租约 ${st.leases.map((l) => `${l.env}←${l.task}（${l.why}）`).join('；')}`].filter(Boolean).join('；') : '无', next: n ? [{ kind: 'run', text: '安全清理（只动本机，不动设备，不重启 adb）', cmd: 'pnpm autotest doctor --fix' }] : undefined });

  const failsBlocking = checks.filter((c) => c.level === 'fail' && c.blocking);
  const conclusion: Diagnosis['conclusion'] = failsBlocking.length ? 'blocked' : checks.some((c) => c.level !== 'ok') ? 'degraded' : 'ready';
  const next: Next[] = [];
  for (const c of checks) for (const x of c.level === 'ok' ? [] : (c.next ?? [])) if (!next.some((y) => y.text === x.text && y.cmd === x.cmd)) next.push(x);
  const head = { ready: '可以运行', degraded: '可以运行，但有降级项', blocked: '不能运行' }[conclusion];
  const why = (conclusion === 'blocked' ? failsBlocking : checks.filter((c) => c.level !== 'ok')).map((c) => `${c.title}：${c.detail}`);
  return { conclusion, code: failsBlocking[0]?.code ?? 'OK', summary: `${head}${why.length ? `（${why.slice(0, 3).join('；')}${why.length > 3 ? '…' : ''}）` : ''}`, checks, next, ...(f.probe ? { probe: f.probe } : {}) };
}

/** Pure: plain-text rendering (CLI without --json). */
export function doctorText(d: Diagnosis): string {
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  const lines = [`结论：${d.conclusion}（${d.summary}）`, '', ...d.checks.map((c) => `${mark[c.level]} ${c.title}：${c.detail}`)];
  if (d.next.length) lines.push('', '下一步（按顺序）：', ...d.next.map((x, i) => `${i + 1}. [${x.kind === 'run' ? '可执行' : '需人工'}] ${x.text}${x.cmd ? `\n     ${x.cmd}` : ''}`));
  if (d.probe?.length) lines.push('', '端到端探测：', ...d.probe.map((p) => `- ${p.udid}：截图 ${p.screenshotMs ?? '-'} ms；uiautomator ${p.uiautomatorMs ?? '-'} ms（${p.uiautomatorNodes ?? 0} 节点）；a11y-service ${p.a11yMs ?? '-'} ms（${p.a11yNodes ?? 0} 节点）${p.error ? `；${p.error}` : ''}`));
  return lines.join('\n');
}

const STALE_LOCK_MS = 60_000;

/** I/O: everything diagnose() needs. Changes nothing on the device: state reads; for a phone that declares the
 *  tree service, a /ping through an adb forward (host side); with probe, one screenshot + tree reads (the
 *  service gets a fresh session token). */
export async function gatherFacts(o: { probe?: boolean } = {}): Promise<Facts> {
  const missing = REQUIRED_DEPS.filter((p) => !existsSync(resolve('node_modules', p)));
  const url = PLATFORM_URL();
  const up = await fetch(`${url}/envs`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok || r.status < 500, () => false);
  let adbF: Facts['adb'] = { ok: false, path: resolveAdbPath() };
  try {
    adbF = { ok: true, path: adbF.path, version: (await adb(['version'], undefined, 10_000)).split(/\r?\n/)[0].trim() };
  } catch (e) {
    adbF.error = (e as Error).message.split('\n')[0];
  }
  let declared: string[] = [];
  try {
    declared = parsePoolConfig(readFileSync(CONFIG_FILE, 'utf8')).devices.filter((d) => !/^emulator-/.test(d.udid)).map((d) => d.udid);
  } catch {
    /* no file */
  }
  const live = adbF.ok ? await listDevices() : [];
  const devices: DeviceFact[] = [];
  for (const udid of [...new Set([...declared, ...live.map((d) => d.udid)])]) {
    const l = live.find((d) => d.udid === udid);
    const d: DeviceFact = { udid, state: l?.state ?? 'absent', model: l?.model, declared: declared.includes(udid), backend: declaredTreeBackend(udid) };
    if (d.state === 'device') {
      const s = await readDeviceState(udid);
      d.locked = !!s.keyguard || /Keyguard|NotificationShade/i.test(s.focus ?? '');
      d.awake = s.wakefulness ? /awake/i.test(s.wakefulness) : undefined;
      if (d.backend === 'a11y-service') d.a11y = await a11yHealth(udid);
    }
    devices.push(d);
  }
  const envs = listEnvs().map((e) => ({ id: e.id, state: e.state, reason: e.reason, suggestion: e.suggestion, lease: e.lease?.taskId, dirty: e.dirty?.reason }));
  const stale = await findStale(up, adbF.ok);
  const f: Facts = { node: { version: process.versions.node, missing }, platform: { up, url }, model: { text: modelConfigured(), vision: visionConfigured() }, adb: adbF, devices, recorder: { scrcpy: !!findScrcpy() }, envs, stale };
  if (o.probe) f.probe = await Promise.all(devices.filter((d) => d.state === 'device' && !d.locked).map((d) => probe(d)));
  return f;
}

async function findStale(platformUp: boolean, adbOk: boolean): Promise<Facts['stale']> {
  const dir = join(stateRoot(), 'locks');
  const now = Date.now();
  const locks = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.lock') && now - statSync(join(dir, f)).mtimeMs > STALE_LOCK_MS) : [];
  // Our forwards belong to running task processes; with the platform down nothing legitimately holds one.
  const forwards = adbOk && !platformUp ? await a11yForwards() : [];
  const leases: Facts['stale']['leases'] = [];
  if (!platformUp) {
    for (const e of listEnvs()) {
      if (!e.lease) continue;
      const t = getTask(e.lease.taskId);
      const why = !t ? '任务记录不存在' : isTerminal(t.state) ? `任务已结束（${t.state}）` : t.proc && !alive(t.proc) ? `进程 ${t.proc.pid} 已不在` : '';
      if (why) leases.push({ env: e.id, task: e.lease.taskId, why });
    }
  }
  return { locks, forwards, leases };
}

async function probe(d: DeviceFact): Promise<ProbeResult> {
  const r: ProbeResult = { udid: d.udid };
  try {
    let t = Date.now();
    await screencap(d.udid);
    r.screenshotMs = Date.now() - t;
    t = Date.now();
    const x = await uiautomatorBackend.dump(d.udid, 20_000);
    r.uiautomatorMs = Date.now() - t;
    r.uiautomatorNodes = (x.match(/<node\b/g) ?? []).length;
    if (d.a11y?.responding) {
      t = Date.now();
      const y = await a11yBackend().dump(d.udid, 5000);
      r.a11yMs = Date.now() - t;
      r.a11yNodes = (y.match(/<node\b/g) ?? []).length;
    }
  } catch (e) {
    r.error = (e as Error).message.split('\n')[0].slice(0, 160);
  }
  return r;
}

/** --fix: local-side cleanup only. Returns what was done. */
export async function fixStale(f: Facts): Promise<string[]> {
  const did: string[] = [];
  for (const l of f.stale.locks) {
    rmSync(join(stateRoot(), 'locks', l), { force: true });
    did.push(`删除残留锁 ${l}`);
  }
  for (const x of f.stale.forwards) {
    await removeForward(x.serial, x.local).catch(() => {});
    did.push(`移除读树转发 ${x.serial} ${x.local}`);
  }
  for (const l of f.stale.leases) {
    const t = getTask(l.task);
    if (t && !isTerminal(t.state)) closeTask(l.task, 'crash', 'doctor', `doctor --fix: ${l.why}`);
    // The environment goes to recovering: the platform recovers it (device side) when it starts.
    endLease(l.env, l.task, { by: 'doctor', basis: `doctor --fix: ${l.why}` });
    did.push(`释放环境 ${l.env} 的租约（${l.task}：${l.why}），平台启动时恢复`);
  }
  return did;
}
