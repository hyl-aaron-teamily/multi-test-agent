// A forced update taking the app's screen (W3-4 E1 ③): the device needs a newer APK — an environment problem
// ("需要新版本 APK"), never a finding about the app. Pure, shared by the run start, the failure classification
// and the emulator tooling.

/** Is the screen a store / update page instead of the app? `focus` = `dumpsys window` mCurrentFocus. */
export function forcedUpdate(focus: string | undefined, texts: string[] = []): boolean {
  if (/com\.android\.vending|\bmarket\b|appgallery|getapps/i.test(focus ?? '')) return true;
  return texts.some((t) => /(必须|需要|请).{0,6}(更新|升级)|发现新版本|新版本.{0,8}(更新|升级)|update (required|now|to continue)|new version (is )?available/i.test(t));
}

export const FORCED_UPDATE_TEXT = /需要新版本 APK/;
