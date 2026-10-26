// Issue reports: report.md + result.json per Issue run, an Allure test per sub-case (steps + screenshots +
// incident viewer attached), and one-page reports for refused / deferred Issues.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { RunResult } from '../executor/run';
import type { Draft } from './planner';

export const ALLURE_DIR = resolve('allure-results');

const REVIEW_TEXT: Record<string, string> = { consistent: '符合 Issue 描述', inconsistent: '不符', unverified: '未能复核（视觉模型不可用），结论仅依据自动检查' };

const CAT: Record<string, string> = {
  'bug-always': '必现 bug',
  'bug-intermittent': '偶现 bug',
  feature: '需求验收',
  'suspected-misuse': '疑似误操作',
  'server-side': '服务端问题',
  'multi-account': '多账号/多端',
  deferred: '未来计划',
  'not-executable': '不可执行',
};

export function refusalMarkdown(d: Draft): string {
  const verb = d.status === 'refused' ? '拒绝执行' : '暂缓';
  return `# Issue ${d.issue.id} — ${verb}\n\n- 预判类别：**${d.classification.category}**（${CAT[d.classification.category]}，${d.classification.by === 'model' ? '模型' : '规则'}判定）\n- 原因：${d.reason}\n- Issue 声明的端：${d.issue.platforms.join(', ') || '（未声明）'}\n- 摘要：${d.issue.title || '（空）'}\n\n${d.status === 'refused' ? '黑盒执行器只能驱动用户可做的操作、观察用户可见的现象；本 Issue 没有可驱动/可观察的 UI 路径。' : '需要的能力（第二账号 / 多客户端 / 构造浏览器存储）进入未来计划，具备后自动可执行。'}\n`;
}

export function runMarkdown(d: Draft, results: RunResult[], runDir: string): string {
  const lines = [`# Issue ${d.issue.id} — ${results.map((r) => r.conclusion).join(' / ') || '未执行'}`, ''];
  const subst = results.find((r) => r.substitution);
  if (subst) lines.push(`> **替代执行**：Issue 端 ${subst.substitution!.from} → 实际 ${results.map((r) => r.surface).join(', ')}。${subst.substitution!.reason}`, '');
  lines.push(`- 预判类别：**${d.classification.category}**（${CAT[d.classification.category]}）— ${d.classification.reason}`, `- 环境：${results[0]?.env ?? '-'}（结论以生产环境为准）`, `- Issue 摘要：${d.issue.title}`);
  if (d.deferredPart) lines.push(`- 暂缓部分：${d.deferredPart}`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.planId} — ${r.conclusion}`, '', `- ${r.title}；执行端 ${r.surface}${r.device ? `（设备 ${r.device}）` : ''}；账号 ${r.account ?? '-'}`, `- ${r.conclusionDetail}`);
    if (r.error) lines.push(`- 错误：${r.error}`);
    if (r.targets.length) lines.push(`- 准备阶段目标（模型决策后冻结）：${r.targets.map((t) => `${t.id}="${t.chosen}" @(${t.point.x},${t.point.y}) [${t.by}]`).join('；')}`);
    const s = r.stats;
    lines.push('', '| 统计 | 值 |', '|---|---|', `| 总步数 / 轮数 | ${s.steps} / ${s.rounds} |`, `| 总时长 | ${s.durationSec}s |`, `| 动作间隔 平均 / 最大 | ${s.avgIntervalMs}ms / ${s.maxIntervalMs}ms（>1s: ${s.intervalsOverCap} 次） |`, `| App 启动次数 | ${s.launches} |`, `| 操作偏离（重进，不计命中） | ${s.drifts ?? 0} |`, `| 异常门触发 / 可疑信号 | ${s.anomalyGateTriggers} / ${s.suspectSignals} |`, `| 检查点截图 | ${s.checkpointScreenshots} |`, `| 视觉模型调用 | ${s.visionCalls}${s.evidenceReviews ? `（含证据复核 ${s.evidenceReviews} 次）` : ''} |`, `| 文本模型调用 | ${s.textModelCalls} |`, '');
    const tierRows = (t: Record<string, { n: number; ms: number }> | undefined) => Object.entries(t ?? {}).map(([k, v]) => `| ${k} | ${v.n} | ${Math.round(v.ms / Math.max(1, v.n))}ms |`);
    if (s.observeTiers || s.locateTiers || s.modelCallsByPurpose)
      lines.push('### 判定分层统计', '', '①=确定性（日志 / 进程 / 系统状态 / 无障碍或页面文字 / 区域比对），③=视觉模型。', '', '| 层 · 判定 / 定位 | 次数 | 平均耗时 |', '|---|---|---|', ...tierRows(s.observeTiers), ...tierRows(s.locateTiers).map((r) => r.replace('| ', '| 定位 ')), '', `模型调用按用途：${Object.entries(s.modelCallsByPurpose ?? {}).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`, '');
    if (r.acceptance) {
      lines.push('| 验收项 | 结果 | 依据 |', '|---|---|---|');
      for (const a of r.acceptance) lines.push(`| ${a.text} | ${a.pass === null ? '未验证' : a.pass ? '✅ 已实现' : '❌ 缺项'} | ${a.detail}${a.evidence ? ` · [截图](${r.planId}/${a.evidence})` : ''} |`);
      lines.push('');
    }
    if (r.hits.length) lines.push('命中记录：', ...r.hits.slice(0, 10).map((h) => `- 第 ${h.round} 轮 / 第 ${h.step} 步 ${h.at}：${h.reason}${h.review ? `\n  - 证据复核：${REVIEW_TEXT[h.review]}${h.reviewNote ? ` — ${h.reviewNote}` : ''}` : ''}`), '');
    if (r.dismissed?.length)
      lines.push('证据复核排除（自动检查误报，不计命中）：', ...r.dismissed.slice(0, 10).map((x) => `- 第 ${x.round} 轮 / 第 ${x.step} 步：${x.reason}\n  - 画面所见：${x.observed} · [复核](${relative(runDir, x.incident).replace(/\\/g, '/')}/review/review.md)`), '');
    if (r.incidents.length) lines.push('现场包：', ...r.incidents.map((i) => `- [${basename(i)}](${relative(runDir, i).replace(/\\/g, '/')}/index.html) · 重放：\`pnpm autotest replay ${relative(process.cwd(), i).replace(/\\/g, '/')}/replay.json\``), '');
    const last = r.roundLog.slice(-3);
    if (last.length) lines.push('最后几轮检查：', ...last.map((x) => `- 轮 ${x.round}（步 ${x.step}）：${x.results.map((y) => `${y.kind}=${y.pass === null ? '?' : y.pass ? 'ok' : 'FAIL'} ${y.detail}`).join('；')}`), '');
  }
  return lines.join('\n');
}

/** Allure result per sub-case (allure-results/<uuid>-result.json + attachments). */
export async function writeAllure(d: Draft, r: RunResult, runDir: string): Promise<void> {
  await mkdir(ALLURE_DIR, { recursive: true });
  const att = async (src: string, name: string, type: string) => {
    if (!existsSync(src)) return undefined;
    const ext = src.split('.').pop();
    const source = `${randomUUID()}-attachment.${ext}`;
    await copyFile(src, join(ALLURE_DIR, source));
    return { name, source, type };
  };
  const steps = [];
  for (const a of r.acceptance ?? []) {
    const shot = a.evidence ? await att(join(runDir, r.planId, a.evidence), `${a.id}.png`, 'image/png') : undefined;
    steps.push({ name: a.text, status: a.pass === null ? 'skipped' : a.pass ? 'passed' : 'failed', statusDetails: { message: a.detail }, attachments: shot ? [shot] : [], stage: 'finished' });
  }
  for (const h of r.hits.slice(0, 5)) steps.push({ name: `命中：第 ${h.round} 轮 第 ${h.step} 步`, status: 'failed', statusDetails: { message: h.reason }, attachments: [], stage: 'finished' });
  const attachments = [];
  for (const inc of r.incidents) {
    const a = await att(join(inc, 'index.html'), `现场包 ${basename(inc)}`, 'text/html');
    if (a) attachments.push(a);
  }
  const rep = await att(join(runDir, 'report.md'), 'report.md', 'text/markdown');
  if (rep) attachments.push(rep);
  const status = r.conclusion === '已复现' || r.conclusion === '未实现' || r.conclusion === '部分实现' ? 'failed' : r.conclusion === '执行失败' || r.conclusion === 'SKILL 失效' ? 'broken' : 'passed';
  const start = Date.parse(r.startedAt);
  await writeFile(
    join(ALLURE_DIR, `${randomUUID()}-result.json`),
    JSON.stringify({
      uuid: randomUUID(),
      historyId: r.planId,
      name: `Issue ${r.issue} · ${r.title} [${r.surface}]`,
      fullName: `issues/${r.issue}/${r.planId}`,
      status,
      statusDetails: { message: `${r.conclusion} — ${r.conclusionDetail}${r.substitution ? `（替代执行 ${r.substitution.from}→${r.surface}）` : ''}` },
      stage: 'finished',
      start,
      stop: Date.parse(r.finishedAt),
      steps,
      attachments,
      labels: [
        { name: 'suite', value: `Issue ${r.issue}` },
        { name: 'feature', value: d.issue.featureArea || 'issue' },
        { name: 'tag', value: r.category },
        { name: 'tag', value: r.surface },
        { name: 'tag', value: r.env },
        ...(r.substitution ? [{ name: 'tag', value: 'substituted' }] : []),
      ],
      parameters: [
        { name: 'env', value: r.env },
        { name: 'surface', value: r.surface },
      ],
    }),
  );
}

export async function writeIssueReport(d: Draft, results: RunResult[], runDir: string): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const md = d.status === 'plannable' ? runMarkdown(d, results, runDir) : refusalMarkdown(d);
  const f = join(runDir, 'report.md');
  await writeFile(f, md);
  await writeFile(join(runDir, 'result.json'), JSON.stringify({ issue: d.issue.id, status: d.status, category: d.classification.category, reason: d.reason, deferredPart: d.deferredPart, results }, null, 2));
  for (const r of results) await writeAllure(d, r, runDir);
  return f;
}

export async function readResult(runDir: string): Promise<any> {
  return JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'));
}
