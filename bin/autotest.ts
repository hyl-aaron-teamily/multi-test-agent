// Unified entry. Forwards to the existing scripts so earlier entry points keep working unchanged.
//
//   pnpm autotest mission "聊天时偶发闪退，试试能不能重现" [--package <pkg>] [--max-steps N] [--max-minutes M] [--device <udid>]
//   pnpm autotest explore --package <pkg> [--device <udid>]
//   pnpm autotest monkey  --package <pkg> [--seed <n>] [--events <n>] [--device <udid>]
//   pnpm autotest web:smoke
//   pnpm autotest devices [--json]
//   pnpm autotest report
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { listDevices } from '../platform/adb-devices';

const [cmd, ...rest] = process.argv.slice(2);

const SCRIPTS: Record<string, string> = {
  mission: 'scripts/mission.ts',
  explore: 'scripts/explore.ts',
  monkey: 'scripts/monkey.ts',
  report: 'report/problem-report.ts',
};

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((res) => {
    const child = spawn(bin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => res(code ?? 1));
    child.on('error', (e) => {
      console.error(e.message);
      res(1);
    });
  });
}

const tsx = resolve('node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const vitest = resolve('node_modules/.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');

async function main(): Promise<number> {
  if (cmd && SCRIPTS[cmd]) return run(tsx, [SCRIPTS[cmd], ...rest]);
  if (cmd === 'web:smoke') return run(vitest, ['run', '--project', 'web', ...rest]);
  if (cmd === 'devices') {
    const devices = await listDevices();
    if (rest.includes('--json')) console.log(JSON.stringify(devices, null, 2));
    else if (!devices.length) console.log('(no adb devices)');
    else for (const d of devices) console.log(`${d.udid.padEnd(20)} ${d.state.padEnd(13)} ${d.model ?? ''}`);
    return 0;
  }
  console.error('Usage: pnpm autotest <mission|explore|monkey|web:smoke|devices|report> [...args]');
  return 2;
}

main().then((code) => process.exit(code));
