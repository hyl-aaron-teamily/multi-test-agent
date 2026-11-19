// A TCP stream to a port on the device through the adb server itself (W3-5 E2 ④, contract K9, V17): the smart
// socket protocol — `host:transport:<serial>` then `tcp:<port>` — instead of `adb forward`. A forward listens
// on the adb server's loopback, which a container cannot reach; this needs only the adb server's address, so it
// works the same on this computer and in the platform container, for the phone and the emulator alike, and leaves
// no forwards behind.
//   ADB_SERVER_SOCKET=tcp:<host>:<port>   (what adb itself reads; default tcp:127.0.0.1:5037)
import { connect, type Socket } from 'node:net';

/** Pure: host / port of the adb server from ADB_SERVER_SOCKET (`tcp:host:port` or `tcp:port`). */
export function adbServerAddress(v = process.env.ADB_SERVER_SOCKET): { host: string; port: number } {
  const m = (v ?? '').match(/^tcp:(?:([^:]+):)?(\d+)$/);
  return m ? { host: m[1] ?? '127.0.0.1', port: Number(m[2]) } : { host: '127.0.0.1', port: Number(process.env.ANDROID_ADB_SERVER_PORT ?? 5037) };
}

/** Pure: one smart-socket request (4 hex digits of length, then the text). */
export const adbRequest = (s: string) => `${Buffer.byteLength(s).toString(16).padStart(4, '0')}${s}`;

function readStatus(sock: Socket, timeoutMs: number): Promise<void> {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => done(new Error('adb server: no answer')), timeoutMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const status = buf.subarray(0, 4).toString();
      if (status === 'OKAY') {
        const rest = buf.subarray(4);
        done();
        if (rest.length) sock.unshift(rest);
        return;
      }
      if (status === 'FAIL') {
        if (buf.length < 8) return;
        const n = parseInt(buf.subarray(4, 8).toString(), 16);
        if (buf.length < 8 + n) return;
        done(new Error(`adb server: ${buf.subarray(8, 8 + n).toString()}`));
        return;
      }
      done(new Error(`adb server: unexpected "${status}"`));
    };
    const onErr = (e: Error) => done(e);
    const done = (e?: Error) => {
      clearTimeout(t);
      sock.off('data', onData);
      sock.off('error', onErr);
      if (e) rej(e);
      else res();
    };
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

/** Open a stream to `tcp:<port>` on the device. */
export async function deviceSocket(serial: string, port: number, timeoutMs = 5000): Promise<Socket> {
  const a = adbServerAddress();
  const sock = connect(a.port, a.host);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`adb server ${a.host}:${a.port}: connect timeout`)), timeoutMs);
    sock.once('connect', () => (clearTimeout(t), res()));
    sock.once('error', (e) => (clearTimeout(t), rej(e)));
  });
  try {
    sock.write(adbRequest(`host:transport:${serial}`));
    await readStatus(sock, timeoutMs);
    sock.write(adbRequest(`tcp:${port}`));
    await readStatus(sock, timeoutMs);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

/** Pure: status and body of a raw HTTP/1.x response. */
export function parseHttp(raw: Buffer): { status: number; body: string } {
  const i = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, i < 0 ? raw.length : i).toString('latin1');
  const status = Number(head.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? 0);
  let body = i < 0 ? Buffer.alloc(0) : raw.subarray(i + 4);
  if (/^transfer-encoding:\s*chunked/im.test(head)) {
    const parts: Buffer[] = [];
    let p = 0;
    for (;;) {
      const e = body.indexOf('\r\n', p);
      if (e < 0) break;
      const n = parseInt(body.subarray(p, e).toString(), 16);
      if (!n) break;
      parts.push(body.subarray(e + 2, e + 2 + n));
      p = e + 2 + n + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status, body: body.toString('utf8') };
}

/** GET a path from an HTTP service on the device (the tree service), over the adb server. */
export async function deviceHttpGet(serial: string, port: number, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const sock = await deviceSocket(serial, port, Math.min(timeoutMs, 5000));
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    const t = setTimeout(() => (sock.destroy(), rej(new Error(`device http ${path}: timeout ${timeoutMs} ms`))), timeoutMs);
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', (e) => (clearTimeout(t), rej(e)));
    sock.on('close', () => {
      clearTimeout(t);
      const r = parseHttp(Buffer.concat(chunks));
      if (!r.status) rej(new Error(`device http ${path}: no response`));
      else res(r);
    });
    sock.write(`GET ${path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

/** The adb server's protocol version (`host:version`, hex): a client of another version restarts the server. */
export async function adbServerVersion(timeoutMs = 3000): Promise<number | undefined> {
  const a = adbServerAddress();
  return new Promise((res) => {
    const sock = connect(a.port, a.host);
    let buf = '';
    const t = setTimeout(() => (sock.destroy(), res(undefined)), timeoutMs);
    sock.on('connect', () => sock.write(adbRequest('host:version')));
    sock.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.startsWith('OKAY') && buf.length >= 12) {
        clearTimeout(t);
        sock.destroy();
        res(parseInt(buf.slice(8, 12), 16));
      }
    });
    sock.on('error', () => (clearTimeout(t), res(undefined)));
  });
}

/** Pure: the protocol version of an `adb version` text ("Android Debug Bridge version 1.0.41" → 41). */
export const adbClientProtocol = (versionText: string) => Number(versionText.match(/version 1\.0\.(\d+)/)?.[1]) || undefined;
