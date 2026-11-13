// Saved runs from the command line (platform/session.ts). Runs not saved are deleted when the platform stops.
//   pnpm autotest runs save <task-id | path under midscene_run/> [--name <name>]   「另存为」
//   pnpm autotest runs saved                                                       list
//   pnpm autotest runs open <name>                                                 back into this session
//   pnpm autotest runs delete <name>                                               for good
import { existsSync } from 'node:fs';
import { getTask } from '../platform/lifecycle/task';
import { deleteSaved, listSaved, openSaved, savePath, saveTask } from '../platform/session';

const [cmd, target, ...rest] = process.argv.slice(2);
const i = rest.indexOf('--name');
const name = i >= 0 ? rest[i + 1] : undefined;
const USAGE = 'Usage: pnpm autotest runs save <task-id | path under midscene_run/> [--name <name>] | runs saved | runs open <name> | runs delete <name>';

try {
  if (cmd === 'save' && target) {
    const t = getTask(target);
    const r = t ? saveTask(t, name) : existsSync(target) ? savePath(target, name) : undefined;
    if (!r) throw new Error(`${target} 既不是任务 id，也不是存在的路径`);
    console.log(`已另存为 ${r.dir}（${r.items.join('、')}）`);
  } else if (cmd === 'saved') {
    const list = listSaved();
    if (!list.length) console.log('没有存档');
    for (const x of list) console.log(`${x.savedAt.slice(0, 19)}  ${x.name}  ← ${x.source}${x.summary ? `  ${x.summary}` : ''}`);
  } else if (cmd === 'open' && target) {
    const r = openSaved(target);
    console.log(r.already ? `存档「${target}」已经打开` : `已打开存档「${target}」${r.taskId ? `：任务 ${r.taskId}` : ''}`);
    for (const p of r.opened) console.log(`  ${p}`);
  } else if (cmd === 'delete' && target) {
    deleteSaved(target);
    console.log(`已删除存档「${target}」`);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
