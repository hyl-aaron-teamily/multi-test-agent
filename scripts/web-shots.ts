// T8 acceptance aid: screenshot every page of the Web console (platform must be running) into
// midscene_run/web-shots/<stamp>/, and report console errors. Usage:
//   npx tsx scripts/web-shots.ts [--task <id>] [--result <id> …] [--plan <id>] [--env <id>]
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const BASE = `http://localhost:${process.env.PLATFORM_PORT ?? 3210}`;
const args = process.argv.slice(2);
const all = (k: string) => args.flatMap((a, i) => (a === `--${k}` && args[i + 1] ? [args[i + 1]] : []));

async function main() {
  const pages: [string, string][] = [
    ['overview', '#/'],
    ['new-explore', '#/new'],
    ['new-issue', '#/new?tab=issue'],
    ['new-sync', '#/new?tab=sync'],
    ['approvals', '#/approvals'],
    ...all('task').map((id): [string, string] => [`task-${id}`, `#/task/${encodeURIComponent(id)}`]),
    ...all('result').map((id): [string, string] => [`result-${id}`, `#/result/${encodeURIComponent(id)}`]),
    ...all('plan').map((id): [string, string] => [`plan-${id.replace(/[^\w@-]/g, '_')}`, `#/plan/${encodeURIComponent(id)}`]),
    ...all('env').map((id): [string, string] => [`env-${id.replace(/[^\w@-]/g, '_')}`, `#/env/${encodeURIComponent(id)}`]),
  ];
  const dir = resolve('midscene_run/web-shots', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  for (const [name, hash] of pages) {
    const before = errors.length;
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const file = join(dir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const h1 = await page.locator('h1, h2').first().textContent().catch(() => '');
    console.log(`${name.padEnd(36)} ${errors.length > before ? '✗' : '✓'} ${(h1 ?? '').trim().slice(0, 50)}  → ${file}`);
  }
  await browser.close();
  if (errors.length) console.log(`\n${errors.length} error(s):\n${[...new Set(errors)].join('\n')}`);
  process.exit(errors.length ? 1 : 0);
}

void main();
