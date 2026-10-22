// Sign-in for surfaces that keep their own session (the phone's browser):
// after launch, if the login page is on screen (its calibrated reference region), sign in with the leased
// account by coordinates (teamily.login), then wait for the home screen. Nothing is read from the page.
import { evaluateVisual } from '../../executor/checks';
import type { Driver } from '../../drivers/types';
import { sleep } from '../../drivers/types';
import { type Profile, SkillStaleError } from '../../skills/profile';
import { runNode } from '../../skills/teamily/nodes';
import { assertSkillFresh } from '../../executor/checks';
import type { AccountPool } from './account-pool';

/** True when the login page is shown (calibrated login/form region matches). */
export async function onLoginPage(d: Driver, p: Profile): Promise<boolean> {
  if (!p.refs.login?.regions.form) return false;
  return (await evaluateVisual(d, p, { kind: 'visual-region', page: 'login', region: 'form', expect: 'login page shown', want: 'present', onlyOnAnomaly: false })).pass === true;
}

/** Sign in if needed. Returns 'signed-in' (was already), 'logged-in' (did it now); throws if it fails. */
export async function ensureUiLogin(d: Driver, p: Profile, pool: AccountPool, accountId: string, log = (s: string) => console.log(`[login] ${s}`)): Promise<'signed-in' | 'logged-in'> {
  if (!(await onLoginPage(d, p))) return 'signed-in';
  log(`${d.surface}: login page shown — signing in ${accountId} by coordinates`);
  await runNode('teamily.login', {}, { driver: d, profile: p, targets: {}, credentials: () => pool.backend.get(accountId), settleMs: 4000 });
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    if (await assertSkillFresh(d, p).then(() => true, (e) => (e instanceof SkillStaleError ? false : Promise.reject(e)))) {
      await pool.markLogin(accountId, true);
      return 'logged-in';
    }
  }
  await pool.markLogin(accountId, false, 'home screen not reached after login');
  throw new Error(`${d.surface}: login as ${accountId} did not reach the home screen`);
}
