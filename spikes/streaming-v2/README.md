# Streaming v2 spike

The iOS simulator's screen as H.264, from the simulator's framebuffer on the Mac
to WebCodecs on Windows. Results and the recommendation are in
[docs/desktop-design.md § 5](../../docs/desktop-design.md#5-simulator-streaming-v2).

| File | What it is |
|---|---|
| `simstream.m` | The Mac helper: CoreSimulator `SimScreen` frame callbacks → framebuffer `IOSurface` → VideoToolbox H.264 → length-prefixed frames on stdout. Keyframe, clock-ping and quit commands on stdin. |
| `bench.ts` | Builds the helper on the paired Mac and measures frame rate, bandwidth and latency, for the helper (`v2`) and for today's JPEG stream (`v1`). Uses capmac's own SSH connection. |
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
