// Execution session: one implementation of "profile → web session → driver → launch → sign in → back
// to the home list", shared by the Issue executor, the multi-client sync, coordinate replay and smoke.
// Surface-specific behaviour (how a phone browser gets back to the list, which dialogs appear, how long a
// page takes to load) lives in the surface adapters (./surfaces), not in the callers.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDriver, profileKey } from '../drivers/factory';
import type { Driver } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { RecordingDriver } from '../incident/recording-driver';
import type { AccountPool } from '../platform/accounts/account-pool';
import { ensureWebSession, type PlaywrightSurface } from './login/sessions';
import { type Env, onPlaywright, type Surface } from '../platform/accounts/types';
import { loadProfile, type Profile, SkillStaleError } from '../skills/profile';
import { assertSkillFresh } from './checks';
import { fingerprintedOf, type Healed, healElements } from './heal';
import { adapterFor, type SurfaceAdapter } from './surfaces';

export interface SessionOptions {
  surface: Surface;
  env: Env;
  account: string;
  udid?: string;
  pool: AccountPool;
  headed?: boolean;
  /** Use this profile instead of the calibrated one (replay of a recorded profile, tests). */
  profile?: Profile;
  url?: string;
  onLog?: (at: number, line: string) => void;
  onConsole?: Parameters<typeof createDriver>[0]['onConsole'];
  log?: (s: string) => void;
}

export interface Session {
  surface: Surface;
  profile: Profile;
  url: string;
  inner: Driver;
  d: RecordingDriver;
  web?: WebDriver;
  adapter: SurfaceAdapter;
  account: string;
  udid?: string;
  pool: AccountPool;
  log: (s: string) => void;
}

/** Profile + (web) signed-in session + driver. Nothing is launched yet. */
export async function openSession(o: SessionOptions): Promise<Session> {
  const name = profileKey(o.surface, o.env, o.udid);
  const profile = o.profile ?? loadProfile(name);
  if (!profile) throw new Error(`no SKILL profile ${name} — run \`pnpm autotest skill calibrate --surface ${o.surface} --env ${o.env}${o.udid ? ` --device ${o.udid}` : ''}\``);
  const url = o.url ?? o.pool.webUrl(o.env);
  let storageState: string | undefined;
  if (onPlaywright(o.surface)) {
    const s = await ensureWebSession(o.pool, o.account, o.surface as PlaywrightSurface);
    if (!s.ok) throw new Error(`login failed for ${o.account}: ${s.error}`);
    storageState = s.file;
  }
  if ((o.surface === 'android-app' || o.surface === 'android-web') && !o.udid) throw new Error(`${o.surface} session without a device`);
  const inner = createDriver({ surface: o.surface, profile, url, udid: o.udid, storageState, headless: !o.headed, onLog: o.onLog, onConsole: o.onConsole });
  return { surface: o.surface, profile, url, inner, d: new RecordingDriver(inner), web: inner instanceof WebDriver ? inner : undefined, adapter: adapterFor(o.surface), account: o.account, udid: o.udid, pool: o.pool, log: o.log ?? ((s) => console.log(`[session] ${s}`)) };
}

export interface EnterOptions {
  /** After the first launch, before waiting (web flight recorder start). */
  afterLaunch?: () => Promise<void>;
  /** Tap the chat tab at the end (phones: the bottom bar looks the same on every tab). */
  chatTab?: boolean;
  /** Where to save the screen when the SKILL is stale. */
  staleShot?: string;
  /** Self-heal by fingerprint before reporting a stale SKILL: candidate profile goes here. */
  healDir?: string;
  onHeal?: (h: Healed[]) => void;
}

/** Launch once, wait for the first screen, dismiss known dialogs, sign in if needed, get back to the
 *  home list and check the SKILL is still valid (SkillStaleError otherwise). */
export async function enterApp(s: Session, o: EnterOptions = {}): Promise<void> {
  const { d, profile, adapter } = s;
  await adapter.beforeLaunch?.(s);
  d.label = 'launch';
  await d.launch();
  await o.afterLaunch?.();
  await adapter.waitFirstScreen(s);
  await adapter.dismissDialogs(s);
  await adapter.ensureLogin(s);
  for (let i = 0; ; i++) {
    try {
      await assertSkillFresh(d, profile);
      break;
    } catch (e) {
      if (!(e instanceof SkillStaleError) || !(await adapter.recoverHome(s, i))) {
        // Layout moved but the home elements are still there (found by their fingerprints): heal and go on.
        if (e instanceof SkillStaleError && o.healDir) {
          const healed = await healElements(s, fingerprintedOf(profile, 'home'), o.healDir);
          if (healed.length) {
            s.log(`SKILL check failed but ${healed.length} home element(s) re-resolved by fingerprint — continuing with healed coordinates (calibrated profile unchanged): ${healed.map((h) => h.element).join(', ')}`);
            o.onHeal?.(healed);
            break;
          }
        }
        if (e instanceof SkillStaleError && o.staleShot) await writeFile(o.staleShot, await d.screenshot()).catch(() => {});
        throw e;
      }
    }
  }
  if (o.chatTab) await adapter.showChatTab(s);
  d.drainAnomalies(); // page-load noise before the test starts
}

/** Close the driver (and its browser). */
export async function closeSession(s: Session | undefined): Promise<void> {
  await s?.inner.close().catch(() => {});
}

export const staleShotPath = (runDir: string) => join(runDir, 'skill-stale.png');
