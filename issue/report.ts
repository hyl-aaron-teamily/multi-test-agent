// Issue reports: report.md + result.json per Issue run, an Allure test per sub-case (steps + screenshots +
// incident viewer attached), and one-page reports for refused / deferred Issues.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { FAILURE_TEXT } from '../executor/failure';
import { manifestMarkdown } from '../executor/manifest';
import type { RunResult } from '../executor/run';
import { attemptsOf, attemptsText } from '../executor/stats';
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

const PHASE_TEXT: Record<string, string> = { lease: '租用', preflight: '预检', launch: '启动', login: '登录', prepare: '准备', warmup: '预热', loop: '循环', teardown: '收尾' };

/** Results written before W2-2 (old conclusion wording, no attempts) read with the new rules: the
 *  conclusion states what was observed, with its denominator (drift rounds were counted as rounds then). */
export function normalizeResult(r: RunResult): RunResult {
  const old = r.conclusion as string;
  const conclusion = old.startsWith('未复现') ? '未复现' : r.conclusion;
  const isBug = r.category !== 'feature';
  const attempts = r.attempts ?? (isBug && r.stats && ['已复现', '未复现'].includes(conclusion) ? attemptsOf(Math.max(0, r.stats.rounds - (r.stats.drifts ?? 0)), r.stats.drifts ?? 0, r.hits.length) : undefined);
  return { ...r, conclusion, attempts, conclusionDetail: old !== conclusion && attempts ? `${attemptsText(attempts)}；${r.conclusionDetail.replace(/^停止原因/, '原停止原因')}` : r.conclusionDetail };
}

export function runMarkdown(d: Draft, input: RunResult[], runDir: string): string {
  const results = input.map(normalizeResult);
  const lines = [`# Issue ${d.issue.id} — ${results.map((r) => r.conclusion).join(' / ') || '未执行'}`, ''];
  const subst = results.find((r) => r.substitution);
  if (subst) lines.push(`> **替代执行**：Issue 端 ${subst.substitution!.from} → 实际 ${results.map((r) => r.surface).join(', ')}。${subst.substitution!.reason}`, '');
  lines.push(`- 预判类别：**${d.classification.category}**（${CAT[d.classification.category]}）— ${d.classification.reason}`, `- 环境：${results[0]?.env ?? '-'}（结论以生产环境为准）`, `- Issue 摘要：${d.issue.title}`);
  if (d.deferredPart) lines.push(`- 暂缓部分：${d.deferredPart}`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.planId} — ${r.conclusion}${r.coverage === 'not-covered' ? '（⚠ 计划未覆盖 Issue 现象，仅说明无崩溃）' : ''}`, '');
    // W2-2 §3.2: three separate lines, each with its basis; the mechanism is a guess from the contract.
    if (r.lead) lines.push(`- **观察到的触发路径**：${r.lead.trigger}（依据：${r.lead.triggerBasis}）`, `- **出现位置**：${r.lead.location}（依据：${r.lead.locationBasis}）`, `- **推测机制**（推测，来自契约，未经验证）：${r.lead.mechanism}`, '');
    if (r.attempts) lines.push(`- **有效尝试**：${attemptsText(r.attempts)}（共 ${r.attempts.rounds} 轮：有效 ${r.attempts.valid}、偏离 ${r.attempts.drift}、命中 ${r.attempts.hits}）`);
    if (r.failure) lines.push(`- **失败归类**：${FAILURE_TEXT[r.failure.kind]}（规则 ${r.failure.rule}）— ${r.failure.reason.slice(0, 300)}`);
    lines.push(...(r.phenomenon ? [`- Issue 现象（契约）：${r.phenomenon.slice(0, 200)}`] : []), `- ${r.title}；执行端 ${r.surface}${r.device ? `（设备 ${r.device}）` : ''}；账号 ${r.account ?? '-'}${r.runTag ? `；运行标记 \`${r.runTag}\`` : ''}`, `- ${r.conclusionDetail}`);
    if (r.error) lines.push(`- 错误：${r.error}`);
    if (r.epilogue) lines.push(`- 收尾对照（只记录，不参与判定）：${r.epilogue.expect} — ${r.epilogue.pass === null ? '未验证' : r.epilogue.pass ? '是' : '否'}；${r.epilogue.detail.slice(0, 240)}`);
    if (r.isolation) lines.push(`- 隔离：干净起点 ${r.isolation.cleanStart.join('；') || '无需处理'}；收尾 ${r.isolation.teardown.join('；') || '-'}`);
    if (r.manifest) lines.push('', '运行清单（manifest.json）：', ...manifestMarkdown(r.manifest).map((l) => `  ${l}`));
    if (r.targets.length) lines.push(`- 准备阶段目标（模型决策后冻结）：${r.targets.map((t) => `${t.id}="${t.chosen}" @(${t.point.x},${t.point.y}) [${t.by}]`).join('；')}`);
    const s = r.stats;
    lines.push('', '| 统计 | 值 |', '|---|---|', `| 总步数 / 轮数 | ${s.steps} / ${s.rounds} |`, `| 总时长 | ${s.durationSec}s |`, `| 动作间隔 平均 / 最大 | ${s.avgIntervalMs}ms / ${s.maxIntervalMs}ms（>1s: ${s.intervalsOverCap} 次） |`, `| App 启动次数 | ${s.launches} |`, `| 操作偏离（重进，不计命中） | ${s.drifts ?? 0} |`, `| 异常门触发 / 可疑信号 | ${s.anomalyGateTriggers} / ${s.suspectSignals} |`, `| 检查点截图 | ${s.checkpointScreenshots} |`, `| 视觉模型调用 | ${s.visionCalls}${s.evidenceReviews ? `（含证据复核 ${s.evidenceReviews} 次）` : ''} |`, `| 文本模型调用 | ${s.textModelCalls} |`, ...(r.phases && Object.keys(r.phases).length ? [`| 各阶段耗时 | ${Object.entries(r.phases).map(([k, v]) => `${PHASE_TEXT[k] ?? k} ${(v / 1000).toFixed(1)}s`).join('，')} |`] : []), '');
    const tierRows = (t: Record<string, { n: number; ms: number }> | undefined) => Object.entries(t ?? {}).map(([k, v]) => `| ${k} | ${v.n} | ${Math.round(v.ms / Math.max(1, v.n))}ms |`);
    if (r.warmup?.steps.length)
      lines.push('### 预热轮（逐步核验）', '', '| 步 | 动作 | 预期效果 | 观察 | 结果 |', '|---|---|---|---|---|', ...r.warmup.steps.map((w) => `| ${w.step} | ${w.action} | ${w.expected} | ${w.observed}${w.healed ? `；自愈 ${w.healed}` : ''} | ${w.pass === null ? '—' : w.pass ? '✅' : '❌'} |`), '');
    if (r.healed?.length) lines.push('### 坐标自愈（本次运行，标定 profile 未修改）', '', ...r.healed.map((h) => `- ${h.element}: ${JSON.stringify(h.from)} → ${JSON.stringify(h.to)}（${h.by}）；候选 profile：healed-profile.json`), '');
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
    // Playwright traces (W2-2 §6): the run's last chunks when it ended without a verdict, and each incident's.
    const traceLine = (f: string) => `[${relative(runDir, f).replace(/\\/g, '/')}](${relative(runDir, f).replace(/\\/g, '/')}) · 打开：\`npx playwright show-trace ${relative(process.cwd(), f).replace(/\\/g, '/')}\``;
    if (r.traces?.length) lines.push('Playwright trace（执行失败 / 计划不可执行时保留的最后两个块）：', ...r.traces.map((t) => `- ${traceLine(join(runDir, r.planId, t))}`), '');
    if (r.incidents.length)
      lines.push(
        '现场包：',
        ...r.incidents.map((i) => {
          const tdir = join(i, 'trace');
          const traces = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith('.zip')).map((f) => `\n  - trace ${traceLine(join(tdir, f))}`) : [];
          return `- [${basename(i)}](${relative(runDir, i).replace(/\\/g, '/')}/index.html) · 重放：\`pnpm autotest replay ${relative(process.cwd(), i).replace(/\\/g, '/')}/replay.json\`${traces.join('')}`;
        }),
        '',
      );
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
  const status = r.conclusion === '已复现' || r.conclusion === '未实现' || r.conclusion === '部分实现' ? 'failed' : r.conclusion === '执行失败' || r.conclusion === 'SKILL 失效' || r.conclusion === '计划不可执行' || r.conclusion === '环境不合格' ? 'broken' : 'passed';
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
  await writeFile(join(runDir, 'result.json'), JSON.stringify({ issue: d.issue.id, status: d.status, category: d.classification.category, reason: d.reason, deferredPart: d.deferredPart, contracts: d.status === 'plannable' ? undefined : d.contracts, results }, null, 2));
  for (const r of results) await writeAllure(d, r, runDir);
  return f;
}

export async function readResult(runDir: string): Promise<any> {
  return JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'));
}
