// One place that turns (surface, profile, device / account) into a black-box Driver.
import type { Surface } from '../platform/accounts/types';
import type { Profile } from '../skills/profile';
import { AndroidDriver } from './android';
import type { Driver } from './types';
import { WebDriver } from './web';

export interface DriverSpec {
  surface: Surface;
  profile: Profile;
  /** Web app URL of the environment (web surfaces). */
  url: string;
  /** Android surfaces: the phone. */
  udid?: string;
  /** Playwright surfaces: saved login. */
  storageState?: string;
  headless?: boolean;
  onLog?: (at: number, line: string) => void;
  onConsole?: (e: { at: number; type: string; text: string }) => void;
}

export const APP_ERROR_RE = /Exception|Error:|TypeError|ReferenceError|Invariant Violation/;
export const CONSOLE_IGNORE = /favicon|Download the React DevTools|sentry|analytics/i;
export const BROWSER_PACKAGE = process.env.ANDROID_BROWSER_PACKAGE ?? 'com.android.browser';

/** Profile key of a surface: per phone for Android surfaces, per environment otherwise. */
export function profileKey(surface: Surface, env: string, udid?: string): string {
  if (surface === 'android-app') return `android-${udid}@${env}`;
  if (surface === 'android-web') return `android-web-${udid}@${env}`;
  return `${surface}@${env}`;
}

export function createDriver(s: DriverSpec): Driver {
  switch (s.surface) {
    case 'android-app':
    case 'android-web':
      if (!s.udid) throw new Error(`${s.surface} needs a device`);
      return new AndroidDriver({
        udid: s.udid,
        surface: s.surface,
        packageName: s.profile.packageName ?? (s.surface === 'android-web' ? BROWSER_PACKAGE : 'ai.teamily.mobile'),
        url: s.surface === 'android-web' ? s.url : undefined,
        onLog: s.onLog,
        appErrorRe: s.surface === 'android-app' ? APP_ERROR_RE : undefined,
      });
    default:
      return new WebDriver({ surface: s.surface, url: s.url, storageState: s.storageState, headless: s.headless, onConsole: s.onConsole, consoleIgnore: CONSOLE_IGNORE });
  }
}
