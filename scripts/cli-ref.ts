// docs/cli-reference.md from `autotest help --json` (W2-3 T11): the reference cannot drift from the code.
//   npx tsx scripts/cli-ref.ts
import { writeFileSync } from 'node:fs';
import { helpDoc } from './cli-v1';

export function cliReference(): string {
const h = helpDoc();
const md = [
  '# 命令行参考（W2-3，面向 Agent）',
  '',
  '> 由 `npx tsx scripts/cli-ref.ts` 从 `autotest help --json` 生成，勿手改。',
  '',
  `用法：\`${h.usage}\``,
  '',
  ...h.notes.map((n) => `- ${n}`),
  '',
  '## 命令',
  '',
  ...h.commands.flatMap((c) => [
    `### \`autotest ${c.command}\``,
    '',
    c.doc,
    '',
    '| 参数 | 类型 | 必填 | 说明 |',
    '|---|---|---|---|',
    ...c.args.map((a) => `| ${a.positional ? `<${a.name}>` : `--${a.name}`} | ${a.type} | ${a.required ? '是' : ''} | ${a.doc} |`),
    '',
    `可能的状态码：${c.codes.map((x) => `\`${x}\``).join('、')}（另有 1 / 40 / 54）`,
    '',
  ]),
  '## 状态码',
  '',
  '| 退出码 | status | code | 含义 |',
  '|---|---|---|---|',
  ...h.statusCodes.map((s) => `| ${s.exit} | ${s.status} | \`${s.code}\` | ${s.meaning} |`),
  '',
  '## 结果信封',
  '',
  '`--json` 时 stdout 只有一个对象：`{ status, code, exit, summary, data?, error? }`；`error = { status, code, message, hint, retryable, kind: env | tool | input | policy }`。`data` 是视图模型（`PlanView` / `EnvView` / `TaskView` / `ResultView`，带 `schemaVersion`），与 Web 页面读的是同一份。',
  '',
];
return md.join('\n');
}

if (process.argv[1] && /cli-ref\.ts$/.test(process.argv[1])) {
  writeFileSync('docs/cli-reference.md', cliReference());
  console.log('docs/cli-reference.md');
}
