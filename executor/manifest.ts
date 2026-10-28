// Run manifest (W2-2 §4.1): what exactly ran, where and against what — written for EVERY run (also 环境不合格
// and 执行失败) as <runDir>/manifest.json, as the first trajectory event and as the report header.
// Names only: account id and conversation title, never credentials.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestPlan } from '../platform/schema/test-plan';
import { profilePath } from '../skills/profile';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import type { DeviceInfo, PreflightResult } from './preflight';

export interface Manifest {
  schema: 'manifest-v1';
  runId: string;
  startedAt: string;
  tool: { gitCommit: string; gitDirty: boolean; skillVersion: string; profile?: string; profileHash?: string; draftHash?: string; pattern?: string };
  target: { issue: string; planId: string; sub: string; surface: string; mode: string; env: string; budget: { maxSteps: number; maxMinutes: number; maxRounds?: number }; stopRule: string; seed: string };
  device?: DeviceInfo;
  account?: { id: string; conversation?: string };
  /** Run marker written into every constructed message / draft of this run (W2-2 §4.3). */
  runTag: string;
  preflight?: PreflightResult;
}

let git: { commit: string; dirty: boolean } | undefined;
/** Commit of the working tree (cached per process); dirty = uncommitted changes. */
export function gitState(): { commit: string; dirty: boolean } {
  if (git) return git;
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
    git = { commit, dirty };
  } catch {
    git = { commit: 'unknown', dirty: false };
  }
  return git;
}

/** Content hash of a profile file (16 hex). */
export function profileHash(name: string): string | undefined {
  const f = profilePath(name);
  return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16) : undefined;
}

/** Pure (apart from git / profile reads): the manifest of one run. */
export function buildManifest(o: { plan: TestPlan; runId: string; startedAt: string; runTag: string; profile?: string; account?: string; conversation?: string; device?: DeviceInfo; preflight?: PreflightResult }): Manifest {
  const p = o.plan;
  const g = gitState();
  return {
    schema: 'manifest-v1',
    runId: o.runId,
    startedAt: o.startedAt,
    tool: { gitCommit: g.commit, gitDirty: g.dirty, skillVersion: SKILL_VERSION, profile: o.profile, profileHash: o.profile ? profileHash(o.profile) : undefined, draftHash: p.provenance.draftHash, pattern: p.provenance.pattern },
    target: {
      issue: p.issueRef,
      planId: p.id,
      sub: p.contract?.sub ?? (p.id.match(/-(s\d+)-/)?.[1] ?? 'main'),
      surface: p.surface,
      mode: p.provenance.pattern ?? p.category,
      env: p.env,
      budget: { maxSteps: p.limits.maxSteps, maxMinutes: p.limits.maxMinutes, maxRounds: p.limits.maxRounds },
      stopRule: 'anyHit' in p.verdictRule ? '命中 1 次' : '连续 3 次命中',
      // The run's only random input is its marker.
      seed: o.runTag,
    },
    device: o.device,
    account: o.account ? { id: o.account, conversation: o.conversation } : undefined,
    runTag: o.runTag,
    preflight: o.preflight,
  };
}

export async function writeManifest(runDir: string, m: Manifest): Promise<void> {
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(m, null, 2));
}

/** Pure: the manifest as report header lines (markdown). */
export function manifestMarkdown(m: Manifest): string[] {
  const d = m.device;
  const out = [
    `- 运行：\`${m.runId}\`；运行标记 \`${m.runTag}\`；开始 ${m.startedAt}`,
    `- 工具：commit \`${m.tool.gitCommit}\`${m.tool.gitDirty ? '（有未提交改动）' : ''}；SKILL ${m.tool.skillVersion}；profile ${m.tool.profile ?? '-'}${m.tool.profileHash ? `（${m.tool.profileHash}）` : ''}；草稿 ${m.tool.draftHash ?? '-'}；模式 ${m.tool.pattern ?? '-'}`,
    `- 目标：Issue ${m.target.issue} / ${m.target.sub}；${m.target.surface}；${m.target.mode}；${m.target.env}；预算 ${m.target.budget.maxRounds ? `${m.target.budget.maxRounds} 轮 / ` : ''}${m.target.budget.maxSteps} 步 / ${m.target.budget.maxMinutes} 分钟；停止条件 ${m.target.stopRule}`,
  ];
  if (d) out.push(`- 设备：${d.model ?? '?'}（${d.udid}）Android ${d.android ?? '?'} / ${d.hyperos ?? '-'}；App ${d.app?.package ?? '-'} ${d.app?.versionName ?? '?'}（${d.app?.versionCode ?? '?'}）；输入法 ${d.ime ?? '?'}；网络 ${d.network ?? '?'}；电量 ${d.battery ?? '?'}%`);
  if (m.account) out.push(`- 账号：${m.account.id}${m.account.conversation ? `；会话「${m.account.conversation}」` : ''}`);
  if (m.preflight) out.push(`- 预检：${m.preflight.ok ? '合格' : `**不合格** — ${m.preflight.reason}`}（${m.preflight.ms} ms；${m.preflight.items.map((i) => `${i.id} ${i.ok ? '✓' : '✗'}`).join('，')}）${m.preflight.changes.length ? `；设置改动：${m.preflight.changes.join('；')}` : ''}`);
  return out;
}
