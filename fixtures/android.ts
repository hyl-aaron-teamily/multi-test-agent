// Android device discovery + Midscene AndroidAgent, mirroring fixtures/page.ts for web.
// No vitest imports here so scripts/loop-android.ts can reuse it outside the test runner.
// ref: midscene-example/android/vitest-demo/tests/todo.test.ts
//      (getConnectedDevices → new AndroidDevice(udid, opts) → new AndroidAgent → device.connect())
// ref: midscene-example/android/javascript-sdk-demo/demo.ts (autoDismissKeyboard, popup context)
// ref: @midscene/android index.d.ts — getConnectedDevices(deviceOptions?): Promise<Device[]> ({udid, state}),
//      AndroidAgent(device, AndroidAgentOpt), agent.launch / agent.terminate
// ref: @midscene/shared agent-context.d.ts — aiContexts.aiAct (aiActionContext is deprecated)
import { AndroidAgent, AndroidDevice, getConnectedDevices } from '@midscene/android';
import { resolveAdbPath } from '../core/adb';
import { assertModelCredentials } from '../core/credentials';

export { forceStopApp, launchApp, screencap } from '../core/adb';

export class NoAndroidDeviceError extends Error {
  constructor(detail: string) {
    super(`[no device] 未检测到已连接的 ADB 设备 / No authorized Android device found. ${detail}`);
    this.name = 'NoAndroidDeviceError';
  }
}

const POPUP_CONTEXT =
  'If a permission, location, user agreement or similar system popup appears, tap Allow / Agree. ' +
  'If a login page pops up, close it.';

function adbOptions() {
  const adbPath = resolveAdbPath();
  return adbPath === 'adb' ? {} : { androidAdbPath: adbPath };
}

/**
 * Pick the device to run on: DEVICE_ID if set, else the first authorized device.
 * Throws NoAndroidDeviceError with a readable hint when nothing usable is attached.
 */
export async function getAndroidDevice(): Promise<{ udid: string; all: string[] }> {
  let devices;
  try {
    devices = await getConnectedDevices(adbOptions());
  } catch (err) {
    // Underlying message can embed the whole PATH; keep only its first sentence.
    const reason = (err as Error).message.split(/ nor in any folders|\n/)[0];
    throw new NoAndroidDeviceError(
      `adb "${resolveAdbPath()}" could not list devices (${reason}). ` +
        'Check that adb is installed and on PATH, or set MIDSCENE_ADB_PATH (see env-plan.md).',
    );
  }
  const ready = devices.filter((d) => d.state === 'device');
  const unauthorized = devices.filter((d) => d.state === 'unauthorized');
  const wanted = process.env.DEVICE_ID?.trim();

  if (wanted) {
    if (ready.some((d) => d.udid === wanted)) return { udid: wanted, all: ready.map((d) => d.udid) };
    throw new NoAndroidDeviceError(`DEVICE_ID=${wanted} is not among authorized devices [${ready.map((d) => d.udid).join(', ')}].`);
  }
  if (ready.length > 0) return { udid: ready[0].udid, all: ready.map((d) => d.udid) };
  if (unauthorized.length > 0) {
    throw new NoAndroidDeviceError(
      `${unauthorized.map((d) => d.udid).join(', ')} is unauthorized: tap "Allow USB debugging" on the device screen, then run \`adb devices -l\` again.`,
    );
  }
  throw new NoAndroidDeviceError('Enable USB debugging, connect the phone, and confirm `adb devices -l` lists it as "device".');
}

export interface AndroidContext {
  udid: string;
  device: AndroidDevice;
  agent: AndroidAgent;
}

export interface AndroidAgentOptions {
  /** Midscene report grouping, e.g. the test or loop name. */
  groupName?: string;
  reportFileName?: string;
}

/** Credentials → device → connected AndroidDevice + AndroidAgent. */
export async function createAndroidAgent(
  deviceId?: string,
  options: AndroidAgentOptions = {},
): Promise<AndroidContext> {
  // Check both prerequisites so the error lists every blocker at once.
  const problems: Error[] = [];
  let udid = deviceId;
  try {
    assertModelCredentials();
  } catch (err) {
    problems.push(err as Error);
  }
  if (!udid) {
    try {
      udid = (await getAndroidDevice()).udid;
    } catch (err) {
      problems.push(err as Error);
    }
  }
  if (problems.length === 1) throw problems[0];
  if (problems.length > 1) {
    throw new Error(problems.map((e) => e.message).join('\n'));
  }
  if (!udid) throw new NoAndroidDeviceError('');
  const device = new AndroidDevice(udid, {
    ...adbOptions(),
    // Avoid BACK/ESC side effects that can clear input (see javascript-sdk-demo/demo.ts).
    autoDismissKeyboard: false,
  });
  const agent = new AndroidAgent(device, {
    aiContexts: { aiAct: POPUP_CONTEXT },
    groupName: options.groupName,
    reportFileName: options.reportFileName?.replace(/[^\w.-]+/g, '_'),
  });
  await device.connect();
  return { udid, device, agent };
}
