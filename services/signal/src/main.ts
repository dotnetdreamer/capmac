/**
 * capmac-signal: runs CapMac's signaling server (and its STUN server) with
 * settings from the environment. See deploy/README.md.
 */
import { readFileSync } from 'node:fs';
import { SignalServer, type LogLevel } from './server.js';
import { startStun } from './stun.js';

declare const __CAPMAC_SIGNAL_VERSION__: string | undefined;
const VERSION = typeof __CAPMAC_SIGNAL_VERSION__ === 'string' ? __CAPMAC_SIGNAL_VERSION__ : 'dev';

const env = process.env;
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const minLevel = Math.max(0, LEVELS.indexOf((env.LOG_LEVEL ?? 'info') as LogLevel));
const log = (level: LogLevel, message: string) => {
  if (LEVELS.indexOf(level) >= minLevel) console.log(`${new Date().toISOString()} ${level.padEnd(5)} ${message}`);
};

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};

function fail(message: string): never {
  log('error', message);
  process.exit(1);
}

const port = number(env.PORT, 8787);
const stunPort = number(env.STUN_PORT, 3478);
const publicHost = env.PUBLIC_HOST?.trim();
const stunUrls = env.STUN_URLS !== undefined
  ? list(env.STUN_URLS)
  : [...(publicHost && stunPort ? [`stun:${publicHost}:${stunPort}`] : []), 'stun:stun.l.google.com:19302'];
const turnUrls = list(env.TURN_URLS);
if (turnUrls.length && !env.TURN_SECRET) fail('TURN_URLS is set but TURN_SECRET is not (it must match coturn\'s static-auth-secret).');

let tls: { cert: Buffer; key: Buffer } | undefined;
if (env.TLS_CERT_FILE || env.TLS_KEY_FILE) {
  if (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE) fail('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither (and put a TLS proxy in front).');
  try {
    tls = { cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) };
  } catch (err) {
    fail(`Could not read the TLS certificate or key: ${(err as Error).message}`);
  }
}

const server = new SignalServer({
  port,
  host: env.HOST || undefined,
  tls,
  stunUrls,
  turn: turnUrls.length ? { urls: turnUrls, secret: env.TURN_SECRET!, ttlSeconds: number(env.TURN_TTL, 86_400) } : undefined,
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
  version: VERSION,
  log,
});

const listening = await server.start().catch((err: Error) => fail(`Could not listen on port ${port}: ${err.message}`));
log('info', `capmac-signal ${VERSION} listening on ${tls ? 'wss' : 'ws'}://${env.HOST || '0.0.0.0'}:${listening}${tls ? '' : ' (put a TLS proxy in front, or set TLS_CERT_FILE and TLS_KEY_FILE)'}`);
log('info', `ICE servers for clients: ${[...stunUrls, ...turnUrls].join(', ') || 'none'}`);

const stun = stunPort
  ? await startStun(stunPort).then(
      (s) => {
        log('info', `STUN on UDP ${s.ports.join(' and ')}`);
        return s;
      },
      (err: Error) => {
        log('warn', `${err.message} Peer-to-peer connections then rely on the other STUN servers.`);
        return null;
      },
    )
  : null;

const report = setInterval(() => {
  const s = server.stats();
  log('info', `${s.macsOnline} Macs online, ${s.pcs} PCs, ${s.pipes} relays, ${(s.relayedBytes / 1e6).toFixed(1)} MB relayed`);
}, 60 * 60_000);
report.unref();

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log('info', `${signal}: shutting down`);
  await Promise.allSettled([server.close(), stun?.close()]);
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
