// Account pool types. No credential ever lives in these objects — see secret-backend.ts.
export type Env = 'test' | 'prod';
export type AccountStatus = 'idle' | 'busy' | 'disabled' | 'login-failed';
export type Surface = 'android-app' | 'mobile-web' | 'desktop-web';
export const SURFACES: Surface[] = ['android-app', 'mobile-web', 'desktop-web'];

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
