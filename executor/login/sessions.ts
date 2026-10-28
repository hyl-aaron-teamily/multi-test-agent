// Web session cache: Playwright storageState per account at platform/secrets/sessions/<id>.json
// (gitignored). A stale session (app redirects to /login) is replaced by a fresh cursor login.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { WebDriver } from '../../drivers/web';
import { loadProfile, pointOf } from '../../skills/profile';
import { runNode } from '../../skills/teamily/nodes';
import type { AccountPool } from '../../platform/accounts/account-pool';
import type { Surface } from '../../platform/accounts/types';

export type PlaywrightSurface = Extract<Surface, 'desktop-web' | 'mobile-web'>;

export const SESSIONS_DIR = resolve('platform/secrets/sessions');

export const sessionFile = (accountId: string) => join(SESSIONS_DIR, `${accountId}.json`);

export interface SessionResult {
  ok: boolean;
  file: string;
  reused: boolean;
  error?: string;
}

/** True if the saved state still lands on the chat app (not on /login). */
async function sessionValid(url: string, file: string, surface: PlaywrightSurface): Promise<boolean> {
  if (!existsSync(file)) return false;
  const d = new WebDriver({ surface, url, storageState: file });
  try {
    await d.launch();
    await d.p.waitForTimeout(5000);
    return !/\/login\b/.test(new URL(d.p.url()).pathname);
  } catch {
    return false;
  } finally {
    await d.close();
  }
}

/** Reuse or create the web session of an account by cursor/keyboard login with the calibrated profile. */
export async function ensureWebSession(pool: AccountPool, accountId: string, surface: PlaywrightSurface = 'desktop-web', force = false): Promise<SessionResult> {
  const acc = pool.get(accountId);
  if (!acc) return { ok: false, file: '', reused: false, error: `no account ${accountId}` };
  const url = pool.webUrl(acc.env);
  const file = sessionFile(accountId);
  if (!force && (await sessionValid(url, file, surface))) {
    await pool.markLogin(accountId, true);
    return { ok: true, file, reused: true };
  }
  const profile = loadProfile(`${surface}@${acc.env}`) ?? loadProfile(`desktop-web@${acc.env}`);
  if (!profile) return { ok: false, file, reused: false, error: `no calibrated profile ${surface}@${acc.env} — run \`pnpm autotest skill calibrate --surface ${surface} --env ${acc.env}\`` };
  const d = new WebDriver({ surface: profile.surface as 'desktop-web', url });
  try {
    await d.launch();
    await d.p.waitForTimeout(5000);
    const ctx = { driver: d, profile, targets: {}, credentials: () => pool.backend.get(accountId) };
    await runNode('teamily.login', {}, ctx);
    let reached = await d.p.waitForURL(/\/(chat|onboarding)/, { timeout: 30_000 }).then(() => true, () => false);
    if (reached && /\/onboarding/.test(d.p.url()) && profile.elements['onboarding.skip']) {
      // A fresh browser's first sign-in shows the onboarding page: skip it (calibrated button).
      await d.p.waitForTimeout(3000);
      await d.tap(pointOf(profile, 'onboarding.skip'));
      reached = await d.p.waitForURL(/\/chat/, { timeout: 30_000 }).then(() => true, () => false);
    }
    if (!reached) {
      // One retry from a fresh login page (slow prod responses between the email and password steps).
      await d.launch();
      await d.p.waitForTimeout(5000);
      await runNode('teamily.login', {}, ctx);
      await d.p.waitForURL(/\/chat/, { timeout: 30_000 });
    }
    await d.p.waitForTimeout(3000);
    await mkdir(dirname(file), { recursive: true });
    await d.context!.storageState({ path: file });
    await pool.markLogin(accountId, true);
    return { ok: true, file, reused: false };
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    // Local-only evidence (platform/state is gitignored); the password field is masked on screen.
    await d.page?.screenshot({ path: resolve('platform/state', `login-fail-${accountId}.png`) }).catch(() => {});
    await pool.markLogin(accountId, false, msg);
    return { ok: false, file, reused: false, error: msg };
  } finally {
    await d.close();
  }
}
