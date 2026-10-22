// Account pool types. No credential ever lives in these objects — see secret-backend.ts.
export type Env = 'test' | 'prod';
export type AccountStatus = 'idle' | 'busy' | 'disabled' | 'login-failed';
export type Surface = 'android-app' | 'android-web' | 'mobile-web' | 'desktop-web';
export const SURFACES: Surface[] = ['android-app', 'android-web', 'mobile-web', 'desktop-web'];

/** Where a surface runs and how the user drives it.
 *   android-app : the Teamily app on a phone (adb input, screencap, logcat)
 *   android-web : Teamily web in the phone's own browser (same phone, same adb input — no CDP)
 *   mobile-web  : Teamily web in an emulated phone viewport (Playwright, host)
 *   desktop-web : Teamily web in a desktop browser (Playwright, host; on Windows: Microsoft Edge, maximized) */
export const SURFACE_TRAITS: Record<Surface, { host: 'android' | 'playwright'; mobileLayout: boolean; webUi: boolean; app: boolean }> = {
  'android-app': { host: 'android', mobileLayout: true, webUi: false, app: true },
  'android-web': { host: 'android', mobileLayout: true, webUi: true, app: false },
  'mobile-web': { host: 'playwright', mobileLayout: true, webUi: true, app: false },
  'desktop-web': { host: 'playwright', mobileLayout: false, webUi: true, app: false },
};
export const onAndroid = (s: Surface) => SURFACE_TRAITS[s].host === 'android';
export const onPlaywright = (s: Surface) => SURFACE_TRAITS[s].host === 'playwright';
export const mobileLayout = (s: Surface) => SURFACE_TRAITS[s].mobileLayout;

export interface Account {
  id: string;
  env: Env;
  email: string;
  tags: string[];
  surfaces: Surface[];
  status: AccountStatus;
  taskId?: string;
  boundDevice?: string;
  lastLogin?: string;
  lastLoginOk?: boolean;
  lastError?: string;
  cooldownUntil?: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface EnvConfig {
  webUrl: string;
}
