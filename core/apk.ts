// APK files the user drops into apk/<app>/ (W3-4 E1 ③, contract K8): read package / versionCode / versionName
// straight from the APK (zip central directory → AndroidManifest.xml → binary XML), so neither aapt nor the
// Android build-tools are needed (the platform container has neither). Then install / upgrade a device from the
// newest set: one APK file directly in the folder is one set; a sub-folder holding several APKs is one split set
// (`adb install-multiple`).
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { adb } from './adb';

const run = promisify(execFile);

export interface ApkInfo {
  package: string;
  versionCode: number;
  versionName?: string;
}

export interface ApkSet extends ApkInfo {
  /** Files to install: the base APK first, then the splits. */
  files: string[];
  /** Folder name or file name, for messages. */
  label: string;
}

export const APK_ROOT = resolve(process.env.AUTOTEST_APK_DIR ?? 'apk');

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  const n = readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

/** One entry of a zip file, uncompressed (stored or deflated only; no zip64 — APKs here are < 4 GB). */
export function zipEntry(file: string, name: string): Buffer | undefined {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${file}: not a zip (no end of central directory)`);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = readAt(fd, cdOff, cdSize);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const entry = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      p += 46 + nlen + elen + clen;
      if (entry !== name) continue;
      const lh = readAt(fd, local, 30);
      const data = readAt(fd, local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), csize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${file}: ${name} uses zip method ${method}`);
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

const RES_VERSION_CODE = 0x0101021b;
const RES_VERSION_NAME = 0x0101021c;

function stringPool(b: Buffer, at: number): string[] {
  const headerSize = b.readUInt16LE(at + 2);
  const count = b.readUInt32LE(at + 8);
  const utf8 = (b.readUInt32LE(at + 16) & 0x100) !== 0;
  const stringsStart = at + b.readUInt32LE(at + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + b.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      p += b[p] & 0x80 ? 2 : 1; // length in UTF-16 units
      let n = b[p];
      if (n & 0x80) n = ((n & 0x7f) << 8) | b[p + 1], p += 2;
      else p += 1;
      out.push(b.subarray(p, p + n).toString('utf8'));
    } else {
      let n = b.readUInt16LE(p);
      if (n & 0x8000) n = ((n & 0x7fff) << 16) | b.readUInt16LE(p + 2), p += 4;
      else p += 2;
      out.push(b.subarray(p, p + n * 2).toString('utf16le'));
    }
  }
  return out;
}

/** Pure: package / versionCode / versionName from a binary AndroidManifest.xml. */
export function parseManifest(b: Buffer): ApkInfo {
  if (b.readUInt16LE(0) !== 0x0003) throw new Error('not a binary XML manifest');
  let strings: string[] = [];
  let resIds: number[] = [];
  for (let p = b.readUInt16LE(2); p + 8 <= b.length; ) {
    const type = b.readUInt16LE(p);
    const size = b.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = stringPool(b, p);
    else if (type === 0x0180) resIds = Array.from({ length: (size - 8) / 4 }, (_, i) => b.readUInt32LE(p + 8 + i * 4));
    else if (type === 0x0102) {
      const name = strings[b.readUInt32LE(p + 20)];
      if (name === 'manifest') {
        const attrStart = b.readUInt16LE(p + 24);
        const attrSize = b.readUInt16LE(p + 26);
        const count = b.readUInt16LE(p + 28);
        const info: Partial<ApkInfo> = {};
        for (let i = 0; i < count; i++) {
          const a = p + 16 + attrStart + i * attrSize;
          const ni = b.readUInt32LE(a + 4);
          const raw = b.readUInt32LE(a + 8);
          const dataType = b[a + 15];
          const data = b.readUInt32LE(a + 16);
          const an = strings[ni] ?? '';
          const rid = resIds[ni];
          const str = raw !== 0xffffffff ? strings[raw] : dataType === 0x03 ? strings[data] : undefined;
          if (an === 'package') info.package = str;
          else if (an === 'versionCode' || rid === RES_VERSION_CODE) info.versionCode = str !== undefined && dataType === 0x03 ? Number(str) : data;
          else if (an === 'versionName' || rid === RES_VERSION_NAME) info.versionName = str ?? String(data);
        }
        if (!info.package || info.versionCode === undefined) throw new Error('manifest has no package / versionCode');
        return info as ApkInfo;
      }
    }
    p += size;
  }
  throw new Error('no <manifest> element');
}

export function readApk(file: string): ApkInfo {
  const m = zipEntry(file, 'AndroidManifest.xml');
  if (!m) throw new Error(`${file}: no AndroidManifest.xml`);
  return parseManifest(m);
}

/** Every installable set under apk/<app>/, newest versionCode first. Unreadable files are reported, not thrown. */
export function apkSets(app = 'teamily', root = APK_ROOT): { sets: ApkSet[]; errors: string[] } {
  const dir = join(root, app);
  const sets: ApkSet[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { sets, errors };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      if (e.isFile() && /\.apk$/i.test(e.name)) sets.push({ ...readApk(p), files: [p], label: e.name });
      else if (e.isDirectory()) {
        const files = readdirSync(p).filter((f) => /\.apk$/i.test(f)).map((f) => join(p, f));
        if (!files.length) continue;
        // The base APK is the one without a `split` attribute: the one whose name is base.apk, else the largest.
        const base = files.find((f) => /(^|[\\/])base\.apk$/i.test(f)) ?? [...files].sort((a, b) => statSync(b).size - statSync(a).size)[0];
        sets.push({ ...readApk(base), files: [base, ...files.filter((f) => f !== base)], label: e.name });
      }
    } catch (err) {
      errors.push(`${e.name}: ${(err as Error).message}`);
    }
  }
  sets.sort((a, b) => b.versionCode - a.versionCode);
  return { sets, errors };
}

/** Installed version on the device (undefined = not installed). */
export async function installedVersion(udid: string, pkg: string): Promise<{ versionCode: number; versionName?: string } | undefined> {
  const out = await adb(['shell', `dumpsys package ${pkg} | grep -E -m2 'versionCode=|versionName='`], udid, 15_000).catch(() => '');
  const code = out.match(/versionCode=(\d+)/)?.[1];
  return code ? { versionCode: Number(code), versionName: out.match(/versionName=(\S+)/)?.[1] } : undefined;
}

/** Pure: does the device need the newest set? Never downgrades. */
export function needsInstall(installed: { versionCode: number } | undefined, newest: ApkSet | undefined): boolean {
  return !!newest && (!installed || installed.versionCode < newest.versionCode);
}

/** Install / upgrade (keeps the app's data: -r). */
export async function installSet(udid: string, set: ApkSet): Promise<void> {
  const args = set.files.length > 1 ? ['install-multiple', '-r', ...set.files] : ['install', '-r', set.files[0]];
  const out = await adb(args, udid, 600_000);
  if (!/Success/.test(out)) throw new Error(`adb ${args[0]} ${set.label}: ${out.trim().split('\n').pop()}`);
}

// ── Emulator fallback (V18, 2026-11-19): the Teamily APK keeps its native libraries inside the APK
// (extractNativeLibs=false) and React Native's SoLoader then looks for them under lib/x86_64 on an x86_64
// emulator with ARM translation → crash at start (libreactnative.so not found). A copy with
// extractNativeLibs=true, re-signed with the local debug key, runs. Only for emulators, only when the device
// config asks for it (`emulator.patchApk: true`): it is no longer the shipped artifact (other signature).

const RES_EXTRACT_NATIVE_LIBS = 0x010104ea;

/** Pure: the manifest with <application android:extractNativeLibs> set to true (undefined = already true / absent). */
export function patchExtractNativeLibs(src: Buffer): Buffer | undefined {
  const b = Buffer.from(src);
  let strings: string[] = [];
  let resIds: number[] = [];
  for (let p = b.readUInt16LE(2); p + 8 <= b.length; ) {
    const type = b.readUInt16LE(p);
    const size = b.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = stringPool(b, p);
    else if (type === 0x0180) resIds = Array.from({ length: (size - 8) / 4 }, (_, i) => b.readUInt32LE(p + 8 + i * 4));
    else if (type === 0x0102 && strings[b.readUInt32LE(p + 20)] === 'application') {
      const attrStart = b.readUInt16LE(p + 24);
      const attrSize = b.readUInt16LE(p + 26);
      const count = b.readUInt16LE(p + 28);
      for (let i = 0; i < count; i++) {
        const a = p + 16 + attrStart + i * attrSize;
        const ni = b.readUInt32LE(a + 4);
        if (strings[ni] !== 'extractNativeLibs' && resIds[ni] !== RES_EXTRACT_NATIVE_LIBS) continue;
        if (b.readUInt32LE(a + 16) !== 0) return undefined;
        b.writeUInt32LE(0xffffffff, a + 16);
        return b;
      }
      return undefined;
    }
    p += size;
  }
  return undefined;
}

/** Rewrite a zip: entries copied raw (compressed data untouched), `replace` entries deflated anew, `drop`
 *  entries left out (old signature files); the APK signing block is not carried over. */
export function rewriteZip(src: string, dest: string, replace: Record<string, Buffer>, drop: (name: string) => boolean): void {
  const fd = openSync(src, 'r');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  try {
    const size = statSync(src).size;
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    const cd = readAt(fd, tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nlen);
      const n = name.toString('utf8');
      const h = cd.subarray(p, p + 46);
      const local = cd.readUInt32LE(p + 42);
      p += 46 + nlen + elen + clen;
      if (drop(n)) continue;
      let method = h.readUInt16LE(10);
      let crc = h.readUInt32LE(16);
      let usize = h.readUInt32LE(24);
      let data: Buffer;
      if (replace[n]) {
        data = deflateRawSync(replace[n]);
        method = 8;
        crc = crc32(replace[n]);
        usize = replace[n].length;
      } else {
        const lh = readAt(fd, local, 30);
        data = readAt(fd, local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), h.readUInt32LE(20));
      }
      const L = Buffer.alloc(30);
      L.writeUInt32LE(0x04034b50, 0);
      L.writeUInt16LE(h.readUInt16LE(6), 4);
      L.writeUInt16LE(h.readUInt16LE(8) & ~8, 6);
      L.writeUInt16LE(method, 8);
      L.writeUInt32LE(h.readUInt32LE(12), 10);
      L.writeUInt32LE(crc, 14);
      L.writeUInt32LE(data.length, 18);
      L.writeUInt32LE(usize, 22);
      L.writeUInt16LE(nlen, 26);
      const C = Buffer.alloc(46);
      h.copy(C, 0, 0, 46);
      C.writeUInt16LE(h.readUInt16LE(8) & ~8, 8);
      C.writeUInt16LE(method, 10);
      C.writeUInt32LE(crc, 16);
      C.writeUInt32LE(data.length, 20);
      C.writeUInt32LE(usize, 24);
      C.writeUInt16LE(0, 30);
      C.writeUInt16LE(0, 32);
      C.writeUInt32LE(off, 42);
      parts.push(L, name, data);
      central.push(C, name);
      off += 30 + nlen + data.length;
    }
  } finally {
    closeSync(fd);
  }
  const cdBuf = Buffer.concat(central);
  const E = Buffer.alloc(22);
  E.writeUInt32LE(0x06054b50, 0);
  E.writeUInt16LE(central.length / 2, 8);
  E.writeUInt16LE(central.length / 2, 10);
  E.writeUInt32LE(cdBuf.length, 12);
  E.writeUInt32LE(off, 16);
  writeFileSync(dest, Buffer.concat([...parts, cdBuf, E]));
}

const buildTools = () => {
  const root = join(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (process.platform === 'win32' ? 'D:\Android\Sdk' : join(homedir(), 'Android', 'Sdk')), 'build-tools');
  const v = existsSync(root) ? readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : undefined;
  if (!v) throw new Error(`no Android build-tools under ${root} (sdkmanager "build-tools;34.0.0")`);
  return join(root, v);
};

/** keytool: JAVA_HOME, else the java.home of the java on PATH. */
async function keytool(): Promise<string> {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', exe))) return join(process.env.JAVA_HOME, 'bin', exe);
  const r = await run('java', ['-XshowSettings:properties', '-version'], { windowsHide: true }).catch((e) => e as { stderr?: string });
  const home = String(r.stderr ?? '').match(/java.home = (.+)/)?.[1]?.trim();
  if (home && existsSync(join(home, 'bin', exe))) return join(home, 'bin', exe);
  return 'keytool';
}

/** Local debug key (created once, like Android Studio's). */
export async function debugKeystore(): Promise<string> {
  const ks = process.env.AUTOTEST_DEBUG_KEYSTORE ?? join(homedir(), '.android', 'debug.keystore');
  if (!existsSync(ks)) {
    mkdirSync(dirname(ks), { recursive: true });
    await run(await keytool(), ['-genkeypair', '-v', '-keystore', ks, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'], { windowsHide: true });
  }
  return ks;
}

/** The set as an emulator can run it: every file re-signed with the debug key, the base with
 *  extractNativeLibs=true. Cached under apk/.emulator/<label>-<versionCode>/. */
export async function emulatorCopy(set: ApkSet, root = APK_ROOT): Promise<ApkSet> {
  const out = join(root, '.emulator', `${set.label.replace(/\.apk$/i, '')}-${set.versionCode}`);
  const files = set.files.map((f) => join(out, basename(f)));
  if (files.every((f) => existsSync(f))) return { ...set, files, label: `${set.label}（模拟器副本）` };
  mkdirSync(out, { recursive: true });
  const bt = buildTools();
  const exe = (n: string) => join(bt, process.platform === 'win32' ? (n === 'apksigner' ? 'apksigner.bat' : `${n}.exe`) : n);
  const ks = await debugKeystore();
  for (const [i, f] of set.files.entries()) {
    const tmp = `${files[i]}.tmp`;
    const m = i === 0 ? zipEntry(f, 'AndroidManifest.xml') : undefined;
    const patched = m ? patchExtractNativeLibs(m) : undefined;
    rewriteZip(f, `${tmp}.raw`, patched ? { 'AndroidManifest.xml': patched } : {}, (n) => /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$|^META-INF\/MANIFEST\.MF$/i.test(n));
    await run(exe('zipalign'), ['-p', '-f', '4', `${tmp}.raw`, tmp], { windowsHide: true, shell: process.platform === 'win32' });
    rmSync(`${tmp}.raw`, { force: true });
    await run(exe('apksigner'), ['sign', '--ks', ks, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', files[i], tmp], { windowsHide: true, shell: process.platform === 'win32', maxBuffer: 16 << 20 });
    rmSync(tmp, { force: true });
    rmSync(`${files[i]}.idsig`, { force: true });
  }
  return { ...set, files, label: `${set.label}（模拟器副本）` };
}
