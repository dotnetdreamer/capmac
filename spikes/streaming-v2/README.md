# Streaming v2 spike

The iOS simulator's screen as H.264, from the simulator's framebuffer on the Mac
to WebCodecs on Windows. Results and the recommendation are in
[docs/desktop-design.md § 5](../../docs/desktop-design.md#5-simulator-streaming-v2).

| File | What it is |
|---|---|
| `simstream.m` | The Mac helper: CoreSimulator `SimScreen` frame callbacks → framebuffer `IOSurface` → VideoToolbox H.264 → length-prefixed frames on stdout. Keyframe, clock-ping and quit commands on stdin. |
| `bench.ts` | Builds the helper on the paired Mac and measures frame rate, bandwidth and latency, for the helper (`v2`) and for today's JPEG stream (`v1`). Uses CapMac's own SSH connection. |
| `decode-test.mjs` | Decodes a recorded stream with WebCodecs (hardware and software) inside a running `npm run desktop:dev` app. |

## Run it

From the repository root, with a Mac paired and a simulator booted:

```sh
npm run build    # the CLI's agent bundle, used by the v1 measurement
npx esbuild spikes/streaming-v2/bench.ts --bundle --platform=node --format=cjs --external:cpu-features --external:*.node --outfile=spikes/streaming-v2/out/bench.cjs

node spikes/streaming-v2/out/bench.cjs build                  # compiles ~/.capmac/spike/simstream on the Mac
node spikes/streaming-v2/out/bench.cjs v2 <simulator UDID> 10 # 10 seconds of H.264
CAPMAC_AGENT_PATH=packages/cli/dist/agent.mjs node spikes/streaming-v2/out/bench.cjs v1 <simulator UDID> 10

DUMP=stream.bin node spikes/streaming-v2/out/bench.cjs v2 <simulator UDID> 10
node spikes/streaming-v2/decode-test.mjs stream.bin           # needs npm run desktop:dev
```

The screen only produces frames while something on it changes. To measure, run
something that animates (the spike used a `requestAnimationFrame` loop in the
sample app, through live reload).

Helper flags: `--max-size` (longest side, default 1400), `--fps` (default 60),
`--bitrate` (default 6 Mbps), `--low-latency 1` (VideoToolbox's low-latency rate
control: drops frames at 6 Mbps under full-screen motion), `--debug 1` (once a
second: frames from the simulator, frames encoded and dropped, timings).

Remove the helper from the Mac with `rm -rf ~/.capmac/spike`.

## Exploring the private API

Xcode changes these interfaces between versions, and the symbol tables are the
only documentation. Two tools in `tools/`:

| File | What it does |
|---|---|
| `mac.ts` | Runs a script on the paired Mac (`sh '<command>'`, `sh -f <file>`) or copies a file to it (`put <local> <remote>`, relative to the Mac user's home), over CapMac's own SSH connection. Bundle it like `bench.ts`. |
| `introspect.m` | Lists the display and input classes and protocols in the installed Xcode, dumps a class (`./introspect SimDeviceIOClient`), a protocol with its block signatures (`./introspect @SimScreen`), or every class in a framework (`./introspect --image SimulatorKit`). |

```sh
node spikes/streaming-v2/out/mac.cjs put spikes/streaming-v2/tools/introspect.m .capmac/spike/introspect.m
node spikes/streaming-v2/out/mac.cjs sh 'cd ~/.capmac/spike && xcrun clang -fobjc-arc -framework Foundation introspect.m -o introspect && ./introspect @SimScreen'
node spikes/streaming-v2/out/mac.cjs sh 'nm -gU /Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit | grep Indigo'
```

The second command is how the Xcode 26 `SimScreen` frame callbacks were found;
the third lists the Indigo HID message builders that input will need.
