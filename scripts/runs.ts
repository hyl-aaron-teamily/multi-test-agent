// 「另存为」 from the command line (platform/session.ts). Runs not saved are deleted when the platform stops.
//   pnpm autotest runs save <task-id | path under midscene_run/> [--name <name>]
//   pnpm autotest runs saved
import { existsSync } from 'node:fs';
import { getTask } from '../platform/lifecycle/task';
import { listSaved, savePath, saveTask } from '../platform/session';

const [cmd, target, ...rest] = process.argv.slice(2);
const i = rest.indexOf('--name');
const name = i >= 0 ? rest[i + 1] : undefined;

if (cmd === 'save' && target) {
  const t = getTask(target);
  try {
    const r = t ? saveTask(t, name) : existsSync(target) ? savePath(target, name) : undefined;
    if (!r) throw new Error(`${target} 既不是任务 id，也不是存在的路径`);
    console.log(`已另存为 ${r.dir}（${r.items.join('、')}）`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
} else if (cmd === 'saved') {
  const list = listSaved();
  if (!list.length) console.log('没有另存的运行');
  for (const x of list) console.log(`${x.savedAt.slice(0, 19)}  ${x.name}  ← ${x.source}${x.summary ? `  ${x.summary}` : ''}`);
} else {
  console.error('Usage: pnpm autotest runs save <task-id | path under midscene_run/> [--name <name>] | runs saved');
  process.exit(2);
}
