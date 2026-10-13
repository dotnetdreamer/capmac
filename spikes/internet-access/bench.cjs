// Internet-access spike: CapMac's SSH connection carried over a peer-to-peer transport.
//
// Both transport ends run on this PC. The "door" end forwards to the paired Mac's sshd over
// the LAN, standing in for the background service that would run on the Mac. The SSH session
// is real (CapMac's key, the pinned host key), so the numbers include ssh2's own costs.
//
//   node bench.cjs tcp          plain SSH (today's baseline)
//   node bench.cjs webrtc       SSH over a WebRTC data channel (node-datachannel), direct path
//   node bench.cjs iroh         SSH over an iroh QUIC stream (@number0/iroh), direct path
//   node bench.cjs iroh-relay   the same, forced through n0's public relay
//
// Options: --mac <alias> (default: the default Mac), SPIKE_TCP=host:port (measure a tunnel that
// listens locally, e.g. dumbpipe; see dumbpipe.sh).
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Duplex } = require('node:stream');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Client } = require('ssh2');

const MiB = 1024 * 1024;
const mode = process.argv[2] ?? 'tcp';
const macArg = process.argv.includes('--mac') ? process.argv[process.argv.indexOf('--mac') + 1] : undefined;

const log = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const fingerprint = (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** The paired Mac from CapMac's own config (the same one the CLI and CapMac Studio use). */
function pairedMac() {
  const dir = process.env.CAPMAC_CONFIG_DIR ?? path.join(os.homedir(), '.capmac');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const host = config.hosts[macArg ?? config.defaultHost];
  if (!host) throw new Error(`No paired Mac "${macArg ?? config.defaultHost}" in ${dir}`);
  const [tunnelHost, tunnelPort] = (process.env.SPIKE_TCP ?? '').split(':');
  return {
    host: tunnelHost || host.lastAddress || host.host,
    port: Number(tunnelPort) || host.port,
    lanAddress: host.lastAddress || host.host,
    username: host.username,
    hostKey: host.hostKey,
    key: fs.readFileSync(host.identityFile ?? path.join(dir, 'id_ed25519')),
  };
}
const MAC = pairedMac();

// ---------------------------------------------------------------------------------------------
// WebRTC (node-datachannel)

/**
 * A WebRTC data channel as a Duplex for ssh2's `sock`. Writes are split to the channel's message
 * size, and held back while more than 1 MB waits to be sent: SSH must never lose a byte.
 * (node-datachannel's own DataChannelStream drops messages when its buffer fills: not for SSH.)
 */
function dataChannelDuplex(dc) {
  const HIGH = 1024 * 1024;
  const max = Math.min(64 * 1024, dc.maxMessageSize() || 64 * 1024);
  let waiting = null;
  dc.setBufferedAmountLowThreshold(256 * 1024);
  dc.onBufferedAmountLow(() => {
    const cb = waiting;
    waiting = null;
    cb?.();
  });
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      for (let off = 0; off < chunk.length; off += max) dc.sendMessageBinary(chunk.subarray(off, off + max));
      if (dc.bufferedAmount() > HIGH) waiting = cb;
      else cb();
    },
    final(cb) {
      cb();
    },
  });
  dc.onMessage((msg) => stream.push(Buffer.isBuffer(msg) ? msg : Buffer.from(msg)));
  dc.onClosed(() => stream.push(null));
  return stream;
}

async function openWebRtc(timing, t0) {
  const ndc = require('node-datachannel');
  const config = { iceServers: ['stun:stun.cloudflare.com:3478'] };
  const door = new ndc.PeerConnection('door', config);
  const dialer = new ndc.PeerConnection('dialer', config);
  // Signaling, in-process: each side's description and candidates go straight to the other.
  dialer.onLocalDescription((sdp, type) => door.setRemoteDescription(sdp, type));
  dialer.onLocalCandidate((c, mid) => door.addRemoteCandidate(c, mid));
  door.onLocalDescription((sdp, type) => dialer.setRemoteDescription(sdp, type));
  door.onLocalCandidate((c, mid) => dialer.addRemoteCandidate(c, mid));
  door.onDataChannel((channel) => bridgeToSshd(dataChannelDuplex(channel)));
  const dc = dialer.createDataChannel('ssh');
  await new Promise((resolve) => dc.onOpen(resolve));
  timing.dataChannelOpenMs = ms(t0);
  return {
    sock: dataChannelDuplex(dc),
    route: () => {
      const pair = dialer.getSelectedCandidatePair();
      return pair ? [`${pair.local.type} -> ${pair.remote.type} over ${pair.local.transportType}, rtt ${dialer.rtt()} ms`] : [];
    },
    close: async () => {
      dialer.close();
      door.close();
      ndc.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// iroh (@number0/iroh). Its package.json `main` names a file the package lacks: require index.js.

const ALPN = Array.from(Buffer.from('capmac/ssh/0'));

/** An iroh bi-stream as a Duplex. The binding passes bytes as plain JS number arrays (slow). */
function biStreamDuplex(bi) {
  let pumping = false;
  const stream = new Duplex({
    read() {
      if (pumping) return;
      pumping = true;
      (async () => {
        try {
          for (;;) {
            const bytes = await bi.recv.read(64 * 1024);
            if (bytes.length === 0) {
              stream.push(null);
              return;
            }
            if (!stream.push(Buffer.from(bytes))) {
              pumping = false;
              return;
            }
          }
        } catch (err) {
          stream.destroy(err);
        }
      })();
    },
    write(chunk, _encoding, cb) {
      bi.send.writeAll(Array.from(chunk)).then(() => cb(), cb);
    },
    final(cb) {
      bi.send.finish().then(() => cb(), cb);
    },
  });
  return stream;
}

/** The interface this PC reaches the Mac on (same /24), to keep the relay test off the LAN. */
function lanInterface() {
  const prefix = MAC.lanAddress.split('.').slice(0, 3).join('.') + '.';
  const list = Object.values(os.networkInterfaces()).find((l) => l?.some((i) => i.family === 'IPv4' && i.address.startsWith(prefix)));
  if (!list) throw new Error(`No interface on ${prefix}0/24: is this PC on the Mac's network?`);
  return {
    v4: list.find((i) => i.family === 'IPv4').address,
    v6: list.find((i) => i.family === 'IPv6' && !i.address.startsWith('fe80'))?.address,
  };
}

async function openIroh(timing, t0, relayOnly) {
  const iroh = require('@number0/iroh/index.js');
  const dialerBuilder = iroh.Endpoint.builder();
  iroh.presetN0(dialerBuilder);
  const doorBuilder = iroh.Endpoint.builder();
  iroh.presetN0(doorBuilder);
  doorBuilder.alpns([ALPN]);
  if (relayOnly) {
    // No address family in common: the door on loopback, the dialer on the LAN interface only.
    // (`bindAddr` replaces the default socket of that address family.)
    const lan = lanInterface();
    dialerBuilder.bindAddr(`${lan.v4}:0`);
    if (lan.v6) dialerBuilder.bindAddr(`[${lan.v6}]:0`);
    doorBuilder.bindAddr('127.0.0.1:0');
    doorBuilder.bindAddr('[::1]:0');
  }
  const dialer = await dialerBuilder.bind();
  const door = await doorBuilder.bind();
  void (async () => {
    for (;;) {
      const incoming = await door.acceptNext();
      if (!incoming) return;
      void (async () => {
        const conn = await (await incoming.accept()).connect();
        // Only the paired PC gets through to sshd.
        if (!conn.remoteId().equals(dialer.id())) {
          conn.close(1n, Array.from(Buffer.from('not paired')));
          return;
        }
        for (;;) {
          let bi;
          try {
            bi = await conn.acceptBi();
          } catch {
            return;
          }
          bridgeToSshd(biStreamDuplex(bi));
        }
      })().catch((err) => log('door:', err.message));
    }
  })();
  await Promise.all([door.online(), dialer.online()]);
  timing.endpointsOnlineMs = ms(t0);
  const addr = door.addr();
  // Dialed the way a PC elsewhere would know the Mac: its id and home relay (no addresses).
  const target = relayOnly ? new iroh.EndpointAddr(addr.id(), addr.relayUrl(), []) : addr;
  const t1 = process.hrtime.bigint();
  const conn = await dialer.connect(target, ALPN);
  timing.irohConnectMs = ms(t1);
  return {
    sock: biStreamDuplex(await conn.openBi()),
    route: () => conn.paths().map((p) => `${p.isSelected ? '*' : ' '}${p.isRelay ? 'relay' : 'ip'} ${p.isRelay ? p.remoteAddr : ''} rtt ${p.rttMs} ms`.replace(/\s+/g, ' ')),
    close: async () => {
      conn.close(0n, []);
      await Promise.allSettled([dialer.close(), door.close()]);
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** The door's job: one stream from the PC becomes one TCP connection to the Mac's sshd. */
function bridgeToSshd(stream) {
  const tcp = net.connect(MAC.port, MAC.lanAddress);
  tcp.setNoDelay(true);
  tcp.pipe(stream).pipe(tcp);
  tcp.on('error', () => stream.destroy());
  stream.on('error', () => tcp.destroy());
}

function ssh(sock) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client)).on('error', reject);
    client.connect({
      ...(sock ? { sock } : { host: MAC.host, port: MAC.port }),
      username: MAC.username,
      privateKey: MAC.key,
      readyTimeout: 30_000,
      hostVerifier: (key) => fingerprint(key) === MAC.hostKey,
    });
  });
}

const exec = (client, command) => new Promise((resolve, reject) => client.exec(command, (err, ch) => (err ? reject(err) : resolve(ch))));

/** Round trips of one byte through `cat` on the Mac: the latency a tap or a keystroke sees. */
async function echoes(client, n = 40) {
  const ch = await exec(client, 'cat');
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    ch.write('x');
    await once(ch, 'data');
    out.push(ms(t0));
  }
  ch.end();
  return out;
}

async function upload(client, bytes) {
  const ch = await exec(client, 'cat > /dev/null');
  // An exec channel only emits 'close' once its output has been read.
  ch.resume();
  ch.stderr.resume();
  const chunk = Buffer.alloc(32 * 1024, 7);
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let sent = 0; sent < bytes; sent += chunk.length) if (!ch.write(chunk)) await once(ch, 'drain');
  ch.end();
  await once(ch, 'close');
  return rate(bytes, t0, cpu0);
}

async function download(client, bytes) {
  const ch = await exec(client, `head -c ${bytes} /dev/zero`);
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  let got = 0;
  ch.on('data', (d) => (got += d.length));
  await once(ch, 'close');
  return rate(got, t0, cpu0);
}

function rate(bytes, t0, cpu0) {
  const secs = ms(t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  return { mbps: Math.round((bytes * 8) / secs / 1e6), cpuPct: Math.round(((cpu.user + cpu.system) / 1e6 / secs) * 100) };
}

async function main() {
  const t0 = process.hrtime.bigint();
  const timing = {};
  const transport =
    mode === 'webrtc' ? await openWebRtc(timing, t0)
    : mode === 'iroh' ? await openIroh(timing, t0, false)
    : mode === 'iroh-relay' ? await openIroh(timing, t0, true)
    : mode === 'tcp' ? null
    : (() => { throw new Error(`Unknown mode "${mode}"`); })();
  const t2 = process.hrtime.bigint();
  const client = await ssh(transport?.sock);
  timing.sshHandshakeMs = ms(t2);
  timing.readyMs = ms(t0);
  log('SSH ready');

  const first = await echoes(client);
  await new Promise((resolve) => setTimeout(resolve, 1500)); // let a relayed path move to a direct one
  const settled = await echoes(client);
  log('echo done');
  const up = await upload(client, 32 * MiB);
  log('upload done');
  const down = await download(client, 32 * MiB);
  console.log(JSON.stringify({
    mode,
    timing: Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])),
    echoMs: { firstP50: +pct(first, 0.5).toFixed(1), p50: +pct(settled, 0.5).toFixed(1), p95: +pct(settled, 0.95).toFixed(1) },
    upload: up,
    download: down,
    route: transport?.route() ?? ['tcp'],
  }, null, 1));
  client.end();
  await transport?.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
