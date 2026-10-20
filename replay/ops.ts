// Replayable operations. The mission runner executes every action through executeOp() and records
// the op, so a replay bundle re-runs exactly what was done (same prompts, same order, same pauses).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AndroidAgent } from '@midscene/android';
import { adb, forceStopApp, launchApp } from '../core/adb';

export type ReplayOp =
  | { kind: 'launch'; cold: boolean }
  | { kind: 'aiAct'; prompt: string }
  | { kind: 'aiTap'; locate: string }
  | { kind: 'aiInput'; locate: string; value: string }
  | { kind: 'key'; code: number }
  | { kind: 'background'; ms: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeOp(agent: AndroidAgent, op: ReplayOp, pkg: string, udid?: string): Promise<void> {
  switch (op.kind) {
    case 'launch':
      if (op.cold) await forceStopApp(pkg, udid);
      await launchApp(pkg, udid);
      await sleep(op.cold ? 5_000 : 2_500);
      return;
    case 'aiAct':
      await agent.aiAct(op.prompt);
      return;
    case 'aiTap':
      await agent.aiTap(op.locate);
      return;
    case 'aiInput':
      await agent.aiInput(op.locate, { value: op.value });
      return;
    case 'key':
      await adb(['shell', 'input', 'keyevent', String(op.code)], udid);
      return;
    case 'background':
      await adb(['shell', 'input', 'keyevent', '3'], udid);
      await sleep(op.ms);
      await launchApp(pkg, udid);
      await sleep(2_000);
      return;
  }
}

export interface RecordedOp {
  /** ms since the first op of the bundle. */
  t: number;
  at: string;
  op: ReplayOp;
  ok: boolean;
  label: string;
}

export interface ReplayBundle {
  version: 1;
  source: 'mission';
  missionId: string;
  packageName: string;
  udid: string | null;
  createdAt: string;
  finding: { kind: string; title: string; detail: string; crashDir?: string };
  /** From the last launch before the finding to the finding. */
  ops: RecordedOp[];
  videos: string[];
  recorder: string | null;
  replayCommand: string;
}

/**
 * Pure: ops from the last `launch` at or before the end, so replay starts from a known state.
 * `maxOps` caps very long rounds (keeps the tail).
 */
export function sliceFromLastLaunch(steps: { at: string; op?: ReplayOp; ok: boolean; action: string }[], maxOps = 80): RecordedOp[] {
  const withOp = steps.filter((s) => s.op);
  let from = 0;
  for (let i = withOp.length - 1; i >= 0; i--) {
    if (withOp[i].op!.kind === 'launch') {
      from = i;
      break;
    }
  }
  let slice = withOp.slice(from);
  if (slice.length > maxOps) slice = slice.slice(-maxOps);
  const t0 = slice.length ? Date.parse(slice[0].at) : 0;
  return slice.map((s) => ({ t: Date.parse(s.at) - t0, at: s.at, op: s.op!, ok: s.ok, label: s.action }));
}

export async function writeBundle(dir: string, bundle: ReplayBundle): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'replay.json');
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  const md = [
    `# 即时重放：${bundle.finding.title}`,
    '',
    `- 任务：${bundle.missionId}，App \`${bundle.packageName}\`，${bundle.createdAt}`,
    `- 详情：${bundle.finding.detail || '-'}`,
    bundle.finding.crashDir ? `- 崩溃现场：\`${bundle.finding.crashDir.replace(/\\/g, '/')}\`` : '',
    `- 录屏（${bundle.recorder ?? '未开启'}）：${bundle.videos.length ? bundle.videos.map((v) => `\`${v}\``).join('、') : '无'}`,
    `- 重放：\`${bundle.replayCommand}\``,
    '',
    '| t | 操作 | 结果 |',
    '|---|---|---|',
    ...bundle.ops.map((o) => `| +${(o.t / 1000).toFixed(1)}s | ${o.label.replace(/\|/g, '/').slice(0, 90)} | ${o.ok ? '✓' : '✗'} |`),
    '',
  ].filter((l) => l !== '');
  await writeFile(join(dir, 'README.md'), md.join('\n'));
  return file;
}
