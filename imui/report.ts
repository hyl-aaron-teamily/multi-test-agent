// imui report.md — same shape as imload's console report (series lines, delivery, counters, SLO),
// plus the UI-only parts: per-client resolution, lost tokens and missing echoes.
import type { SeriesSummary } from './metrics';

const line = (name: string, s: SeriesSummary) =>
  s.count
    ? `| ${name} | ${s.count} | ${s.min} | ${s.p50} | ${s.p90} | ${s.p95} | ${s.p99} | ${s.max} | ${s.avg} |`
    : `| ${name} | 0 | - | - | - | - | - | - | - |`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderReport(r: any): string {
  const m = r.metrics;
  const d = m.delivery;
  return [
    `# imui ${r.command} \`${r.runId}\` — ${r.verdict}${r.prod ? ' [prod]' : ''}`,
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| 环境 | Web：${r.clients.some((c: any) => c.kind === 'web') ? r.env : '未使用'} · Android：${r.clients.some((c: any) => c.kind === 'android') ? (r.prod ? '按生产处理（IMUI_ANDROID_ENV，默认 prod）' : '测试') : '未使用'} |`,
    `| 客户端 | ${r.clients.map((c: any) => `${c.id}（${c.resolutionMs ? `观察分辨率≈${c.resolutionMs}ms` : '事件驱动'}${c.idleFailures ? `，界面不空闲读取失败 ${c.idleFailures} 次` : ''}）`).join('、')} |`,
    `| 发送方 | ${r.senders.join('、')} |`,
    `| 参数 | duration ${r.flags.duration}s · rate ${r.flags.rate}/s/sender · ramp ${r.flags.ramp}s · drain ${r.flags.drain}s · types ${r.flags.msgTypes.join(',')} · payload ${r.flags.payloadBytes}B |`,
    `| 发送 | ${m.messagesSent} 条，${m.sendRatePerSec}/s，用时 ${m.wallSeconds}s |`,
    `| 投递 | expected ${d.expected} · delivered ${d.delivered} · lost ${d.lost} · loss ${(d.lossRatio * 100).toFixed(2)}% |`,
    `| 界面异常 | 自身气泡未出现 ${m.echoMissing} · 重复气泡 ${m.duplicates} · 乱序 ${m.outOfOrder} · 非本轮 token ${m.unexpected} |`,
    `| 错误 | send ${JSON.stringify(m.sendErrors)} · client ${JSON.stringify(m.clientErrors)} |`,
    '',
    '## 延迟（ms）',
    '',
    '| 指标 | count | min | p50 | p90 | p95 | p99 | max | avg |',
    '|---|---|---|---|---|---|---|---|---|',
    line('ui_echo_ms（按发送 → 自己界面出现）', m.ui_echo_ms),
    line('ui_e2e_ms（按发送 → 观察端界面出现）', m.ui_e2e_ms),
    ...Object.entries(m.byMsgType).flatMap(([t, s]: [string, any]) => [line(`${t} · echo`, s.ui_echo_ms), line(`${t} · e2e`, s.ui_e2e_ms)]),
    '',
    'Android 观察靠轮询无障碍树，延迟包含最多一个轮询周期的误差；Web 由 MutationObserver 事件驱动。',
    '',
    '## SLO',
    '',
    r.sloFailures.length ? r.sloFailures.map((f: string) => `- ❌ ${f}`).join('\n') : `- ✅ 通过（配置：${JSON.stringify(r.slo)}；未配置的阈值只出报表不判定）`,
    '',
    ...(r.lost.length ? ['## 未送达', '', ...r.lost.slice(0, 50).map((x: any) => `- \`${x.token}\` 未出现在：${x.missingOn.join('、')}`), ''] : []),
    ...(r.echoMissing.length ? ['## 发送方自身未显示', '', ...r.echoMissing.slice(0, 50).map((t: string) => `- \`${t}\``), ''] : []),
  ].join('\n');
}
