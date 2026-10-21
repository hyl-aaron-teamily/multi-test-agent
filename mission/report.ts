// mission.json + report.md for one mission (midscene_run/missions/<id>/).
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { MissionPlan } from './planner';
import type { Finding, MissionResult } from './runner';

export interface MissionRecord {
  id: string;
  request: string;
  packageName: string;
  udid: string | null;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  limits: { maxSteps: number; maxMinutes: number; caps: { maxSteps: number; maxMinutes: number } };
  plan: MissionPlan;
  result: Omit<MissionResult, 'crashes'> & { crashes: { dir: string; keywords: string[]; matchesPackage: boolean; firstLine: string }[] };
  midsceneReport: string | null;
  verdict: string;
}

const STOP_TEXT: Record<MissionResult['stopReason'], string> = {
  finding: '发现问题后停止（stopOnFirstFinding）',
  'max-steps': '达到步数上限',
  'max-minutes': '达到时长上限',
  aborted: '被外部中止（硬超时 / 用户取消）',
  error: '执行出错',
};

export function verdictOf(r: Pick<MissionResult, 'findings' | 'stopReason' | 'steps'>): string {
  if (r.findings.length) {
    const top = r.findings[0];
    return `发现 ${r.findings.length} 个问题，首个：[${top.severity}] ${top.title}`;
  }
  return `未复现 / 未发现问题：执行 ${r.steps.length} 步后${STOP_TEXT[r.stopReason]}。偶发问题未出现不代表不存在，可加大上限或换时段重跑。`;
}

const rel = (root: string, p?: string) => (p ? relative(root, p).replace(/\\/g, '/') : '');

function renderFinding(f: Finding, i: number, root: string): string[] {
  return [
    `### ${i + 1}. [${f.severity}] ${f.title}`,
    '',
    `- 类型：\`${f.kind}\`；第 ${f.round} 轮，第 ${f.step} 步，${f.at}`,
    `- 详情：${f.detail || '-'}`,
    f.screenshot ? `- 截图：![finding](${rel(root, f.screenshot)})` : '- 截图：无',
    f.replayDir ? `- 即时重放：\`${rel(root, f.replayDir)}/\`（README.md、replay.json、录屏片段）；重放命令见其中 README` : '',
    f.crashDir ? `- 崩溃现场：\`${rel(root, f.crashDir)}\`（screenshot.png / logcat.txt / context.json）` : '',
    '- 复现路径（发现前最后 8 步）：',
    '',
    '```',
    ...f.trail,
    '```',
    '',
  ].filter((l) => l !== '');
}

export async function writeMissionReport(dir: string, rec: MissionRecord): Promise<string> {
  await writeFile(join(dir, 'mission.json'), `${JSON.stringify(rec, null, 2)}\n`);
  const p = rec.plan;
  const r = rec.result;
  const jank = r.rounds.filter((x) => x.jank);
  const md = [
    `# 测试任务报告：${p.title}`,
    '',
    `> 需求原文：「${rec.request}」`,
    '',
    '## 结论',
    '',
    `**${rec.verdict}**`,
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| App | \`${rec.packageName}\`（设备 ${rec.udid ?? '-'}） |`,
    `| 时间 | ${rec.startedAt} → ${rec.finishedAt}（${rec.durationSec}s） |`,
    `| 执行 | ${r.rounds.length} 轮 / ${r.steps.length} 步，失败动作 ${r.steps.filter((s) => !s.ok).length} 个 |`,
    `| 上限 | ${rec.limits.maxSteps} 步 / ${rec.limits.maxMinutes} 分钟（平台上限 ${rec.limits.caps.maxSteps} 步 / ${rec.limits.caps.maxMinutes} 分钟） |`,
    `| 停止原因 | ${STOP_TEXT[r.stopReason]}${r.stopDetail ? `：${r.stopDetail}` : ''} |`,
    `| Midscene 回放 | ${rec.midsceneReport ? `\`${rec.midsceneReport.replace(/\\/g, '/')}\`` : '-'} |`,
    '',
    '## 发现的问题',
    '',
    ...(r.findings.length ? r.findings.flatMap((f, i) => renderFinding(f, i, dir)) : ['无。', '']),
    '## 自动生成的测试计划',
    '',
    `- 意图：\`${p.intent}\`；目标区域：${p.targetArea}；规划来源：${p.plannedBy === 'model' ? '模型' : '关键词规则（模型不可用）'}`,
    `- 策略：${p.rationale}`,
    `- 入口：${p.entryInstruction || '（首页）'}`,
    '- 每轮场景动作：',
    ...p.scenario.map((s, i) => `  ${i + 1}. ${s}`),
    `- 每轮随机探索 ${p.exploreStepsPerRound} 步，关注：${p.focusTerms.join('、')}`,
    '- 检查项：',
    ...p.checks.map((c) => `  - ${c}`),
    `- 帧率采集：${p.measureJank ? '是（dumpsys gfxinfo）' : '否'}`,
    '',
    ...(jank.length
      ? ['## 流畅度', '', '| 轮 | 帧数 | 卡顿帧 | 比例 | p90 | p99 |', '|---|---|---|---|---|---|',
         ...jank.map((x) => `| ${x.round} | ${x.jank!.totalFrames} | ${x.jank!.jankyFrames} | ${x.jank!.jankyPercent}% | ${x.jank!.p90Ms ?? '-'}ms | ${x.jank!.p99Ms ?? '-'}ms |`), '']
      : []),
    '## 执行轨迹',
    '',
    '| # | 轮 | 阶段 | 动作 | 结果 | 耗时 |',
    '|---|---|---|---|---|---|',
    ...r.steps.map((s) => `| ${s.step} | ${s.round} | ${s.phase} | ${s.action.replace(/\|/g, '/').slice(0, 80)} | ${s.ok ? '✓' : `✗ ${(s.error ?? '').replace(/\|/g, '/').slice(0, 60)}`} | ${(s.ms / 1000).toFixed(1)}s |`),
    '',
  ].join('\n');
  const file = join(dir, 'report.md');
  await writeFile(file, md);
  return file;
}
