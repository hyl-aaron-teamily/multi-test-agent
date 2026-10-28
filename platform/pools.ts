// Account pool + endpoint pool, loaded and refreshed (one helper for CLI commands).
import { AccountPool } from './accounts/account-pool';
import { DevicePool } from './device-pool';

export async function openPools(): Promise<{ pool: AccountPool; devices: DevicePool }> {
  const pool = new AccountPool();
  await pool.reload();
  const devices = new DevicePool();
  await devices.reloadConfig();
  await devices.refresh();
  return { pool, devices };
}
