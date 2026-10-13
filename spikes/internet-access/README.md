# Internet-access spike

CapMac does everything over one SSH connection to the Mac, so reaching the Mac over the
internet only needs a byte stream to its sshd. This spike carries CapMac's real SSH session
(CapMac's key, the pinned host key) over two peer-to-peer transports and compares them with
plain SSH:

- **WebRTC** data channels, with [node-datachannel](https://github.com/murat-dogan/node-datachannel) 0.33.4 (libdatachannel);
- **iroh** 1.0 QUIC streams, with the Node binding [@number0/iroh](https://docs.iroh.computer/languages/javascript) 1.1.0, and n0's native tool [dumbpipe](https://github.com/n0-computer/dumbpipe) v0.39.0.

The plan built on it is in [docs/next-session-internet-access.md](../../docs/next-session-internet-access.md).

| File | What it is |
|---|---|
| `bench.cjs` | Opens the transport (both ends on this PC; the "door" end forwards to the paired Mac's sshd over the LAN), runs SSH through it, and measures connect time, 1-byte echo round trips through `cat`, and 32 MiB up and down. |
| `dumbpipe.sh` | Runs both ends of dumbpipe on this PC and `bench.cjs` through it, with the dumbpipe processes' CPU time. |

## Run it

With a Mac paired (the default Mac in `%USERPROFILE%\.capmac\config.json`) and this PC on the Mac's network:

```sh
cd spikes/internet-access
npm install --no-package-lock      # not part of the workspace
node bench.cjs tcp                 # plain SSH, today's baseline
node bench.cjs webrtc              # WebRTC data channel, direct path
node bench.cjs iroh                # iroh, direct path
node bench.cjs iroh-relay          # iroh, forced through n0's public relay
./dumbpipe.sh path/to/dumbpipe.exe direct   # or relay
```

`--mac <alias>` picks another paired Mac.

## Results (2026-10-13)

From this PC over Wi-Fi to an M1 Pro MacBook Pro. The CPU column is this Node process, both
transport ends included (half of it per end, roughly).

| Transport | SSH ready | Echo p50 (p95) | Up / down | CPU |
|---|---|---|---|---|
| Plain SSH (today) | 0.2–0.3 s | 7–9 ms (36–45) | 77–115 / 83–93 Mbps | 2–5% |
| WebRTC, node-datachannel, direct | 0.21–0.24 s (channel open in 29–58 ms) | 7–12 ms (13–132) | 130 / 81–83 Mbps | 97–118% up, 72% down |
| iroh, @number0/iroh, direct | 0.52–0.64 s (endpoints online in 0.35 s) | 8–10 ms (21–22) | 36–39 / 30–31 Mbps | 100–115% |
| iroh, dumbpipe, direct | 0.23 s | 11 ms (30) | 113 / 71 Mbps | dumbpipe ~15% of a core, Node ~6% |
| iroh through n0's public relay (Frankfurt) | 0.8–1.2 s | 56–65 ms (104–133) | 8–9 / 9 Mbps, throttled | low |

- **A direct path costs nothing you can feel.** Wi-Fi jitter (the p95 column) is larger than any difference between transports.
- **The iroh Node binding is the slow one.** It passes bytes as plain JavaScript number arrays, so a full core moves about 35 Mbps. It also has no Intel Mac build, and its `package.json` `main` names a missing file (`require('@number0/iroh/index.js')` works).
- **n0's public relays are for development only**, as their docs say. They throttle to 8–9 Mbps and queue up to ~800 ms under bulk load.
- **Not measured here:** a path between two real home routers (put the PC on a phone hotspot), and WebRTC through TURN (needs TURN credentials; `iceTransportPolicy: 'relay'` forces it).

## Notes

- `ssh2` takes any Duplex as `sock`, so the SSH session, its host key check and every channel run unchanged over a transport stream.
- Use your own Duplex around a node-datachannel `DataChannel`, with send-side backpressure (`bufferedAmount`, `onBufferedAmountLow`). node-datachannel's `DataChannelStream` drops messages when its buffer fills, which would corrupt SSH.
- node-datachannel loads its binary from `@node-datachannel/<platform>` (about 7 MB each), so bundlers must leave it external. Call `cleanup()` or the process does not exit.
- An `ssh2` exec channel emits `close` only after its output has been read (`resume()` it).
- To force iroh through its relay on one machine, bind the two ends to addresses with no family in common (`bindAddr` replaces that family's default socket): the door on `127.0.0.1` and `[::1]`, the dialer on the LAN interface. dumbpipe has `--ipv4-addr` and `--ipv6-addr` for the same trick.
